import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { connect } from '../../src/index.js';
import { startNatsContainer, setupOTel, sleep } from './helpers.js';

const enc = new TextEncoder();

describe('[integration] Conn (core NATS)', () => {
  let serverUrl: string;
  let stopContainer: () => Promise<void>;
  let otel: ReturnType<typeof setupOTel>;

  beforeAll(async () => {
    const c = await startNatsContainer();
    serverUrl = c.url;
    stopContainer = c.stop;
  });

  afterAll(async () => {
    await stopContainer();
  });

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  it('publish → subscribe: traceparent propagates end-to-end', async () => {
    const conn = await connect({ servers: serverUrl });

    const tracer = otel.provider.getTracer('test');
    const rootSpan = tracer.startSpan('test-root', {}, ROOT_CONTEXT);
    const rootCtx = trace.setSpan(ROOT_CONTEXT, rootSpan);
    const expectedTraceId = rootSpan.spanContext().traceId;
    rootSpan.end();

    let receivedTraceId: string | undefined;
    const sub = conn.subscribe('integration.core.pub-sub');
    const consuming = (async () => {
      for await (const { ctx } of sub) {
        const span = trace.getSpan(ctx);
        receivedTraceId = span?.spanContext().traceId;
        break;
      }
    })();

    await sleep(20);
    conn.publish(rootCtx, 'integration.core.pub-sub', enc.encode('hello'));

    await consuming;
    await conn.drain();

    // The consumer span links back to the producer, which is in the same trace as rootSpan
    const spans = otel.exporter.getFinishedSpans();
    const producerSpan = spans.find((s) => s.name === 'integration.core.pub-sub send');
    const consumerSpan = spans.find((s) => s.name === 'integration.core.pub-sub process');

    expect(producerSpan).toBeDefined();
    expect(consumerSpan).toBeDefined();
    expect(producerSpan?.spanContext().traceId).toBe(expectedTraceId);
    // Consumer span links to producer
    expect(consumerSpan?.links).toHaveLength(1);
    expect(consumerSpan?.links[0].context.traceId).toBe(expectedTraceId);
    expect(consumerSpan?.links[0].context.spanId).toBe(producerSpan?.spanContext().spanId);
    expect(receivedTraceId).toBeDefined();
  }, 30_000);

  it('request → reply: trace context injected into request headers', async () => {
    const conn = await connect({ servers: serverUrl });

    const replier = conn.natsConn().subscribe('integration.core.req');
    const replierDone = (async () => {
      for await (const msg of replier) {
        // Echo the traceparent back in the reply so we can verify
        msg.respond(msg.headers ? enc.encode(msg.headers.get('traceparent') ?? '') : enc.encode(''));
        break;
      }
    })();

    const reply = await conn.request(ROOT_CONTEXT, 'integration.core.req', enc.encode('ping'));
    await replierDone;
    await conn.drain();

    const echoed = new TextDecoder().decode(reply.data);
    expect(echoed).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const spans = otel.exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'integration.core.req send' && s.kind === SpanKind.PRODUCER)).toBe(true);
  }, 30_000);
});
