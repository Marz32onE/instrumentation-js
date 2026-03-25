# @marz32one/otel-ws

Native [`ws`](https://www.npmjs.com/package/ws) OpenTelemetry instrumentation for Node.js.

This package keeps the same wire compatibility as Go `otel-gorilla-ws` and `@marz32one/otel-rxjs-ws`:

- Outgoing send: embedded JSON `{ "traceparent"?, "tracestate"?, "data": ... }`
- Incoming receive: embedded JSON, header envelope, or plain JSON/text

## Install

```bash
npm install @marz32one/otel-ws @opentelemetry/api ws
```

## Usage

```ts
import { connect } from '@marz32one/otel-ws';

const socket = await connect('ws://localhost:8082/ws');
socket.onMessage((msg) => {
  console.log('recv', msg);
});
socket.send({ body: 'hello' });
```
