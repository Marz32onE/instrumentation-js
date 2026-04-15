# Upstream NATS.js API vs @marz32one/otel-nats

Reference: `@nats-io/nats-core` `NatsConnection`, `@nats-io/jetstream` `JetStreamClient` / `Consumer` / `PushConsumer` (v3.3.x).

| API | Strategy |
|-----|----------|
| `closed`, `close`, `drain`, `flush`, `isClosed`, `isDraining`, `getServer`, `status`, `stats`, `rtt`, `reconnect`, `info` | **Delegate** to underlying `NatsConnection` |
| `publish` | **Wrap**: PRODUCER span, inject W3C headers, optional default `traceDestination` from `NatsInstrumentationOptions` |
| `publishMessage` | **Wrap**: same as publish using `msg.subject` / `msg.data` / `msg.headers` / `msg.reply` |
| `respondMessage` | **Wrap**: reply path PRODUCER span + inject (subject = `msg.reply`) |
| `subscribe` | **Wrap**: return `Subscription`; iterator + `callback` paths set consumer span + link; use `getMessageTraceContext(msg)` for `Context` |
| `request` | **Wrap**: PRODUCER span, inject; set reply body size on span before end |
| `requestMany` | **Wrap**: PRODUCER span on outbound; CONSUMER span per response message (extract + link) |
| `JetStreamClient.publish` | **Wrap**: same idea as core `publish` |
| `Consumers.get` / `getConsumerFromInfo` | **Wrap**: returns `OtelConsumer` |
| `Consumers.getPushConsumer` / `getBoundPushConsumer` | **Wrap**: returns `OtelPushConsumer` |
| `Consumer.consume` / `fetch` / `next` | **Wrap**: instrument messages; `getJetStreamMessageContext(msg)` for `Context` |
| `Consumer.info` / `delete` | **Delegate** through wrapper |
| `PushConsumer.consume` / `info` / `delete` | **Wrap** / **Delegate** as above |
| `JetStreamClient.streams`, `apiPrefix`, `getOptions`, `jetstreamManager`, `startBatch` | **Delegate** to inner client (uninstrumented batch path) |
