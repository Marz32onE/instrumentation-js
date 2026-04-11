import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { headers as natsHeaders } from '@nats-io/transport-node';
import type { Msg, NatsConnection, Subscription } from '@nats-io/transport-node';
import { OtelNatsConn } from '../src/index.js';
import { natsHeaderSetter } from '../src/carrier.js';
import { setupOTel } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

type MockMsg = Pick<Msg, 'data' | 'headers' | 'subject'>;

/** Create a minimal mock Subscription that yields the given messages once. */
function makeSubIter(messages: MockMsg[]): Subscription {
  return {
    unsubscribe: jest.fn(),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m as Msg;
    },
  } as unknown as Subscription;
}

/** Create a mock NatsConnection. */
function makeMockNc(opts?: {
  publishThrows?: boolean;
  subMessages?: MockMsg[];
  requestResolves?: Uint8Array;
  requestRejects?: Error;
}): { nc: NatsConnection; publishSpy: jest.Mock } {
  const publishSpy = opts?.publishThrows
    ? (jest.fn().mockImplementation(() => { throw new Error('connection closed'); }) as jest.Mock)
    : (jest.fn() as jest.Mock);

  const nc = {
    getServer: jest.fn().mockReturnValue('nats://127.0.0.1:4222'),
    publish: publishSpy,
    subscribe: jest.fn().mockReturnValue(makeSubIter(opts?.subMessages ?? [])),
    request: opts?.requestRejects
      ? (jest.fn() as jest.Mock).mockRejectedValue(opts.requestRejects)
      : (jest.fn() as jest.Mock).mockResolvedValue({
          data: opts?.requestResolves ?? enc.encode('pong'),
          subject: 'reply',
          headers: undefined,
        }),
    drain: (jest.fn() as jest.Mock).mockResolvedValue(undefined),
    close: (jest.fn() as jest.Mock).mockResolvedValue(undefined),
  } as unknown as NatsConnection;

  return { nc, publishSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OtelNatsConn (unit — mocked NatsConnection)', () => {
  let otel: ReturnType<typeof setupOTel>;

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  // ── publish ───────────────────────────────────────────────────────────────

  it('publish creates a PRODUCER span with correct attributes', () => {
    const { nc } = makeMockNc();
    const conn = new OtelNatsConn(nc);

    conn.publish(ROOT_CONTEXT, 'orders.new', enc.encode('hello'));

    const spans = otel.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('orders.new send');
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.attributes['messaging.system']).toBe('nats');
    expect(span.attributes['messaging.destination.name']).toBe('orders.new');
    expect(span.attributes['messaging.operation.type']).toBe('send');
    expect(span.attributes['messaging.operation.name']).toBe('publish');
    expect(span.attributes['messaging.message.body.size']).toBe(5);
    expect(span.attributes['server.address']).toBe('127.0.0.1');
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('publish omits body.size attribute when data is empty', () => {
    const { nc } = makeMockNc();
    const conn = new OtelNatsConn(nc);

    conn.publish(ROOT_CONTEXT, 'ping');

    const span = otel.exporter.getFinishedSpans()[0];
    expect(span.attributes['messaging.message.body.size']).toBeUndefined();
  });

  it('publish injects W3C traceparent into message headers', () => {
    const { nc, publishSpy } = makeMockNc();
    const conn = new OtelNatsConn(nc);

    const tracer = otel.provider.getTracer('test');
    const parentSpan = tracer.startSpan('parent', {}, ROOT_CONTEXT);
    const parentCtx = trace.setSpan(ROOT_CONTEXT, parentSpan);
    conn.publish(parentCtx, 'orders.new', enc.encode('hi'));
    parentSpan.end();

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const callArgs = publishSpy.mock.calls[0] as [string, Uint8Array, { headers: ReturnType<typeof natsHeaders> }];
    const hdrs = callArgs[2].headers;
    const traceparent = hdrs.get('traceparent');
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('publish records error and sets ERROR status when nc.publish throws', () => {
    const { nc } = makeMockNc({ publishThrows: true });
    const conn = new OtelNatsConn(nc);

    expect(() => conn.publish(ROOT_CONTEXT, 'err.subject', enc.encode('x'))).toThrow();

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'err.subject send');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  // ── subscribe ─────────────────────────────────────────────────────────────

  it('subscribe creates a CONSUMER span with correct attributes', async () => {
    const { nc } = makeMockNc({
      subMessages: [{ subject: 'orders.new', data: enc.encode('world'), headers: undefined }],
    });
    const conn = new OtelNatsConn(nc);

    for await (const _ of conn.subscribe('orders.new')) break;

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.new process');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.attributes['messaging.system']).toBe('nats');
    expect(span?.attributes['messaging.destination.name']).toBe('orders.new');
    expect(span?.attributes['messaging.operation.type']).toBe('process');
    expect(span?.attributes['messaging.operation.name']).toBe('process');
  });

  it('subscribe consumer span has link to producer span (same trace)', async () => {
    const tracer = otel.provider.getTracer('test');
    const producerSpan = tracer.startSpan('producer', { kind: SpanKind.PRODUCER }, ROOT_CONTEXT);
    const producerCtx = trace.setSpan(ROOT_CONTEXT, producerSpan);
    producerSpan.end();

    // Build headers carrying the producer trace context
    const { propagation } = await import('@opentelemetry/api');
    const hdrs = natsHeaders();
    propagation.inject(producerCtx, hdrs, natsHeaderSetter);

    const { nc } = makeMockNc({
      subMessages: [{ subject: 'orders.new', data: enc.encode('data'), headers: hdrs }],
    });
    const conn = new OtelNatsConn(nc);

    for await (const _ of conn.subscribe('orders.new')) break;

    const producerSpanCtx = producerSpan.spanContext();
    const consumerSpan = otel.exporter.getFinishedSpans().find((s) => s.name === 'orders.new process');

    expect(consumerSpan).toBeDefined();
    // Must NOT be a child of producer
    expect(consumerSpan?.parentSpanId).not.toBe(producerSpanCtx.spanId);
    // Must carry a link to the producer
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(producerSpanCtx.traceId);
    expect(consumerSpan?.links[0].context.spanId).toBe(producerSpanCtx.spanId);
  });

  it('subscribe creates span with no links when message has no trace context', async () => {
    const { nc } = makeMockNc({
      subMessages: [{ subject: 'raw', data: enc.encode('raw'), headers: undefined }],
    });
    const conn = new OtelNatsConn(nc);

    for await (const _ of conn.subscribe('raw')) break;

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'raw process');
    expect(span?.links).toHaveLength(0);
  });

  it('subscribe with queue sets messaging.consumer.group.name', async () => {
    const { nc } = makeMockNc({
      subMessages: [{ subject: 'q', data: enc.encode('q'), headers: undefined }],
    });
    const conn = new OtelNatsConn(nc);

    for await (const _ of conn.subscribe('q', { queue: 'workers' })) break;

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'q process');
    expect(span?.attributes['messaging.consumer.group.name']).toBe('workers');
  });

  it('subscribe yields ctx so child spans can be linked', async () => {
    const { nc } = makeMockNc({
      subMessages: [{ subject: 'ctx.test', data: enc.encode('x'), headers: undefined }],
    });
    const conn = new OtelNatsConn(nc);

    let yieldedCtx: import('@opentelemetry/api').Context | undefined;
    for await (const { ctx } of conn.subscribe('ctx.test')) {
      yieldedCtx = ctx;
      break;
    }

    expect(yieldedCtx).toBeDefined();
    const sp = trace.getSpan(yieldedCtx!);
    expect(sp).toBeDefined(); // active span in ctx is the consumer span
  });

  it('subscribe span ends before the next yield (both spans end)', async () => {
    const { nc } = makeMockNc({
      subMessages: [
        { subject: 'lifecycle', data: enc.encode('a'), headers: undefined },
        { subject: 'lifecycle', data: enc.encode('b'), headers: undefined },
      ],
    });
    const conn = new OtelNatsConn(nc);

    let count = 0;
    for await (const _ of conn.subscribe('lifecycle')) {
      if (++count >= 2) break;
    }

    const spans = otel.exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'lifecycle process');
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      const endNs = s.endTime[0] * 1e9 + s.endTime[1];
      expect(endNs).toBeGreaterThan(0);
    }
  });

  // ── request ───────────────────────────────────────────────────────────────

  it('request creates a PRODUCER span and returns the reply', async () => {
    const { nc } = makeMockNc({ requestResolves: enc.encode('pong') });
    const conn = new OtelNatsConn(nc);

    const reply = await conn.request(ROOT_CONTEXT, 'rpc.ping', enc.encode('ping'));

    expect(dec.decode(reply.data)).toBe('pong');

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'rpc.ping send');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it('request sets ERROR status when nc.request rejects', async () => {
    const { nc } = makeMockNc({ requestRejects: new Error('timeout') });
    const conn = new OtelNatsConn(nc);

    await expect(
      conn.request(ROOT_CONTEXT, 'rpc.timeout', enc.encode('x'), { timeout: 200 }),
    ).rejects.toThrow('timeout');

    const span = otel.exporter.getFinishedSpans().find((s) => s.name === 'rpc.timeout send');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
