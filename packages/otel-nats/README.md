# @marz32one/otel-nats

OpenTelemetry trace propagation for NATS JavaScript clients: **W3C Trace Context** (`traceparent` / `tracestate`) is **injected and extracted on NATS message headers** (`MsgHdrs`), compatible with the Go [`instrumentation-go/otel-nats`](https://github.com/Marz32onE/instrumentation-go) pattern.

**v1.x** aligns with [nats.js v3](https://github.com/nats-io/nats.js) modular packages (`@nats-io/transport-node`, `@nats-io/jetstream`, `@nats-io/nats-core`). If you used the legacy `nats` npm v2 client with `@marz32one/otel-nats` 0.x, upgrade your app to v3 clients and this package together.

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

For WebSocket (`wsconnect`), ensure `@nats-io/nats-core` is installed (pulled in by `transport-node`, or add explicitly).

Peer dependencies:

| Package | Role |
|--------|------|
| `@nats-io/transport-node` | Required for `connect()` (TCP / Node). |
| `@nats-io/jetstream` | Required when using `./jetstream` or `createJetStream()`. |
| `@nats-io/nats-core` | Optional; required when calling `wsconnect()` (WebSocket transport). |

## TCP (`connect`)

```typescript
import { connect } from '@marz32one/otel-nats';

const conn = await connect({ servers: 'nats://127.0.0.1:4222' });
await conn.publish(ctx, 'hello', data);
```

## WebSocket (`wsconnect`)

Uses [`wsconnect`](https://nats-io.github.io/nats.js/core/functions/wsconnect.html) from `@nats-io/nats-core`. In Node without a global `WebSocket`, pass `wsFactory` (see [`WsConnectionOptions`](https://nats-io.github.io/nats.js/core/interfaces/WsConnectionOptions.html)):

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

Exported types include `WsConnectionOptions` and `CoreConnectionOptions` (alias for `@nats-io/nats-core` `ConnectionOptions`) for typing `servers`, `wsFactory`, etc.

## JetStream

Import `createJetStream` from `@marz32one/otel-nats/jetstream`. Under the hood this uses [`jetstream()`](https://github.com/nats-io/nats.js/tree/main/jetstream) from `@nats-io/jetstream` with a TCP connection from `connect()`.

## License

Apache-2.0
