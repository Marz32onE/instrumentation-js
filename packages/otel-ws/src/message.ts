export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

export interface WireMessage<T = unknown> {
  traceparent?: string;
  tracestate?: string;
  data: T;
}

export interface Envelope {
  headers: Record<string, string>;
  payload: string;
}

export interface ParsedWireMessage<T = unknown> {
  data: T;
  traceparent?: string;
  tracestate?: string;
}

export function deserializeMessage<T = unknown>(raw: string): ParsedWireMessage<T> {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;

    if ('data' in obj) {
      return {
        data: obj.data as T,
        traceparent: asString(obj[TRACEPARENT_HEADER]),
        tracestate: asString(obj[TRACESTATE_HEADER]),
      };
    }

    if (isEnvelope(obj)) {
      const headers = obj.headers as Record<string, unknown>;
      const payloadStr = decodeBase64(obj.payload as string);
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
  return s;
}
