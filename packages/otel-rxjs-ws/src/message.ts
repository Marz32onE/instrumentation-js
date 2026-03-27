export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/** Result of parsing an incoming wire message. */
export interface ParsedWireMessage<T = unknown> {
  data: T;
  traceparent?: string;
  tracestate?: string;
}

/**
 * Inject trace headers into a JSON object payload (flat format).
 * Non-object payloads (string, array, etc.) are returned unchanged — no trace injection.
 */
export function injectTrace(
  data: unknown,
  headers: Record<string, string>,
): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return data;
  }
  const out = { ...(data as Record<string, unknown>) };
  const tp = headers[TRACEPARENT_HEADER];
  const ts = headers[TRACESTATE_HEADER];
  if (tp) out[TRACEPARENT_HEADER] = tp;
  if (ts) out[TRACESTATE_HEADER] = ts;
  return out;
}

/**
 * Deserialize an incoming wire message (flat format).
 *
 * If the message is a JSON object, `traceparent` and `tracestate` are extracted
 * and the remaining fields are returned as `data`.
 * Any other value (string, array, non-JSON) is returned as `data` with no trace fields.
 */
export function deserializeMessage<T = unknown>(raw: string): ParsedWireMessage<T> {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { data: parsed as unknown as T };
    }

    const obj = parsed as Record<string, unknown>;
    const traceparent = asString(obj[TRACEPARENT_HEADER]);
    const tracestate = asString(obj[TRACESTATE_HEADER]);

    // Return data without trace fields
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k !== TRACEPARENT_HEADER && k !== TRACESTATE_HEADER) {
        rest[k] = v;
      }
    }

    return { data: rest as unknown as T, traceparent, tracestate };
  } catch {
    return { data: raw as unknown as T };
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
