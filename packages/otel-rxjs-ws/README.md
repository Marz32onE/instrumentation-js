# @marz32one/otel-rxjs-ws

RxJS **`webSocket`-style** OpenTelemetry instrumentation, aligned with [`instrumentation-go/otel-gorilla-ws`](https://github.com/Marz32onE/instrumentation-go/tree/main/otel-gorilla-ws).

This package is **ESM-only** (`"type": "module"`). Run `npm run build` so `dist/` exists before consuming from `file:` or npm.

## Subprotocol negotiation and wire format

By default (no `protocol` in config), the client offers `['otel-ws']` and automatically falls back to a plain connection if the server rejects it.

| Config | Offer sent | Result |
|--------|-----------|--------|
| No `protocol` (default) | `['otel-ws']` | Envelope mode if server accepts; passthrough if rejected (auto-retry) |
| Explicit empty (`''` / `[]`) | `[]` | Passthrough mode — no otel-ws offer |
| `protocol: 'json'` | `['otel-ws+json', 'json']` | Envelope mode if server accepts `otel-ws+json` |
| `prependOtelSubprotocol: false` | user protocols only | otel-ws token never offered |

**Envelope mode** is active when the server returns `otel-ws` or `otel-ws+<subprotocol>` in the handshake. Each message is wrapped:

```json
{ "header": { "traceparent": "00-…", "tracestate": "…" }, "data": { "your": "payload" } }
```

**Passthrough mode** (no envelope, no payload changes): spans are still created, but no trace context is injected into messages.

**Automatic fallback**: when the default offer is used and the server closes the connection before `open` (strict subprotocol validation), the client retries once without any subprotocol and connects in passthrough mode. No configuration needed.

Protocol activation is detected via the WebSocket `open` event. On close, pending context queues are cleared to prevent stale contexts from bleeding across reconnects.

## Requirements

- Node.js **>= 20**
- `@opentelemetry/api` ^1.9.0
- `rxjs` ^7.8.0

## Install

```bash
npm install @marz32one/otel-rxjs-ws @opentelemetry/api rxjs
```

## Usage

```typescript
import { webSocket } from '@marz32one/otel-rxjs-ws/webSocket';
// same as: import { webSocket } from '@marz32one/otel-rxjs-ws';

// Default: offers ['otel-ws'], falls back automatically if server rejects it.
const ws = webSocket<MyType>({ url: 'ws://localhost:8082/ws' });
ws.subscribe({ next: console.log, error: console.error });
ws.next({ foo: 'bar' });
ws.complete();

// Legacy server that only negotiates 'json' — skip otel-ws offer entirely.
const wsLegacy = webSocket<MyType>({
  url: 'ws://legacy-server/ws',
  protocol: 'json',
  prependOtelSubprotocol: false,
});
```

## Spans created

| Path | Span name | Kind |
|------|-----------|------|
| `next` (outgoing) | `websocket.send` | Producer |
| Incoming message | `websocket.receive` | Consumer |

`websocket.receive` is a child of the extracted sender context when trace context is present.

## Diagnostic logging

The package logs via `@opentelemetry/api`'s `diag` — silent by default. Enable in your app entry point:

```typescript
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
```

| Level | Events logged |
|-------|--------------|
| `DEBUG` | JSON parse fallback on receive |
| `WARN` | Custom serializer returned non-string (trace wrapping skipped) |
| `ERROR` | Serialization failure; custom deserializer threw |

## License

Apache-2.0
