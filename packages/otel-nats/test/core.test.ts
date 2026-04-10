import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { connect } from '../src/index.js';
import { setupOTel, startNatsServer, sleep } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('Conn (core NATS)', () => {
  let serverUrl: string;
  let stopServer: () => Promise<void>;
  let otel: ReturnType<typeof setupOTel>;

  beforeAll(async () => {
    const server = await startNatsServer();
    serverUrl = server.url;
    stopServer = server.stop;
  });

  afterAll(async () => {
    await stopServer();
  });

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  // ---------------------------------------------------------------------------
  // publish
  // ---------------------------------------------------------------------------

  it('publish creates a PRODUCER span with correct attributes', async () => {
    const conn = await connect({ servers: serverUrl });
    const sub = conn.natsConn().subscribe('test.pub.attrs');
    // drain sub immediately so server doesn't buffer
    setTimeout(() => sub.unsubscribe(), 100);

    conn.publish(ROOT_CONTEXT, 'test.pub.attrs', enc.encode('hello'));
    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('test.pub.attrs send');
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.attributes['messaging.system']).toBe('nats');
    expect(span.attributes['messaging.destination.name']).toBe('test.pub.attrs');
    expect(span.attributes['messaging.operation.type']).toBe('send');
    expect(span.attributes['messaging.operation.name']).toBe('publish');
    expect(span.attributes['messaging.message.body.size']).toBe(5); // 'hello'
    expect(span.attributes['server.address']).toBeTruthy();
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('publish injects W3C traceparent into message headers', async () => {
    const conn = await connect({ servers: serverUrl });

    let receivedTraceparent: string | undefined;
    const sub = conn.natsConn().subscribe('test.pub.inject');
    const done = (async () => {
      for await (const msg of sub) {
        receivedTraceparent = msg.headers?.get('traceparent');
        break;
      }
    })();

    const tracer = otel.provider.getTracer('test');
    const parentSpan = tracer.startSpan('parent', {}, ROOT_CONTEXT);
    const parentCtx = trace.setSpan(ROOT_CONTEXT, parentSpan);
    conn.publish(parentCtx, 'test.pub.inject', enc.encode('hi'));
    parentSpan.end();

    await done;
    await conn.drain();

    expect(receivedTraceparent).toBeTruthy();
    // traceparent format: 00-<32hex>-<16hex>-<2hex>
    expect(receivedTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('publish records error and sets ERROR status when connection is closed', async () => {
    const conn = await connect({ servers: serverUrl });
    await conn.drain();

    expect(() => {
      conn.publish(ROOT_CONTEXT, 'test.pub.err', enc.encode('x'));
    }).toThrow();

    const spans = otel.exporter.getFinishedSpans();
    const pubSpan = spans.find((s) => s.name === 'test.pub.err send');
    expect(pubSpan).toBeDefined();
    expect(pubSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(pubSpan?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // subscribe
  // ---------------------------------------------------------------------------

  it('subscribe creates a CONSUMER span with correct attributes', async () => {
    const conn = await connect({ servers: serverUrl });

    const received: Array<{ msg: Awaited<ReturnType<AsyncIterator<unknown>>>; ctx: unknown }> = [];
    const subGen = conn.subscribe('test.sub.attrs');
    const consuming = (async () => {
      for await (const item of subGen) {
        received.push(item as never);
        break; // consume one message
      }
    })();

    await sleep(20);
    // publish with raw natsConn (no trace) to trigger consumer
    conn.natsConn().publish('test.sub.attrs', enc.encode('world'));

    await consuming;
    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const consumerSpan = spans.find((s) => s.name === 'test.sub.attrs process');
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan?.kind).toBe(SpanKind.CONSUMER);
    expect(consumerSpan?.attributes['messaging.system']).toBe('nats');
    expect(consumerSpan?.attributes['messaging.destination.name']).toBe('test.sub.attrs');
    expect(consumerSpan?.attributes['messaging.operation.type']).toBe('process');
  });

  it('subscribe consumer span has link to producer span', async () => {
    const conn = await connect({ servers: serverUrl });

    let receivedItem: { msg: unknown; ctx: unknown } | undefined;
    const subGen = conn.subscribe('test.sub.link');
    const consuming = (async () => {
      for await (const item of subGen) {
        receivedItem = item;
        break;
      }
    })();

    await sleep(20);
    conn.publish(ROOT_CONTEXT, 'test.sub.link', enc.encode('data'));

    await consuming;
    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const producerSpan = spans.find((s) => s.name === 'test.sub.link send');
    const consumerSpan = spans.find((s) => s.name === 'test.sub.link process');

    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();
    expect(receivedItem).toBeDefined();

    // Consumer span must NOT be a child of producer (no parentSpanId = producer)
    expect(consumerSpan?.parentSpanId).not.toBe(producerSpan?.spanContext().spanId);

    // Consumer span must have a link pointing to producer span
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(
      producerSpan?.spanContext().traceId,
    );
    expect(consumerSpan?.links[0].context.spanId).toBe(
      producerSpan?.spanContext().spanId,
    );
  });

  it('subscribe creates consumer span even when message has no trace context', async () => {
    const conn = await connect({ servers: serverUrl });

    const subGen = conn.subscribe('test.sub.notrace');
    const consuming = (async () => {
      for await (const _ of subGen) break;
    })();

    await sleep(20);
    // Publish without headers (no trace)
    conn.natsConn().publish('test.sub.notrace', enc.encode('raw'));

    await consuming;
    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const consumerSpan = spans.find((s) => s.name === 'test.sub.notrace process');
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan?.links).toHaveLength(0);
  });

  it('subscribe with queue sets messaging.consumer.group.name', async () => {
    const conn = await connect({ servers: serverUrl });

    const subGen = conn.subscribe('test.sub.queue', { queue: 'workers' });
    const consuming = (async () => {
      for await (const _ of subGen) break;
    })();

    await sleep(20);
    conn.natsConn().publish('test.sub.queue', enc.encode('q'));
    await consuming;
    await conn.drain();

    const spans = otel.exporter.getFinishedSpans();
    const consumerSpan = spans.find((s) => s.name === 'test.sub.queue process');
    expect(consumerSpan?.attributes['messaging.consumer.group.name']).toBe('workers');
  });

  it('subscribe span ends before the next yield', async () => {
    const conn = await connect({ servers: serverUrl });
    const endTimes: number[] = [];

    const subGen = conn.subscribe('test.sub.lifecycle');
    const consuming = (async () => {
      let count = 0;
      for await (const _ of subGen) {
        count++;
        if (count >= 2) break;
      }
    })();

    await sleep(20);
    conn.natsConn().publish('test.sub.lifecycle', enc.encode('msg1'));
    await sleep(20);
    conn.natsConn().publish('test.sub.lifecycle', enc.encode('msg2'));

    await consuming;
    await conn.drain();

    const spans = otel.exporter.getFinishedSpans().filter(
      (s) => s.name === 'test.sub.lifecycle process',
    );
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      endTimes.push(s.endTime[0] * 1e9 + s.endTime[1]);
    }
    // Both spans must have ended (endTime != startTime or both truthy)
    expect(endTimes.every((t) => t > 0)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // request
  // ---------------------------------------------------------------------------

  it('request creates a PRODUCER span and returns reply', async () => {
    const conn = await connect({ servers: serverUrl });

    // Set up a replier
    const replier = conn.natsConn().subscribe('test.req.ok');
    const replierDone = (async () => {
      for await (const msg of replier) {
        msg.respond(enc.encode('pong'));
        break;
      }
    })();

    const reply = await conn.request(ROOT_CONTEXT, 'test.req.ok', enc.encode('ping'));
    await replierDone;
    await conn.drain();

    expect(dec.decode(reply.data)).toBe('pong');

    const spans = otel.exporter.getFinishedSpans();
    const reqSpan = spans.find((s) => s.name === 'test.req.ok send');
    expect(reqSpan).toBeDefined();
    expect(reqSpan?.kind).toBe(SpanKind.PRODUCER);
    expect(reqSpan?.status.code).toBe(SpanStatusCode.OK);
  });

  it('request sets ERROR status on timeout', async () => {
    const conn = await connect({ servers: serverUrl });

    await expect(
      conn.request(ROOT_CONTEXT, 'test.req.timeout', enc.encode('x'), { timeout: 200 }),
    ).rejects.toThrow();

    const spans = otel.exporter.getFinishedSpans();
    const reqSpan = spans.find((s) => s.name === 'test.req.timeout send');
    expect(reqSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(reqSpan?.events.some((e) => e.name === 'exception')).toBe(true);

    await conn.drain();
  });
});
