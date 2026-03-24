import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import {
  extractMessageContext,
  parseIncomingMessage,
  traceIdFromTraceparent,
} from '../src/browser';
import { canonicalTraceHeaders, marshalEnvelope, unmarshalEnvelope } from '../src/message';

describe('browser parser', () => {
  it('parses envelope payload and trace headers', () => {
    const payload = Buffer.from(JSON.stringify({ body: 'hello', api: 'Consume' })).toString(
      'base64',
    );
    const raw = JSON.stringify({
      headers: {
        traceparent: '00-12345678901234567890123456789012-0123456789012345-01',
        tracestate: 'k=v',
      },
      payload,
    });

    const parsed = parseIncomingMessage(raw);
    expect(parsed.format).toBe('envelope');
    expect(parsed.body).toBe('hello');
    expect(parsed.api).toBe('Consume');
    expect(parsed.displayText).toBe('hello [Consume]');
    expect(parsed.traceId).toBe('12345678901234567890123456789012');
    expect(parsed.carrier.traceparent).toBe(
      '00-12345678901234567890123456789012-0123456789012345-01',
    );
  });

  it('handles payload that is not json object', () => {
    const raw = JSON.stringify({
      headers: {
        traceparent: '00-12345678901234567890123456789012-0123456789012345-01',
      },
      payload: 'hello',
    });

    const parsed = parseIncomingMessage(raw);
    expect(parsed.format).toBe('envelope');
    expect(parsed.body.length).toBeGreaterThan(0);
    expect(parsed.displayText).toBe(parsed.body);
  });

  it('parses legacy format', () => {
    const raw = JSON.stringify({
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      tracestate: 'foo=bar',
      body: 'legacy text',
      api: 'Messages',
    });
    const parsed = parseIncomingMessage(raw);
    expect(parsed.format).toBe('legacy');
    expect(parsed.displayText).toBe('legacy text [Messages]');
    expect(parsed.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(parsed.carrier.traceparent).toBeTruthy();
  });

  it('returns plain format for non-json', () => {
    const parsed = parseIncomingMessage('plain message');
    expect(parsed.format).toBe('plain');
    expect(parsed.displayText).toBe('plain message');
    expect(parsed.traceId).toBeNull();
    expect(parsed.carrier).toEqual({});
  });

  it('extracts context from parsed carrier', () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const raw = JSON.stringify({
      traceparent: '00-12345678901234567890123456789012-0123456789012345-01',
      body: 'legacy text',
    });
    const parsed = parseIncomingMessage(raw);
    const out = extractMessageContext(parsed, context.active());
    const sc = trace.getSpanContext(out);

    expect(sc).toBeDefined();
    expect(sc?.traceId).toBe('12345678901234567890123456789012');
  });

  it('parses trace id helper', () => {
    expect(
      traceIdFromTraceparent('00-12345678901234567890123456789012-0123456789012345-01'),
    ).toBe('12345678901234567890123456789012');
    expect(traceIdFromTraceparent('invalid')).toBeNull();
  });

  it('keeps only canonical trace headers in envelope', () => {
    const encoded = marshalEnvelope(
      {
        traceparent: '00-12345678901234567890123456789012-0123456789012345-01',
        tracestate: 'k=v',
        baggage: 'a=b',
        custom: 'x',
      },
      Buffer.from('hello'),
    );
    const env = unmarshalEnvelope(encoded);
    expect(env).toBeTruthy();
    expect(env?.headers.traceparent).toBeTruthy();
    expect(env?.headers.tracestate).toBeTruthy();
    expect(env?.headers.baggage).toBeUndefined();
    expect(env?.headers.custom).toBeUndefined();
  });

  it('normalizes header casing to lowercase canonical keys', () => {
    const headers = canonicalTraceHeaders({
      TraceParent: '00-12345678901234567890123456789012-0123456789012345-01',
      TRACESTATE: 'k=v',
    });
    expect(headers.traceparent).toBeTruthy();
    expect(headers.tracestate).toBeTruthy();
  });
});
