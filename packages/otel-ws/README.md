# @marz32one/otel-ws

Native [`ws`](https://www.npmjs.com/package/ws) OpenTelemetry instrumentation for Node.js.

Propagates W3C Trace Context (`traceparent` / `tracestate`) in the JSON message body using a **flat wire format** compatible with `@marz32one/otel-rxjs-ws` and the Go worker WebSocket broadcasts.

## Wire format

Trace headers are merged into the outgoing JSON object (flat — no wrapper key):

```json
{ "your": "payload", "traceparent": "00-…", "tracestate": "…" }
```

On receive, `traceparent` and `tracestate` are extracted from the top-level fields; the remainder is returned as the message payload. Plain text / non-JSON messages are passed through unchanged.

## Install

```bash
npm install @marz32one/otel-ws @opentelemetry/api ws
```

## Usage

### Connect and use

```typescript
import { connect } from '@marz32one/otel-ws';

const socket = await connect('ws://localhost:8085/otel-ws');

socket.onMessage((msg, ctx) => {
  // msg = { your: 'payload' } — trace fields stripped
  // ctx = OTel context extracted from the sender's traceparent
  console.log('recv', msg);
});

socket.send({ text: 'hello' });
socket.close();
```

### Instrument an existing WebSocket

```typescript
import WebSocket from 'ws';
import { instrumentSocket } from '@marz32one/otel-ws';

const ws = new WebSocket('ws://localhost:8085/otel-ws');
const socket = instrumentSocket(ws);

socket.onMessage((msg, ctx) => console.log(msg));
socket.send({ text: 'hi' });
```

## Spans created

| Operation | Span name | Kind |
|-----------|-----------|------|
| `send` | `websocket.send` | Producer |
| Incoming message | `websocket.receive` | Consumer |

`websocket.receive` is a child of the extracted sender context when trace context is present.

## TracerProvider

By default the package uses `otel.GetTracerProvider()`. Override in your app init:

```typescript
import { trace } from '@opentelemetry/api';
// ... create and register your NodeTracerProvider as global
```

## Diagnostic logging

The package logs via `@opentelemetry/api`'s `diag` — silent by default. Enable in your app:

```typescript
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
```

| Level | Events logged |
|-------|--------------|
| `DEBUG` | JSON parse fallback on receive |
| `ERROR` | Serialization failure on send, socket send failure |

## License

Apache-2.0
