/**
 * Integration flows mirror upstream nats.js docs, with `connect` from this package:
 * - TCP: `@nats-io/transport-node` — `import { connect } from "@nats-io/transport-node"`
 *   → `import { connect } from "@marz32one/otel-nats"` and `connect({ servers })`.
 * - Core pub/sub & request: `@nats-io/nats-core` patterns (subscribe iterator or
 *   `subscribe(subject, { callback })`, `publish`, `request`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { connect, getMessageTraceContext } from '../../src/index.js';
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
      for await (const msg of sub) {
        const ctx = getMessageTraceContext(msg);
        const span = ctx ? trace.getSpan(ctx) : undefined;
        receivedTraceId = span?.spanContext().traceId;
        break;
      }
    })();

    await sleep(20);
    conn.publish('integration.core.pub-sub', enc.encode('hello'), { otelContext: rootCtx });

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

  it('request → reply: trace context injected into request headers (callback subscribe)', async () => {
    const conn = await connect({ servers: serverUrl });

    conn.subscribe('integration.core.req', {
      callback: (_err, msg) => {
        if (!msg) return;
        msg.respond(msg.headers ? enc.encode(msg.headers.get('traceparent') ?? '') : enc.encode(''));
      },
    });

    const reply = await conn.request('integration.core.req', enc.encode('ping'), {
      timeout: 5000,
      otelContext: ROOT_CONTEXT,
    });
    await conn.drain();

    const echoed = new TextDecoder().decode(reply.data);
    expect(echoed).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const spans = otel.exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'integration.core.req send' && s.kind === SpanKind.PRODUCER)).toBe(true);
    expect(spans.some((s) => s.name === 'integration.core.req process')).toBe(true);
  }, 30_000);
});
