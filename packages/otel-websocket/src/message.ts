/**
 * Envelope is the on-wire JSON wrapper that carries both the application
 * payload and the W3C Trace Context headers so that receivers can reconstruct
 * the distributed-trace span from the caller.
 *
 * The payload field is base64-encoded to match Go's json.Marshal behaviour for
 * []byte values, which ensures cross-language compatibility with the Go version.
 */
export interface Envelope {
  /** Propagated trace-context key/value pairs (e.g. "traceparent", "tracestate"). */
  headers: Record<string, string>;
  /** Original application message body, base64-encoded. */
  payload: string;
}

export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/** Serialises headers and payload into a JSON envelope string. */
export function marshalEnvelope(
  headers: Record<string, string>,
  payload: Buffer,
): string {
  const env: Envelope = {
    headers: canonicalTraceHeaders(headers),
    payload: payload.toString('base64'),
  };
  return JSON.stringify(env);
}

/**
 * Deserialises a JSON envelope from raw bytes.  Returns null if the data is
 * not a valid envelope so that callers can fall back to plain message handling.
 */
export function unmarshalEnvelope(data: Buffer | string): Envelope | null {
  try {
    const str = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    const env = JSON.parse(str) as unknown;
    if (
      env === null ||
      typeof env !== 'object' ||
      !('headers' in env) ||
      !('payload' in env) ||
      typeof (env as Record<string, unknown>).headers !== 'object' ||
      typeof (env as Record<string, unknown>).payload !== 'string'
    ) {
      return null;
    }
    const e = env as Envelope;
    if (e.headers === null) {
      e.headers = {};
    }
    e.headers = canonicalTraceHeaders(e.headers);
    return e;
  } catch {
    return null;
  }
}

export function canonicalTraceHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof headers !== 'object' || headers === null) {
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') {
      continue;
    }
    const key = k.toLowerCase();
    if (key === TRACEPARENT_HEADER || key === TRACESTATE_HEADER) {
      out[key] = v;
    }
  }
  return out;
}
