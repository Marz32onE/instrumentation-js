import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { JsMsg, PubAck } from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';
import type { NatsConnection } from '@nats-io/transport-node';

// ---------------------------------------------------------------------------
// Mock @nats-io/jetstream before any import of src/jetstream.ts
// ---------------------------------------------------------------------------

const mockJsPublish = jest.fn<() => Promise<PubAck>>();
const mockConsume = jest.fn();
const mockFetch = jest.fn();
const mockNext = jest.fn();
const mockConsumersGet = jest.fn();

jest.unstable_mockModule('@nats-io/jetstream', () => ({
  jetstream: jest.fn(() => ({
    publish: mockJsPublish,
    consumers: {
      get: mockConsumersGet,
      getConsumerFromInfo: jest.fn(),
      getPushConsumer: jest.fn(),
      getBoundPushConsumer: jest.fn(),
    },
    streams: {},
    apiPrefix: '',
    getOptions: jest.fn(),
    jetstreamManager: jest.fn(),
  })),
}));

// Dynamic imports must come after unstable_mockModule
const { OtelNatsConn } = await import('../src/index.js');
const { createJetStream } = await import('../src/jetstream.js');
const { natsHeaderSetter } = await import('../src/carrier.js');
const { setupOTel } = await import('./helpers.js');
const { propagation } = await import('@opentelemetry/api');

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockJsMsg = Partial<JsMsg> & { data: Uint8Array; subject: string; ack: jest.Mock };

function makeJsMsg(subject: string, data = enc.encode('payload'), hdrs?: ReturnType<typeof natsHeaders>): MockJsMsg {
  return { subject, data, headers: hdrs, ack: jest.fn() };
}

function makeConsumerMessages(messages: MockJsMsg[]) {
  return {
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    closed: jest.fn<() => Promise<void | Error>>().mockResolvedValue(undefined),
    status: jest.fn().mockReturnValue(
      (async function* () {
        /* empty */
      })(),
    ),
    stop: jest.fn(),
    getProcessed: jest.fn().mockReturnValue(0),
    getPending: jest.fn().mockReturnValue(0),
    getReceived: jest.fn().mockReturnValue(0),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m as unknown as JsMsg;
    },
  };
}

function makeMockNc(): NatsConnection {
  return {
    getServer: jest.fn().mockReturnValue('nats://127.0.0.1:4222'),
    publish: jest.fn(),
    subscribe: jest.fn(),
    request: jest.fn(),
    drain: (jest.fn() as jest.Mock).mockResolvedValue(undefined),
    close: (jest.fn() as jest.Mock).mockResolvedValue(undefined),
  } as unknown as NatsConnection;
}

const mockPullConsumer = {
  consume: mockConsume,
  fetch: mockFetch,
  next: mockNext,
  info: jest.fn(),
  delete: jest.fn(),
  isPullConsumer: () => true,
  isPushConsumer: () => false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JetStream (unit — mocked @nats-io/jetstream)', () => {
  let otel: ReturnType<typeof setupOTel>;

  beforeEach(() => {
    otel = setupOTel();
    jest.clearAllMocks();
    mockConsumersGet.mockResolvedValue(mockPullConsumer);
  });

  afterEach(async () => {
    await otel.teardown();
  });

  // ── publish ───────────────────────────────────────────────────────────────

  it('publish creates a PRODUCER span with correct attributes', async () => {
    mockJsPublish.mockResolvedValue({ seq: 1, stream: 'TEST', duplicate: false, domain: '' } as PubAck);
    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);

    await js.publish('orders.created', enc.encode('hello'), { otelContext: ROOT_CONTEXT });

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.created send');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes['messaging.system']).toBe('nats');
    expect(span?.attributes['messaging.destination.name']).toBe('orders.created');
    expect(span?.attributes['messaging.operation.type']).toBe('send');
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it('publish injects traceparent into JetStream message headers', async () => {
    mockJsPublish.mockResolvedValue({ seq: 1, stream: 'TEST', duplicate: false, domain: '' } as PubAck);
    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);

    await js.publish('orders.created', enc.encode('data'), { otelContext: ROOT_CONTEXT });

    expect(mockJsPublish).toHaveBeenCalledTimes(1);
    const callOpts = (mockJsPublish.mock.calls[0] as [string, Uint8Array, { headers: ReturnType<typeof natsHeaders> }])[2];
    const traceparent = callOpts.headers.get('traceparent');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('publish sets ERROR status when js.publish rejects', async () => {
    mockJsPublish.mockRejectedValue(new Error('stream not found'));
    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);

    await expect(js.publish('bad.subject', enc.encode('x'), { otelContext: ROOT_CONTEXT })).rejects.toThrow(
      'stream not found',
    );

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'bad.subject send');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  // ── consumer.consume() ───────────────────────────────────────────────────

  it('consumer.consume() iterator creates a CONSUMER span with correct attributes', async () => {
    mockConsume.mockResolvedValue(makeConsumerMessages([makeJsMsg('orders.created')]));
    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);

    const consumer = await js.consumers.get('ORDERS', 'processor');
    const iter = await consumer.consume();
    for await (const msg of iter) {
      msg.ack();
      break;
    }
    await iter.close();

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.created receive');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.attributes['messaging.system']).toBe('nats');
    expect(span?.attributes['messaging.consumer.name']).toBe('processor');
    expect(span?.attributes['messaging.operation.type']).toBe('receive');
  });

  it('consumer.consume() span has link to producer span', async () => {
    const tracer = otel.provider.getTracer('test');
    const producerSpan = tracer.startSpan('producer', { kind: SpanKind.PRODUCER }, ROOT_CONTEXT);
    const producerCtx = trace.setSpan(ROOT_CONTEXT, producerSpan);
    producerSpan.end();

    const hdrs = natsHeaders();
    propagation.inject(producerCtx, hdrs, natsHeaderSetter);

    mockConsume.mockResolvedValue(makeConsumerMessages([makeJsMsg('orders.created', enc.encode('x'), hdrs)]));

    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);
    const consumer = await js.consumers.get('ORDERS', 'processor');

    const iter = await consumer.consume();
    for await (const msg of iter) {
      msg.ack();
      break;
    }
    await iter.close();

    const consumerSpan = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.created receive');
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(producerSpan.spanContext().traceId);
    expect(consumerSpan?.links[0].context.spanId).toBe(producerSpan.spanContext().spanId);
    expect(consumerSpan?.parentSpanId).not.toBe(producerSpan.spanContext().spanId);
  });

  it('consumer.consume() ends span N before yielding message N+1 (lastSpan pattern)', async () => {
    mockConsume.mockResolvedValue(
      makeConsumerMessages([
        makeJsMsg('orders.created', enc.encode('a')),
        makeJsMsg('orders.created', enc.encode('b')),
      ]),
    );

    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);
    const consumer = await js.consumers.get('ORDERS', 'processor');

    const iter = await consumer.consume();
    let count = 0;
    for await (const msg of iter) {
      msg.ack();
      if (++count >= 2) break;
    }
    await iter.close();

    const spans = otel.exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'orders.created receive');
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      expect(s.endTime[0] * 1e9 + s.endTime[1]).toBeGreaterThan(0);
    }
  });

  // ── consumer.fetch() ──────────────────────────────────────────────────────

  it('consumer.fetch() iterator creates immediately-ended CONSUMER spans per message', async () => {
    mockFetch.mockResolvedValue(
      makeConsumerMessages([
        makeJsMsg('orders.created', enc.encode('x1')),
        makeJsMsg('orders.created', enc.encode('x2')),
        makeJsMsg('orders.created', enc.encode('x3')),
      ]),
    );

    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);
    const consumer = await js.consumers.get('ORDERS', 'fetcher');
    const iter = await consumer.fetch({ max_messages: 3 });
    let n = 0;
    for await (const _msg of iter) n++;
    await iter.close();

    expect(n).toBe(3);
    const spans = otel.exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'orders.created receive');
    expect(spans).toHaveLength(3);
    for (const s of spans) {
      expect(s.endTime[0] * 1e9 + s.endTime[1]).toBeGreaterThan(0);
    }
  });

  it('consumer.fetch() spans have link to producer spans', async () => {
    const tracer = otel.provider.getTracer('test');
    const producerSpan = tracer.startSpan('producer', { kind: SpanKind.PRODUCER }, ROOT_CONTEXT);
    const producerCtx = trace.setSpan(ROOT_CONTEXT, producerSpan);
    producerSpan.end();

    const hdrs = natsHeaders();
    propagation.inject(producerCtx, hdrs, natsHeaderSetter);

    mockFetch.mockResolvedValue(makeConsumerMessages([makeJsMsg('orders.created', enc.encode('msg'), hdrs)]));

    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);
    const consumer = await js.consumers.get('ORDERS', 'fetcher');
    const iter = await consumer.fetch({ max_messages: 1 });
    for await (const _m of iter) {
      /* one */
    }
    await iter.close();

    const consumerSpan = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.created receive');
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(producerSpan.spanContext().traceId);
  });

  // ── consumer.next() ─────────────────────────────────────────────────────────

  it('consumer.next() creates a point-in-time CONSUMER span', async () => {
    mockNext.mockResolvedValue(makeJsMsg('orders.created', enc.encode('one')));
    const conn = new OtelNatsConn(makeMockNc());
    const js = createJetStream(conn);
    const consumer = await js.consumers.get('ORDERS', 'nexty');
    const msg = await consumer.next();
    expect(msg).not.toBeNull();
    msg!.ack();

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.created receive');
    expect(span).toBeDefined();
    expect(span?.endTime[0] * 1e9 + span!.endTime[1]).toBeGreaterThan(0);
  });
});
