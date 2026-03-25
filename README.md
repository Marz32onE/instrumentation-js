# instrumentation-js

OpenTelemetry instrumentation packages for JavaScript/TypeScript.

## Packages

| Package | Description |
|---------|-------------|
| [`@marz32one/otel-rxjs-ws`](packages/otel-rxjs-ws) | ESM-only; RxJS `webSocket`-style API + W3C Trace Context in the message body |

---

## @marz32one/otel-rxjs-ws

Aligned with [`instrumentation-go/otel-gorilla-ws`](https://github.com/Marz32onE/instrumentation-go/tree/main/otel-gorilla-ws) wire formats: **embedded** JSON (default) and **header-style** envelope (receive compat).

Import like RxJS: `import { webSocket } from '@marz32one/otel-rxjs-ws/webSocket'`.

### How it works

| Side | What happens |
|------|--------------|
| **Sender** (`next`) | Injects `traceparent` / `tracestate` into embedded JSON `{ "data": … }` (same shape as default Go `WriteMessage`). |
| **Receiver** | Parses **embedded** or legacy **header-style** `{ "headers", "payload" }` for trace extraction. |

Default embedded body:

```json
{ "traceparent": "00-…", "tracestate": "…", "data": { "your": "payload" } }
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

`websocket.receive` uses a **link** to the sender span when trace context is present (async messaging convention).

### Wire format compatibility

**Outgoing (`next`)** uses embedded JSON (aligned with Go `WriteMessage`):

```json
{ "traceparent": "00-…", "tracestate": "…", "data": { … } }
```

**Incoming** accepts embedded JSON, **header-style** `{ "headers": { "traceparent": … }, "payload": "<base64>" }` (Go `ReadMessage`), or plain JSON/text with no trace fields.

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