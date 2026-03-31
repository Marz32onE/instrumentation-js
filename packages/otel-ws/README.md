# @marz32one/otel-ws

Native [`ws`](https://www.npmjs.com/package/ws) OpenTelemetry instrumentation for Node.js.

Propagates W3C Trace Context (`traceparent` / `tracestate`) in the JSON message body when the `otel-ws` subprotocol is negotiated.

## Subprotocol negotiation and wire format

Client side offers `otel-ws` automatically. Envelope instrumentation is enabled **only** when the server confirms `otel-ws` in the handshake (`ws.protocol === 'otel-ws'`).

When negotiated, outgoing messages use an envelope:

```json
{ "header": { "traceparent": "00-…", "tracestate": "…" }, "data": { "your": "payload" } }
```

When not negotiated, payloads are **fully passthrough** (native `ws` behavior): no envelope injection/extraction and no payload shape changes. `websocket.send` / `websocket.receive` spans are still created.

## Install

```bash
npm install @marz32one/otel-ws @opentelemetry/api ws
```

## Usage

### Drop-in usage

```typescript
import WebSocket from '@marz32one/otel-ws';

const ws = new WebSocket('ws://localhost:8085/otel-ws');
ws.on('open', () => {
  ws.send({ text: 'hello' });
});
ws.on('message', (msg) => {
  // trace context extracted before handler runs
  console.log(msg);
});
```

### Server-side (ws-compatible API)

Use `OtelWebSocket.Server` (same shape as `ws`):

```typescript
import OtelWebSocket from '@marz32one/otel-ws';

const wss = new OtelWebSocket.Server({ port: 8085 });
wss.on('connection', (ws) => {
  // auto-instrumented on connection
  ws.on('message', (msg) => {
    ws.send({ ack: true });
  });
});
```

You can still instrument an existing `ws.Server` socket manually:

```typescript
import WsPkg from 'ws';
import { instrumentSocket } from '@marz32one/otel-ws';

const wss = new WsPkg.Server({ port: 8085 });
wss.on('connection', (rawWs) => {
  const ws = instrumentSocket(rawWs);
  ws.on('message', (msg) => {
    // already under extracted context
    ws.send({ ack: true });
  });
});
```

### Native API coverage

`@marz32one/otel-ws` instruments these native paths automatically:

- `ws.on('message', handler)`:
  - automatically extracts `traceparent` / `tracestate`
  - creates `websocket.receive` span
  - executes your native handler under extracted OTel context
- `WebSocket.Sender.frame(...) + ws._sender.sendFrame(...)`:
  - `Sender.frame` remains untouched (still native frame generator)
  - `_sender.sendFrame` path injects trace context into JSON text-frame payloads and creates `websocket.send` span

```typescript
const ws = new WebSocket('ws://localhost:8085/otel-ws');

ws.on('message', (data) => {
  // already under extracted context
  console.log(data);
});

const sender = (ws as any)._sender;
const frame = (WebSocket as any).Sender.frame(
  Buffer.from(JSON.stringify({ text: 'raw frame' }), 'utf8'),
  { fin: true, mask: true, opcode: 1, readOnly: false },
);
sender.sendFrame([Buffer.concat(frame)]);
```

### Internal API caution

`ws._sender` and `WebSocket.Sender.frame` are **ws internal APIs** and may change between ws versions.
`otel-ws` does not patch `Sender.frame`; it only instruments `_sender.sendFrame` and safely skips when internals are unavailable.

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
