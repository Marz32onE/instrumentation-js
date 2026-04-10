import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '../src/index.js';
import { createJetStream } from '../src/jetstream.js';
import { setupOTel, startNatsServer } from './helpers.js';

const enc = new TextEncoder();
const STREAM = 'TEST_STREAM';
const SUBJECT = 'test.js.>';

describe('JetStream', () => {
  let serverUrl: string;
  let stopServer: () => Promise<void>;
  let otel: ReturnType<typeof setupOTel>;

  beforeAll(async () => {
    const server = await startNatsServer({ jetstream: true });
    serverUrl = server.url;
    stopServer = server.stop;
  });

  afterAll(async () => {
    await stopServer();
  });

  beforeEach(async () => {
    otel = setupOTel();

    // Reset stream before each test
    const nc = (await connect({ servers: serverUrl })).natsConn();
    const jsm = await jetstreamManager(nc);
    try {
      await jsm.streams.delete(STREAM);
    } catch {
      // stream may not exist yet
    }
    await jsm.streams.add({ name: STREAM, subjects: [SUBJECT] });
    await nc.close();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  // ---------------------------------------------------------------------------
  // publish
  // ---------------------------------------------------------------------------

  it('publish creates a PRODUCER span', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const ack = await js.publish(ROOT_CONTEXT, 'test.js.pub', enc.encode('hello'));
    await conn.drain();

    expect(ack.seq).toBeGreaterThan(0);

    const spans = otel.exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === 'test.js.pub send');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes['messaging.system']).toBe('nats');
    expect(span?.attributes['messaging.destination.name']).toBe('test.js.pub');
    expect(span?.attributes['messaging.operation.type']).toBe('send');
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it('publish injects traceparent into JetStream message headers', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    await js.publish(ROOT_CONTEXT, 'test.js.headers', enc.encode('data'));

    // Read back via raw consumer to inspect headers
    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, {
      durable_name: 'header-check',
      filter_subject: 'test.js.headers',
    });
    const rawJs = jetstream(conn.natsConn());
    const consumer = await rawJs.consumers.get(STREAM, 'header-check');
    const msgs = await consumer.fetch({ max_messages: 1 });
    let traceparent: string | undefined;
    for await (const msg of msgs) {
      traceparent = msg.headers?.get('traceparent');
      msg.ack();
    }

    await conn.drain();

    expect(traceparent).toBeTruthy();
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  // ---------------------------------------------------------------------------
  // consumer.messages()
  // ---------------------------------------------------------------------------

  it('consumer.messages() creates CONSUMER span with link to producer', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, {
      durable_name: 'msg-link',
      filter_subject: 'test.js.msglink',
    });

    await js.publish(ROOT_CONTEXT, 'test.js.msglink', enc.encode('payload'));

    const consumer = await js.consumer(STREAM, 'msg-link');
    const gen = consumer.messages();

    for await (const m of gen) {
      m.msg.ack();
      break;
    }

    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const producerSpan = spans.find((s) => s.name === 'test.js.msglink send');
    const consumerSpan = spans.find((s) => s.name === 'test.js.msglink receive');

    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan?.kind).toBe(SpanKind.CONSUMER);
    expect(consumerSpan?.attributes['messaging.consumer.name']).toBe('msg-link');
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(
      producerSpan?.spanContext().traceId,
    );
  });

  it('consumer.messages() ends previous span before yielding next', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, {
      durable_name: 'msg-lifecycle',
      filter_subject: 'test.js.lifecycle',
    });

    await js.publish(ROOT_CONTEXT, 'test.js.lifecycle', enc.encode('a'));
    await js.publish(ROOT_CONTEXT, 'test.js.lifecycle', enc.encode('b'));

    const consumer = await js.consumer(STREAM, 'msg-lifecycle');
    const gen = consumer.messages();

    let count = 0;
    for await (const m of gen) {
      m.msg.ack();
      count++;
      if (count >= 2) break;
    }

    await conn.drain();

    const consumerSpans = otel.exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'test.js.lifecycle receive');

    expect(consumerSpans).toHaveLength(2);
    for (const s of consumerSpans) {
      const endNs = s.endTime[0] * 1e9 + s.endTime[1];
      expect(endNs).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // consumer.fetch()
  // ---------------------------------------------------------------------------

  it('consumer.fetch() returns array with CONSUMER spans that are immediately ended', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, {
      durable_name: 'fetch-test',
      filter_subject: 'test.js.fetch',
    });

    await js.publish(ROOT_CONTEXT, 'test.js.fetch', enc.encode('x1'));
    await js.publish(ROOT_CONTEXT, 'test.js.fetch', enc.encode('x2'));
    await js.publish(ROOT_CONTEXT, 'test.js.fetch', enc.encode('x3'));

    const consumer = await js.consumer(STREAM, 'fetch-test');
    const results = await consumer.fetch(3);

    for (const { msg } of results) {
      msg.ack();
    }

    await conn.drain();

    expect(results).toHaveLength(3);

    const consumerSpans = otel.exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'test.js.fetch receive');
    expect(consumerSpans).toHaveLength(3);

    for (const s of consumerSpans) {
      const endNs = s.endTime[0] * 1e9 + s.endTime[1];
      expect(endNs).toBeGreaterThan(0);
    }
  });

  it('consumer.fetch() spans have link to producer spans', async () => {
    const conn = await connect({ servers: serverUrl });
    const js = createJetStream(conn);

    const jsm = await jetstreamManager(conn.natsConn());
    await jsm.consumers.add(STREAM, {
      durable_name: 'fetch-link',
      filter_subject: 'test.js.fetchlink',
    });

    await js.publish(ROOT_CONTEXT, 'test.js.fetchlink', enc.encode('msg'));

    const consumer = await js.consumer(STREAM, 'fetch-link');
    const results = await consumer.fetch(1);
    for (const { msg } of results) {
      msg.ack();
    }

    await conn.drain();

    const producerSpan = otel.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'test.js.fetchlink send');
    const consumerSpan = otel.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'test.js.fetchlink receive');

    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(
      producerSpan?.spanContext().traceId,
    );
  });
});
