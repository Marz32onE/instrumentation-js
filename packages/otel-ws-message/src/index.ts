import { diag } from '@opentelemetry/api';

export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/** Envelope written to the wire: trace headers are isolated in `header`, user data is in `data`. */
export interface WireEnvelope {
  header: { traceparent?: string; tracestate?: string };
  data: unknown;
}

/** Result of parsing an incoming wire message. */
export interface ParsedWireMessage<T = unknown> {
  data: T;
  traceparent?: string;
  tracestate?: string;
}

/**
 * Wrap `data` in a `{header, data}` envelope and inject trace headers.
 * Works for any payload type — objects, strings, arrays, numbers.
 */
export function buildEnvelope(data: unknown, headers: Record<string, string>): WireEnvelope {
  const header: WireEnvelope['header'] = {};
  const tp = headers[TRACEPARENT_HEADER];
  const ts = headers[TRACESTATE_HEADER];
  if (tp) header.traceparent = tp;
  if (ts) header.tracestate = ts;
  return { header, data };
}

/**
 * Deserialize an incoming wire message (envelope format).
 *
 * If the message is a `{header, data}` envelope, `traceparent` and `tracestate`
 * are extracted from `header` and `data` is returned as the payload.
 *
 * Non-envelope messages (legacy flat format, non-instrumented clients, plain text)
 * are returned as `data` with no trace fields extracted — no exception is thrown.
 */
export function deserializeMessage<T = unknown>(raw: string): ParsedWireMessage<T> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isEnvelope(parsed)) {
      return {
        data: parsed.data as T,
        traceparent: asString(parsed.header.traceparent),
        tracestate: asString(parsed.header.tracestate),
      };
    }
    diag.debug('[otel-ws-message] received non-envelope message, delivering data without trace context extraction');
    return { data: parsed as T };
  } catch (err) {
    diag.debug('[otel-ws-message] deserializeMessage: JSON.parse failed, treating as raw string', { error: String(err) });
    return { data: raw as unknown as T };
  }
}

function isEnvelope(v: unknown): v is WireEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    'header' in v &&
    'data' in v &&
    typeof (v as Record<string, unknown>).header === 'object' &&
    (v as Record<string, unknown>).header !== null
  );
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
