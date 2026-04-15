/**
 * Mirrors `@nats-io/jetstream` README: `jetstreamManager(nc)`, `jetstream(nc)`,
 * `js.publish`, `js.consumers.get` + `consume` / `fetch`. Use `connect` from
 * `@marz32one/otel-nats` and `createJetStream(conn)` instead of `jetstream(nc)`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { jetstreamManager } from '@nats-io/jetstream';
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

    await js.publish('it.js.e2e', enc.encode('payload'), { otelContext: ROOT_CONTEXT });

    const consumer = await js.consumers.get(STREAM, 'it-consumer');
    let receivedTraceparent: string | undefined;

    const iter = await consumer.consume();
    for await (const msg of iter) {
      receivedTraceparent = msg.headers?.get('traceparent');
      msg.ack();
      break;
    }
    await iter.close();

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

    await js.publish('it.js.fetch', enc.encode('x'), { otelContext: ROOT_CONTEXT });

    const consumer = await js.consumers.get(STREAM, 'it-fetcher');
    const fetchIter = await consumer.fetch({ max_messages: 1 });
    for await (const msg of fetchIter) msg.ack();
    await fetchIter.close();

    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const producerSpan = spans.find((s) => s.name === 'it.js.fetch send');
    const consumerSpan = spans.find((s) => s.name === 'it.js.fetch receive');

    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan?.links[0].context.traceId).toBe(producerSpan?.spanContext().traceId);
  }, 30_000);
});
