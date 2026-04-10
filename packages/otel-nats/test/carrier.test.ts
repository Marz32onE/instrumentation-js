import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT, SpanKind, propagation, trace } from '@opentelemetry/api';
import { headers } from '@nats-io/nats-core';
import type { NatsHdrs } from '../src/carrier.js';
import { natsHeaderGetter, natsHeaderSetter } from '../src/carrier.js';
import { setupOTel } from './helpers.js';

function asNatsHdrs(h: ReturnType<typeof headers>): NatsHdrs {
  return h as unknown as NatsHdrs;
}

describe('carrier', () => {
  let otel: ReturnType<typeof setupOTel>;

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  it('inject writes traceparent into nats headers', () => {
    const tracer = otel.provider.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.CLIENT }, ROOT_CONTEXT);
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    span.end();

    const hdrs = headers();
    propagation.inject(ctx, asNatsHdrs(hdrs), natsHeaderSetter);

    const traceparent = hdrs.get('traceparent');
    expect(traceparent).toBeTruthy();
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('extract restores trace context from nats headers', () => {
    const tracer = otel.provider.getTracer('test');
    const span = tracer.startSpan('producer', { kind: SpanKind.PRODUCER }, ROOT_CONTEXT);
    const spanCtx = span.spanContext();
    const ctx = trace.setSpan(ROOT_CONTEXT, span);
    span.end();

    const hdrs = headers();
    propagation.inject(ctx, asNatsHdrs(hdrs), natsHeaderSetter);

    const extracted = propagation.extract(ROOT_CONTEXT, asNatsHdrs(hdrs), natsHeaderGetter);
    const extractedSpanCtx = trace.getSpanContext(extracted);

    expect(extractedSpanCtx?.traceId).toBe(spanCtx.traceId);
    expect(extractedSpanCtx?.spanId).toBe(spanCtx.spanId);
    expect(extractedSpanCtx?.isRemote).toBe(true);
  });

  it('get returns undefined when header is absent', () => {
    const hdrs = headers();
    const result = natsHeaderGetter.get(asNatsHdrs(hdrs), 'traceparent');
    expect(result).toBeUndefined();
  });

  it('set then get round-trips the value', () => {
    const hdrs = headers();
    natsHeaderSetter.set(
      asNatsHdrs(hdrs),
      'traceparent',
      '00-aabbccddeeff00112233445566778899-0011223344556677-01',
    );
    const v = natsHeaderGetter.get(asNatsHdrs(hdrs), 'traceparent');
    expect(v).toBe('00-aabbccddeeff00112233445566778899-0011223344556677-01');
  });

  it('keys returns all header keys that have been set', () => {
    const hdrs = headers();
    natsHeaderSetter.set(asNatsHdrs(hdrs), 'traceparent', '00-aabb-0011-01');
    natsHeaderSetter.set(asNatsHdrs(hdrs), 'tracestate', 'vendor=value');

    const keys = natsHeaderGetter.keys(asNatsHdrs(hdrs));
    expect(keys).toContain('traceparent');
    expect(keys).toContain('tracestate');
  });
});
