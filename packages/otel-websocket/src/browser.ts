import {
  Context,
  TextMapPropagator,
  context,
  defaultTextMapGetter,
  propagation,
} from '@opentelemetry/api';
import { TRACEPARENT_HEADER, TRACESTATE_HEADER, canonicalTraceHeaders } from './message';

export type IncomingMessageFormat = 'envelope' | 'legacy' | 'plain';

export interface ParsedIncomingMessage {
  format: IncomingMessageFormat;
  body: string;
  api?: string;
  displayText: string;
  traceId: string | null;
  traceparent?: string;
  tracestate?: string;
  carrier: Record<string, string>;
}

type AppPayload = {
  body?: unknown;
  api?: unknown;
};

/**
 * Browser-safe parser for WebSocket message payloads.
 * Supports both Go-compatible envelope and legacy payload formats.
 */
export function parseIncomingMessage(raw: string): ParsedIncomingMessage {
  const plain = asPlain(raw);

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fromEnvelope = parseEnvelope(parsed);
    if (fromEnvelope) {
      return fromEnvelope;
    }
    const fromLegacy = parseLegacy(parsed);
    if (fromLegacy) {
      return fromLegacy;
    }
  } catch {
    return plain;
  }

  return plain;
}

/**
 * Extract OTel context from parsed message headers.
 */
export function extractMessageContext(
  message: ParsedIncomingMessage,
  baseCtx: Context = context.active(),
  propagator?: TextMapPropagator,
): Context {
  if (Object.keys(message.carrier).length === 0) {
    return baseCtx;
  }
  if (propagator) {
    return propagator.extract(baseCtx, message.carrier, defaultTextMapGetter);
  }
  return propagation.extract(baseCtx, message.carrier);
}

export function traceIdFromTraceparent(traceparent: string): string | null {
  const parts = traceparent.trim().split('-');
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

function parseEnvelope(parsed: Record<string, unknown>): ParsedIncomingMessage | null {
  if (!parsed.headers || typeof parsed.payload !== 'string') {
    return null;
  }
  if (typeof parsed.headers !== 'object' || parsed.headers === null) {
    return null;
  }

  const headers = parsed.headers as Record<string, unknown>;
  const payloadStr = decodePayload(parsed.payload);
  const appPayload = parseAppPayload(payloadStr);
  const body = appPayload.body ?? payloadStr;
  const displayText = appPayload.api ? `${body} [${appPayload.api}]` : body;

  const canonical = canonicalTraceHeaders(headers);
  const traceparent = stringValue(canonical[TRACEPARENT_HEADER]);
  const tracestate = stringValue(canonical[TRACESTATE_HEADER]);
  const carrier: Record<string, string> = {};
  if (traceparent) {
    carrier[TRACEPARENT_HEADER] = traceparent;
  }
  if (tracestate) {
    carrier[TRACESTATE_HEADER] = tracestate;
  }

  return {
    format: 'envelope',
    body,
    api: appPayload.api,
    displayText,
    traceId: traceparent ? traceIdFromTraceparent(traceparent) : null,
    traceparent,
    tracestate,
    carrier,
  };
}

function parseLegacy(parsed: Record<string, unknown>): ParsedIncomingMessage | null {
  if (typeof parsed.traceparent !== 'string' || parsed.body === undefined) {
    return null;
  }

  const body = String(parsed.body);
  const api = parsed.api === undefined ? undefined : String(parsed.api);
  const displayText = api ? `${body} [${api}]` : body;
  const traceparent = parsed.traceparent;
  const tracestate = parsed.tracestate === undefined ? undefined : String(parsed.tracestate ?? '');
  const carrier: Record<string, string> = {
    [TRACEPARENT_HEADER]: traceparent,
  };
  if (tracestate) {
    carrier[TRACESTATE_HEADER] = tracestate;
  }

  return {
    format: 'legacy',
    body,
    api,
    displayText,
    traceId: traceIdFromTraceparent(traceparent),
    traceparent,
    tracestate,
    carrier,
  };
}

function parseAppPayload(input: string): { body: string; api?: string } {
  try {
    const payload = JSON.parse(input) as AppPayload;
    const body = payload.body === undefined ? input : String(payload.body);
    const api = payload.api === undefined ? undefined : String(payload.api);
    return { body, api };
  } catch {
    return { body: input };
  }
}

function decodePayload(payload: string): string {
  try {
    if (typeof atob === 'function') {
      return atob(payload);
    }
  } catch {
    // fall through
  }
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(payload, 'base64').toString('utf8');
    }
  } catch {
    // fall through
  }
  return payload;
}

function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asPlain(raw: string): ParsedIncomingMessage {
  return {
    format: 'plain',
    body: raw,
    displayText: raw,
    traceId: null,
    carrier: {},
  };
}
