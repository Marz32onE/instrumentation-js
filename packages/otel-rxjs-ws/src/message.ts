export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/** Embedded wire format: trace context fields alongside `data` (rxjs / Go WriteMessage). */
export interface WireMessage<T = unknown> {
  traceparent?: string;
  tracestate?: string;
  data: T;
}

/** Header-style envelope (Go ReadMessage compat): headers map + base64 payload. */
export interface Envelope {
  headers: Record<string, string>;
  payload: string;
}

/** Result of parsing an incoming wire message. */
export interface ParsedWireMessage<T = unknown> {
  data: T;
  traceparent?: string;
  tracestate?: string;
}

/**
 * Deserialize an incoming message:
 *
 * 1. Embedded: `{ traceparent?, tracestate?, data }`
 * 2. Header-style: `{ headers: { traceparent?, … }, payload: "<base64>" }`
 * 3. Other JSON or non-JSON → whole value / string as `data` (no trace fields)
 */
export function deserializeMessage<T = unknown>(raw: string): ParsedWireMessage<T> {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { data: parsed as unknown as T };
    }

    const obj = parsed as Record<string, unknown>;

    if ('data' in obj) {
      return {
        data: obj.data as T,
        traceparent: asString(obj[TRACEPARENT_HEADER]),
        tracestate: asString(obj[TRACESTATE_HEADER]),
      };
    }

    if (isEnvelope(obj)) {
      const headers = obj.headers as Record<string, unknown>;
      let payloadStr: string;
      try {
        payloadStr = decodeBase64(obj.payload as string);
      } catch {
        return { data: raw as unknown as T };
      }
      let data: T;
      try {
        data = JSON.parse(payloadStr) as T;
      } catch {
        data = payloadStr as unknown as T;
      }
      return {
        data,
        traceparent: asString(headers[TRACEPARENT_HEADER]),
        tracestate: asString(headers[TRACESTATE_HEADER]),
      };
    }

    return { data: obj as unknown as T };
  } catch {
    return { data: raw as unknown as T };
  }
}

/** Keep only traceparent and tracestate, lowercased. */
export function canonicalTraceHeaders(
  headers: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof headers !== 'object' || headers === null) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') continue;
    const key = k.toLowerCase();
    if (key === TRACEPARENT_HEADER || key === TRACESTATE_HEADER) {
      out[key] = v;
    }
  }
  return out;
}

/** Extract trace ID (32-hex) from a W3C traceparent string. */
export function traceIdFromTraceparent(traceparent: string): string | null {
  const parts = traceparent.trim().split('-');
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

function isEnvelope(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.headers === 'object' &&
    obj.headers !== null &&
    typeof obj.payload === 'string'
  );
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function decodeBase64(s: string): string {
  if (typeof atob === 'function') {
    try {
      return atob(s);
    } catch {
      /* fall through */
    }
  }
  if (typeof Buffer !== 'undefined') {
    try {
      return Buffer.from(s, 'base64').toString('utf8');
    } catch {
      /* fall through */
    }
  }
  throw new Error('decodeBase64: no decoder available or invalid base64 input');
}
