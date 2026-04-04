# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

npm workspaces monorepo with two OpenTelemetry WebSocket instrumentation packages:

- **`packages/otel-ws`** (`@marz32one/otel-ws`) — native Node.js `ws` library wrapper
- **`packages/otel-rxjs-ws`** (`@marz32one/otel-rxjs-ws`) — drop-in replacement for `rxjs/webSocket`

Both packages share the same wire protocol and architectural patterns. They use `trace.getTracerProvider()` from `@opentelemetry/api` — they do NOT register a TracerProvider; that is the consuming application's responsibility.

## Commands

```bash
make install       # npm install (all workspace deps)
make build         # Build all packages (TypeScript → dist/)
make test          # Run Jest across all packages
make lint          # Type-check (tsc --noEmit) + ESLint (typescript-eslint)
make clean         # Remove dist/ artifacts
make publish-dry   # Dry-run npm pack for otel-rxjs-ws
```

Per-package (run inside `packages/otel-ws/` or `packages/otel-rxjs-ws/`):

```bash
npm run build
npm run test
npm run lint
# Run a single test file:
NODE_OPTIONS=--experimental-vm-modules npx jest test/index.test.ts
```

## Wire Protocol

## Test Prerequisites

`packages/otel-nats` tests spin up a real `nats-server` process. It must be in `PATH`:

```bash
brew install nats-server
```

To skip spawning and point tests at an existing server:

```bash
NATS_URL=nats://127.0.0.1:4222 npm run test      # TCP tests
NATS_WS_URL=ws://127.0.0.1:9222 npm run test     # WebSocket tests (requires NATS_URL too)
```

## CI

`.github/workflows/ci.yml` runs on push/PR to `main`. Parallel jobs (each on Node 18 and 20): **lint** (`make lint`: `tsc --noEmit` + ESLint), **test** (`make test`), **build** (`make build`). Optional: `npm run lint:typecheck` or `npm run lint:eslint` to run one checker only.

## Wire Protocol (otel-ws / otel-rxjs-ws)

- **Client offer**: first subprotocol token is always `otel-ws`, followed by optional bare user subprotocols `P1, P2, …` (no `otel-ws+P` encoding). `json` is **not** auto-inserted.
- **`OtelWebSocket.Server`**: if the client offer’s first token is `otel-ws`, the wrapper strips it and calls `userHandleProtocols` on the rest; the HTTP response uses the **bare** selected subprotocol `S` from that rest list (RFC-compliant). If the rest is empty, the server answers `otel-ws` and does not call the user handler.
- **Envelope** (`isOtelActive`): `OtelWebSocket` enables it on every successful `open`. `OtelWebSocket.Server` enables it per socket when the **first** token of `Sec-WebSocket-Protocol` on the upgrade request is `otel-ws` (even if the negotiated subprotocol is a bare `Pi`). Server-side activation reads the negotiated subprotocol via `_protocol` when present, otherwise the public `protocol` getter.
- **User-facing `protocol`**: strip an `otel-ws+` prefix (8 chars) for display; map negotiated `otel-ws` alone to `''`.
- **RxJS**: `WebSocketSubjectConfig` includes optional `prependOtelSubprotocol` (default `true`). Set `false` to connect without offering `otel-ws` (e.g. native server that only negotiates `json`).

Envelope format when active:

```json
{ "header": { "traceparent": "...", "tracestate": "..." }, "data": <user payload> }
```

When inactive: payloads pass through unchanged (spans may still be created).

## Architecture

### otel-ws

- Patches `ws.send()` to wrap outgoing payloads in the envelope (PRODUCER span)
- Patches `ws._sender.sendFrame()` at the binary frame level to inject trace context into JSON frames (handles already-serialized data)
- Uses Symbols to store internal state on `WebSocket` instances to avoid property collision
- Maintains a WeakMap of wrapped message handlers to support `ws.off(event, handler)`
- `SKIP_FRAME_INJECT_KEY` on the OTel context prevents double-wrapping between the two patch layers

### otel-rxjs-ws

- Extends RxJS `WebSocketSubject` directly for API compatibility
- Maintains context queues (`_pendingSendContexts`, `_pendingReceiveCtxs`) because RxJS may buffer messages before the socket is open — context is captured at `next()` time and applied during serialization
- Overrides `_subscribe()` to inject the extracted receive context into the observable pipeline before delivering to subscribers

### Span Attributes

Both packages create spans named `websocket.send` (PRODUCER) and `websocket.receive` (CONSUMER) with:

```
messaging.system = 'websocket'
messaging.operation = 'send' | 'receive'
```

## Test Patterns

Both test suites use `InMemorySpanExporter` + `NodeTracerProvider` with `W3CTraceContextPropagator`. Tests spin up a real `ws` server on a local port.

```typescript
// Standard OTel test setup used across both packages
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register({
  propagator: new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }),
});
```

## Key Files

- `packages/otel-ws/src/index.ts` — main wrapper; `OtelWebSocket` class + `instrumentSocket()` + `OtelWebSocket.Server`
- `packages/otel-ws/src/wire-message.ts` — `buildEnvelope()` / `deserializeMessage()`
- `packages/otel-rxjs-ws/src/subject.ts` — `InstrumentedWebSocketSubject` class
- `packages/otel-rxjs-ws/src/wire-message.ts` — same interface as otel-ws (shared pattern, not shared code)
- `tsconfig.base.json` — shared TypeScript config (ES2020, NodeNext, strict)

## Dependency Notes

- `otel-ws` targets `ws` 5.1.1 (pinned, not a range) — binary frame patching is sensitive to ws internals
- `otel-rxjs-ws` dev deps use `@opentelemetry/sdk-trace-node ^2.6.0` (newer major than otel-ws dev deps at `^1.30.1`) — this is intentional
- Jest requires `NODE_OPTIONS=--experimental-vm-modules` for ESM support
