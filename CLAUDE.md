# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

npm workspaces monorepo with three OpenTelemetry instrumentation packages:

- **`packages/otel-ws`** (`@marz32one/otel-ws`) — native Node.js `ws` library wrapper
- **`packages/otel-rxjs-ws`** (`@marz32one/otel-rxjs-ws`) — drop-in replacement for `rxjs/webSocket`
- **`packages/otel-nats`** (`@marz32one/otel-nats`) — NATS client instrumentation (Core + JetStream)

All packages use `trace.getTracerProvider()` / `propagation` from `@opentelemetry/api` — they do NOT register a TracerProvider; that is the consuming application's responsibility.

## Commands

```bash
make install       # npm install (all workspace deps)
make build         # Build all packages (TypeScript → dist/)
make test          # Run Jest across all packages
make lint          # Type-check (tsc --noEmit) + ESLint (typescript-eslint, --max-warnings 0)
make clean         # Remove dist/ artifacts
make publish-dry   # Dry-run npm pack for otel-rxjs-ws
```

`make lint` runs two passes: `tsc --noEmit` per workspace, then `eslint` at repo root using `eslint.config.mjs` (flat config, `typescript-eslint` recommended type-checked rules, `--max-warnings 0`).

Per-package (run inside the package directory):

```bash
npm run build
npm run test
npm run lint
# Run a single test file:
NODE_OPTIONS=--experimental-vm-modules npx jest test/core.test.ts
```

## Test Prerequisites

Unit tests (`make test`) use mocked connections — no external process required.

Integration tests (`make test-integration`) use testcontainers to spin up a NATS server in Docker. Docker must be running:

```bash
make test-integration   # runs packages/otel-nats integration suite via Docker
```

## CI

`.github/workflows/ci.yml` runs on push/PR to `main` for any change in `packages/**/*.ts|js|cjs|mjs`, `package*.json`, `eslint.config.*`, `tsconfig*.json`, `Makefile`, or workflow files. Tested on Node 20 and 22. Steps: `install → lint → test → build`.

Integration tests run in a separate job (`test-integration`) using Docker via testcontainers — requires Docker to be available.

## Wire Protocol (otel-ws / otel-rxjs-ws)

### Client offer

| Scenario | otel-ws (`OtelWebSocket`) | otel-rxjs-ws (`webSocket()`) |
|---|---|---|
| No user protocols | `[]` — plain handshake, passthrough mode | `[‘otel-ws’]` — default trace-enabled offer |
| Explicit empty protocol (`’’` / `[]`) | `[]` — passthrough mode | `[]` — passthrough mode (no throw) |
| With user protocols (`’json’`) | `[‘otel-ws+json’, ‘json’]` | `[‘otel-ws+json’, ‘json’]` |

**Passthrough mode** (no otel-ws offer / server does not return otel-ws prefix): connection succeeds, payloads pass through unchanged, but `websocket.send` and `websocket.receive` spans are **still created**.

- **`OtelWebSocket.Server`**: if the client offer’s first token is bare `otel-ws`, the wrapper filters out all `otel-ws` and `otel-ws+*` tokens, then calls `userHandleProtocols` with the remaining bare user protocols. The server responds with `otel-ws+<selected>` to signal otel-ws awareness. If no user protocols remain after filtering (e.g. client offered only `otel-ws`), the ws package rejects the handshake naturally — no explicit guard needed. If the client offers **no** subprotocols at all, the server accepts the connection in passthrough mode (no envelope, spans still created).
- **Envelope** (`isOtelActive`): `OtelWebSocket` enables it when the negotiated wire protocol is bare `otel-ws` or starts with `otel-ws+` (i.e. when the server acknowledged otel-ws awareness). `OtelWebSocket.Server` enables it per socket when the **first** token of `Sec-WebSocket-Protocol` on the upgrade request is `otel-ws`.
- **User-facing `protocol`**: strip an `otel-ws+` prefix (8 chars) for display; map negotiated `otel-ws` alone to `’’`.
- **RxJS `prependOtelSubprotocol`**: set `false` to connect without offering `otel-ws` at all (e.g. legacy server that only negotiates `json`). When protocols are explicitly specified as empty, passthrough mode is used automatically (no `prependOtelSubprotocol: false` needed).
- **`patchNativeSendFrame` skip rules** (otel-ws only): control frames (opcode ≥ 0x8: close/ping/pong) are always forwarded without a span; frames already instrumented by `patchNativeSend` are skipped via `SKIP_FRAME_INJECT_KEY`.

Envelope format when active:

```json
{ "header": { "traceparent": "...", "tracestate": "..." }, "data": <user payload> }
```

When inactive: payloads pass through unchanged, spans are still created.

## Architecture

### otel-ws

- Patches `ws.send()` to wrap outgoing payloads in the envelope (PRODUCER span)
- Patches `ws._sender.sendFrame()` at the binary frame level to inject trace context into JSON frames
- Uses Symbols to store internal state on `WebSocket` instances; `WeakMap` for wrapped message handlers to support `ws.off()`
- `SKIP_FRAME_INJECT_KEY` on the OTel context prevents double-wrapping between patch layers
- `ws` is pinned to `5.1.1` — binary frame patching is sensitive to `ws` internals

### otel-rxjs-ws

- Extends RxJS `WebSocketSubject` directly for API compatibility
- Maintains context queues (`_pendingSendContexts`, `_pendingReceiveCtxs`) because RxJS may buffer messages before the socket is open
- Overrides `_subscribe()` to inject extracted receive context into the observable pipeline
- **`FallbackWebSocket` proxy** (`createFallbackCtor`): when the default `['otel-ws']` offer is used (no explicit protocol), the internal WebSocket constructor is wrapped with a proxy that suppresses pre-open errors and retries once without any subprotocol if the server closes the connection before `onopen`. After a successful fallback, `protocol === ''` → `clientEnvelopeActive` returns `false` → passthrough mode. Only active for the default protocol-undefined case; explicit protocols bypass this proxy.

### otel-nats

- `OtelNatsConn` wraps `NatsConnection` (TCP via `@nats-io/transport-node`); `wsconnect()` lazily imports `@nats-io/nats-core` for browser/WebSocket connections
- `publish()` — synchronous PRODUCER span, injects W3C headers into `MsgHdrs`
- `subscribe()` — async generator yielding `{ msg, ctx }` with a CONSUMER span per message
- `request()` — PRODUCER span for request-reply
- `JetStream` (in `./jetstream` export) — `publish()`, `consumer().messages()` (async generator, `lastSpan` pattern), `consumer().fetch()` (batch, point-in-time spans)
- `natsHeaderGetter` / `natsHeaderSetter` — `TextMapGetter`/`TextMapSetter` for `MsgHdrs`; maps empty string to `undefined` since `MsgHdrsImpl.get()` returns `""` for absent keys
- `NatsInstrumentationOptions` — optional `tracerProvider` and `propagators` overrides; resolves global on each call so tests can swap globals between cases
- Span names follow Go instrumentation convention: `"{subject} send"` / `"{subject} process"` / `"{subject} receive"`
- `@nats-io/jetstream` and `@nats-io/nats-core` are optional peer dependencies

### Span Attributes

All packages follow OTel messaging semconv v1.27.0. WebSocket packages create spans named `websocket.send` (PRODUCER) and `websocket.receive` (CONSUMER) with:

```
messaging.system        = 'websocket' | 'nats'
messaging.operation     = 'send' | 'receive'
messaging.destination.name = subject (nats)
server.address          = NATS server hostname
```

## Test Patterns

All packages use `InMemorySpanExporter` + `NodeTracerProvider` with `W3CTraceContextPropagator`. Call `teardown()` in `afterEach` to reset OTel globals (`trace.disable()`, `propagation.disable()`, `context.disable()`).

```typescript
// otel-nats: packages/otel-nats/test/helpers.ts
const { exporter, provider, teardown } = setupOTel();
afterEach(teardown);

// otel-ws / otel-rxjs-ws: equivalent inline setup
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

Tests spin up a real `ws` server (otel-ws/otel-rxjs-ws) or a real `nats-server` (otel-nats) on a randomly allocated port via `net.createServer()` on port `0`.

## Key Files

- `packages/otel-ws/src/index.ts` — `OtelWebSocket` class + `instrumentSocket()` + `OtelWebSocket.Server`
- `packages/otel-ws/src/wire-message.ts` — `buildEnvelope()` / `deserializeMessage()`
- `packages/otel-rxjs-ws/src/subject.ts` — `InstrumentedWebSocketSubject` class
- `packages/otel-nats/src/index.ts` — `OtelNatsConn`, `connect()`, `wsconnect()`
- `packages/otel-nats/src/jetstream.ts` — `JetStream`, `OtelConsumer` (separate `./jetstream` export)
- `packages/otel-nats/src/carrier.ts` — `natsHeaderGetter` / `natsHeaderSetter`
- `packages/otel-nats/src/attributes.ts` — `publishAttrs()` / `receiveAttrs()`
- `packages/otel-nats/test/helpers.ts` — `setupOTel()`, `startNatsServer()`, `startNatsServerWithWebSocket()`
- `tsconfig.base.json` — shared TypeScript config (ES2022, NodeNext, strict)
- `eslint.config.mjs` — flat ESLint config with `typescript-eslint` recommended type-checked

## Dependency Notes

- `otel-ws` pins `ws` at `5.1.1` (not a range) — binary frame patching is sensitive to ws internals
- All packages use `@opentelemetry/sdk-trace-node ^2.6.0` and `typescript ^6.0.0`
- TypeScript 6 requires `"types": ["node"]` in each package tsconfig — added to all tsconfigs
- ESLint 10 requires Node **20.19.0+** (not just any Node 20.x)
- `@typescript-eslint/no-unsafe-call` and `no-unsafe-member-access` are disabled in test files — `@types/jest` v30 uses conditional types that typescript-eslint 8 cannot resolve
- `otel-nats` requires `@nats-io/transport-node` peer; `@nats-io/jetstream` and `@nats-io/nats-core` are optional peers
