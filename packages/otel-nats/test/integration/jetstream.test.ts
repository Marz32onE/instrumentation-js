import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { jetstream as rawJetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '../../src/index.js';
import { createJetStream } from '../../src/jetstream.js';
import { startNatsContainer, setupOTel } from './helpers.js';

const enc = new TextEncoder();
const STREAM = 'IT_STREAM';
const SUBJECT = 'it.js.>';

describe('[integration] JetStream', () => {
  let serverUrl: string;
  let stopContainer: () => Promise<void>;
  let otel: ReturnType<typeof setupOTel>;

  beforeAll(async () => {
    const c = await startNatsContainer({ jetstream: true });
    serverUrl = c.url;
    stopContainer = c.stop;
  });

  afterAll(async () => {
    await stopContainer();
  });

  beforeEach(async () => {
    otel = setupOTel();

    const nc = (await connect({ servers: serverUrl })).natsConn();
    const jsm = await jetstreamManager(nc);
    try { await jsm.streams.delete(STREAM); } catch { /* first run */ }
    await jsm.streams.add({ name: STREAM, subjects: [SUBJECT] });
    await nc.close();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  it('publish → consumer.messages(): traceparent propagates across JetStream', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, { durable_name: 'it-consumer', filter_subject: 'it.js.e2e' });

    await js.publish(ROOT_CONTEXT, 'it.js.e2e', enc.encode('payload'));

    const consumer = await js.consumer(STREAM, 'it-consumer');
    let receivedTraceparent: string | undefined;

    for await (const { msg } of consumer.messages()) {
      receivedTraceparent = msg.headers?.get('traceparent');
      msg.ack();
      break;
    }

    await conn.drain();

    expect(receivedTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const spans = otel.exporter.getFinishedSpans();
    const producerSpan = spans.find((s) => s.name === 'it.js.e2e send');
    const consumerSpan = spans.find((s) => s.name === 'it.js.e2e receive');

    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(producerSpan?.spanContext().traceId);
  }, 30_000);

  it('consumer.fetch(): traceparent in fetched messages', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, { durable_name: 'it-fetcher', filter_subject: 'it.js.fetch' });

    await js.publish(ROOT_CONTEXT, 'it.js.fetch', enc.encode('x'));

    const consumer = await js.consumer(STREAM, 'it-fetcher');
    const results = await consumer.fetch(1);
    for (const { msg } of results) msg.ack();

    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const producerSpan = spans.find((s) => s.name === 'it.js.fetch send');
    const consumerSpan = spans.find((s) => s.name === 'it.js.fetch receive');

    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan?.links[0].context.traceId).toBe(producerSpan?.spanContext().traceId);

    // Verify traceparent was injected into the stored message
    const jsm2 = await jetstreamManager(conn.natsConn());
    const rawJs = rawJetstream(conn.natsConn());
    await jsm2.consumers.add(STREAM, { durable_name: 'it-verify', filter_subject: 'it.js.fetch' });
    const rawConsumer = await rawJs.consumers.get(STREAM, 'it-verify');
    const msgs = await rawConsumer.fetch({ max_messages: 1 });
    let tp: string | undefined;
    for await (const m of msgs) { tp = m.headers?.get('traceparent'); m.ack(); }

    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  }, 30_000);
});
