# @marz32one/otel-nats

OpenTelemetry trace propagation for NATS JavaScript clients: **W3C Trace Context** (`traceparent` / `tracestate`) on **NATS message headers** (`MsgHdrs`), aligned with the Go [`instrumentation-go/otel-nats`](https://github.com/Marz32onE/instrumentation-go) tracing semantics.

Public APIs follow **[nats.js v3](https://github.com/nats-io/nats.js)** (`@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/nats-core`) method shapes. Tracing is added by:

- Optional **`otelContext`** on publish / request / JetStream publish options (defaults to `context.active()` when omitted).
- **`getMessageTraceContext(msg)`** / **`getJetStreamMessageTraceContext(jsMsg)`** for the OpenTelemetry `Context` after subscribe / JetStream consume / fetch / next.

See [docs/nats-api-matrix.md](docs/nats-api-matrix.md) for wrap vs delegate coverage.

**Migrating from 0.1.x:** use `publish(subject, data, { otelContext })` instead of `publish(ctx, subject, data)`; `subscribe()` returns a native `Subscription` of `Msg` — use `getMessageTraceContext(msg)`; JetStream: `js.consumers.get(stream, name)` with `consume()` / `fetch({ max_messages })` instead of `js.consumer()` / `messages()` / `fetch(n)`.

## Requirements

- Node.js **>= 20**
- `@opentelemetry/api` ^1.9.0
- `@nats-io/transport-node` ^3.3.0 (required peer)

## Install

```bash
npm install @marz32one/otel-nats @opentelemetry/api @nats-io/transport-node
```

For JetStream (`createJetStream` / `./jetstream`):

```bash
npm install @nats-io/jetstream
```

For WebSocket (`wsconnect`), ensure `@nats-io/nats-core` is available (pulled in by `transport-node`, or add explicitly).

## Core NATS (`connect`)

```typescript
import { connect, getMessageTraceContext } from '@marz32one/otel-nats';

const conn = await connect({ servers: 'nats://127.0.0.1:4222' });

// Same shape as NatsConnection.publish(subject, payload?, options?) + otelContext
conn.publish('hello', data, { otelContext: ctx });

const sub = conn.subscribe('hello');
for await (const msg of sub) {
  const c = getMessageTraceContext(msg);
  // use c for child spans
  break;
}

await conn.request('rpc.subject', payload, { timeout: 5000, otelContext: ctx });
```

Optional **`NatsInstrumentationOptions.traceDestination`**: default `Nats-Trace-Dest` header on core publishes (NATS server 2.11+). Per-call override: `publish(..., { traceDestination: 'my.trace.subject' })` (core) or JetStream `publish(..., { traceDestination: '...' })`.

## WebSocket (`wsconnect`)

```typescript
import Ws from 'ws';
import { wsconnect } from '@marz32one/otel-nats';

const conn = await wsconnect({
  servers: 'ws://127.0.0.1:9222',
  wsFactory: async (u) => ({
    socket: new Ws(u) as unknown as WebSocket,
    encrypted: u.startsWith('wss:'),
  }),
});
```

Exported types: `WsConnectionOptions`, `CoreConnectionOptions`.

## JetStream

```typescript
import { connect, getMessageTraceContext } from '@marz32one/otel-nats';
import { createJetStream, getJetStreamMessageTraceContext } from '@marz32one/otel-nats/jetstream';

const conn = await connect({ servers: 'nats://127.0.0.1:4222' });
const js = createJetStream(conn);

await js.publish('orders.created', data, { otelContext: ctx });

const c = await js.consumers.get('ORDERS', 'processor');
const iter = await c.consume();
for await (const msg of iter) {
  const otelCtx = getJetStreamMessageTraceContext(msg);
  msg.ack();
  break;
}
await iter.close();
```

`JetStream` forwards **`streams`**, **`apiPrefix`**, **`getOptions`**, **`jetstreamManager`**, and **`startBatch`** to the underlying `JetStreamClient` (batch path is not individually traced).

## License

Apache-2.0
