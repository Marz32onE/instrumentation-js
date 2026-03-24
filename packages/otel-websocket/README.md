# @marz32one/otel-websocket

TypeScript port of [`instrumentation-go/otel-websocket`](https://github.com/Marz32onE/instrumentation-go/tree/main/otel-websocket).

Wraps a [`ws`](https://github.com/websockets/ws) WebSocket and adds OpenTelemetry distributed-tracing support by propagating the **W3C Trace Context** inside the WebSocket message body.  The wire format is compatible with the Go version, so a TypeScript client can talk to a Go server and vice-versa.

## How it works

| Side | What happens |
|------|--------------|
| **Sender** (`writeMessage`) | The current span's trace-context headers (e.g. `traceparent`, `tracestate`) are injected into a lightweight JSON envelope that wraps the original payload. The envelope is sent as the WebSocket message body. |
| **Receiver** (`readMessage`) | The JSON envelope is unwrapped, trace-context headers are extracted and used to reconstruct the remote span context, and a new `Context` that carries the propagated span is returned to the caller. |

```
┌───────────────────────────────────────────────┐
│  WebSocket message body (JSON)                │
│  {                                             │
│    "headers": {                                │
│      "traceparent": "00-<traceid>-<spanid>-01",│
│      "tracestate": "k=v"                       │
│    },                                          │
│    "payload": "<base64>"                       │
│  }                                             │
└───────────────────────────────────────────────┘
```

## Installation

```bash
npm install @marz32one/otel-websocket @opentelemetry/api
```

## Quick start

```typescript
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { dial, newConn, TextMessage } from '@marz32one/otel-websocket';
import { WebSocketServer } from 'ws';

// 1. Initialise the OTel SDK at process startup.
const provider = new NodeTracerProvider();
provider.register({
  propagator: new CompositePropagator({
    propagators: [new W3CTraceContextPropagator()],
  }),
});

// ── Client (sender) ──────────────────────────────────────────────────────────
const conn = await dial(ROOT_CONTEXT, 'ws://localhost:8080/ws');

const tracer = trace.getTracer('my-service');
const span = tracer.startSpan('send-message');
const ctx = trace.setSpan(ROOT_CONTEXT, span);

// Trace context is automatically injected into the message body.
await conn.writeMessage(ctx, TextMessage, Buffer.from('hello'));
span.end();

// ── Server (receiver) ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (rawWs) => {
  const serverConn = newConn(rawWs);
  const handle = async () => {
    // recvCtx carries the propagated span from the client.
    const [recvCtx, , data] = await serverConn.readMessage(ROOT_CONTEXT);

    // Create a child span linked to the client's trace.
    const childSpan = tracer.startSpan('handle-message', {}, recvCtx);
    console.log('received:', data.toString());
    childSpan.end();
  };
  handle();
});
```

## API

### `newConn(ws, opts?): Conn`

Wraps an existing `ws.WebSocket` with trace-context propagation.

### `dial(ctx, url, headers?, opts?): Promise<Conn>`

Convenience dial helper – connects and returns a `Conn`.

### `conn.writeMessage(ctx, messageType, data): Promise<void>`

Encodes `data` into a JSON envelope containing the W3C trace headers from `ctx`, then sends it.  Creates a `websocket.send` producer span.

### `conn.readMessage(ctx): Promise<[Context, number, Buffer]>`

Reads the next message, extracts the trace headers, and returns `[context, messageType, payload]`.  Creates a `websocket.receive` consumer span linked to the sender's span.

If the message was not produced by this library (i.e. not a valid JSON envelope), the raw bytes are returned unchanged with no span context.

### `conn.close(): void`

Closes the underlying WebSocket.

### Options

```typescript
interface Options {
  propagator?: TextMapPropagator;   // default: global propagation API
  tracerProvider?: TracerProvider;  // default: trace.getTracerProvider()
}
```

## Spans created

| Method | Span name | Kind |
|--------|-----------|------|
| `writeMessage` | `websocket.send` | Producer |
| `readMessage` | `websocket.receive` | Consumer |

`readMessage` creates a span **linked** to the sender's span (not parent-child), following the OTel async messaging convention.  Both spans carry `websocket.message.type` and `messaging.message.body.size` attributes.

## Wire format

Every `writeMessage` call wraps the payload in a JSON envelope:

```json
{
  "headers": {
    "traceparent": "00-<traceid>-<spanid>-<flags>",
    "tracestate": "k=v"
  },
  "payload": "<base64>"
}
```

The payload is base64-encoded to match Go's `json.Marshal([]byte)` behaviour – this ensures cross-language compatibility with the Go client/server.

Canonical rule: `headers` only carries W3C trace context keys (`traceparent`, optional `tracestate`) in lowercase. Extra headers are filtered out to keep Go and JS propagation behaviour identical.

## Backward compatibility

If a message was **not** produced by this library, `readMessage` returns the raw bytes unchanged and no span context is injected into the returned context.  This makes it safe to introduce `otel-websocket` incrementally alongside plain WebSocket messages.
