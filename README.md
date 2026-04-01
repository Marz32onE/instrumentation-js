# instrumentation-js

OpenTelemetry instrumentation packages for JavaScript/TypeScript.

## Packages

| Package | Description |
|---------|-------------|
| [`@marz32one/otel-rxjs-ws`](packages/otel-rxjs-ws) | ESM-only; RxJS `webSocket`-style API + W3C Trace Context in the message body |
| [`@marz32one/otel-ws`](packages/otel-ws) | Native Node.js `ws` API + W3C Trace Context in the message body |

---

## @marz32one/otel-rxjs-ws

Import like RxJS: `import { webSocket } from '@marz32one/otel-rxjs-ws/webSocket'`.

### Subprotocol negotiation

`otel-rxjs-ws` automatically prepends `otel-ws` to the subprotocol list on every connection. Envelope instrumentation is enabled **only** when the server confirms `otel-ws` in the handshake. When not negotiated, payloads pass through unchanged and spans are still created.

Protocol activation is detected via the WebSocket `open` event; stale context queues are cleared on close to prevent bleed across reconnects.

### How it works

| Side | What happens |
|------|--------------|
| **Sender** (`next`) | Wraps outgoing payload in an envelope with `header` containing `traceparent` / `tracestate`. |
| **Receiver** | Extracts `traceparent` / `tracestate` from the `header` field; returns `data` as the message payload. |

Wire format (envelope — only active when `otel-ws` subprotocol is negotiated):

```json
{ "header": { "traceparent": "00-…", "tracestate": "…" }, "data": { "your": "payload" } }
```

### Installation

```bash
npm install @marz32one/otel-rxjs-ws @opentelemetry/api rxjs
```

### Quick start

```typescript
import { context, trace } from '@opentelemetry/api';
import { webSocket } from '@marz32one/otel-rxjs-ws/webSocket';

const ws = webSocket<{ text: string }>({ url: 'ws://localhost:8082/ws' });

ws.subscribe({
  next: (msg) => console.log('recv', msg),
  error: (e) => console.error(e),
  complete: () => console.log('closed'),
});

const span = trace.getTracer('app').startSpan('send');
context.with(trace.setSpan(context.active(), span), () => {
  ws.next({ text: 'hello' });
});
span.end();
```

### API

Identical to [`rxjs/webSocket`](https://rxjs.dev/api/webSocket): exports only `webSocket`, `WebSocketSubject`, and `WebSocketSubjectConfig`. `webSocket(url | config)` returns a `WebSocketSubject<T>` (instrumented under the hood). No extra options beyond what RxJS accepts.

### Spans created

| Path | Span name | Kind |
|------|-----------|------|
| `next` (outgoing) | `websocket.send` | Producer |
| Incoming message | `websocket.receive` | Consumer |

`websocket.receive` is a child of the extracted sender context when trace context is present.

---

## @marz32one/otel-ws

Native Node.js `ws` wrapper. Same envelope wire format as `otel-rxjs-ws`.

Automatically prepends `otel-ws` and `json` to the subprotocol list. Envelope injection is active only when `otel-ws` is confirmed by the server.

```typescript
import WebSocket from '@marz32one/otel-ws';

const ws = new WebSocket('ws://localhost:8085/otel-ws');
ws.on('open', () => {
  ws.send({ text: 'hello' });
});
ws.on('message', (msg) => {
  console.log('recv', msg);
});
```

Use `OtelWebSocket.Server` for auto-instrumented server-side sockets:

```typescript
import OtelWebSocket from '@marz32one/otel-ws';

const wss = new OtelWebSocket.Server({ port: 8085 });
wss.on('connection', (ws) => {
  ws.on('message', (msg) => ws.send({ ack: true }));
});
```

---

## Diagnostic logging

Both packages log via the [OpenTelemetry `diag` API](https://opentelemetry.io/docs/languages/js/api/#diag) — no output by default. Enable with a `DiagConsoleLogger` in the application entry point:

**Node.js** (`ws-node-backend` or any Node app):

```typescript
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
```

Or via the `OTEL_LOG_LEVEL` environment variable (if the app reads it):

```bash
OTEL_LOG_LEVEL=debug node dist/index.js
```

**Browser** (Vite — add to `tracing.ts` before provider init):

```typescript
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
```

Or via the `VITE_OTEL_LOG_LEVEL` environment variable if the app reads it (e.g. `.env.local`):

```env
VITE_OTEL_LOG_LEVEL=debug
```

Supported levels: `verbose`, `debug`, `info`, `warn`, `error`.

---

## Development

```bash
# Install dependencies
make install

# Build all packages
make build

# Run all tests
make test

# Type-check (lint)
make lint

# Dry-run npm pack (verify publish contents)
make publish-dry

# Clean build artefacts
make clean
```

### Publishing

```bash
cd packages/otel-rxjs-ws
npm publish --access public
```