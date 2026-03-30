import {
  Context,
  Span,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  defaultTextMapGetter,
  defaultTextMapSetter,
  diag,
  propagation,
  trace,
} from '@opentelemetry/api';
import BaseWebSocket from 'ws';

import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  deserializeMessage,
  injectTrace,
} from './message.js';
import { getTracerProvider } from './options.js';
import { version } from './version.js';

type WsMessageEvent = Parameters<BaseWebSocket['on']>[0];
type WsListener = (...args: unknown[]) => void;
type WsWithInternals = BaseWebSocket & {
  _sender?: {
    sendFrame?: (list: ReadonlyArray<Buffer>, cb?: (err?: Error) => void) => void;
  };
};

const PATCHED_SYMBOL = Symbol.for('@marz32one/otel-ws/patched');
const ORIGINAL_ON_SYMBOL = Symbol.for('@marz32one/otel-ws/original-on');
const ORIGINAL_OFF_SYMBOL = Symbol.for('@marz32one/otel-ws/original-off');
const ORIGINAL_SEND_SYMBOL = Symbol.for('@marz32one/otel-ws/original-send');
const WRAPPED_HANDLERS_SYMBOL = Symbol.for('@marz32one/otel-ws/wrapped-handlers');
const ORIGINAL_SEND_FRAME_SYMBOL = Symbol.for('@marz32one/otel-ws/original-send-frame');
export default class OtelWebSocket extends BaseWebSocket {
  constructor(address: string, protocols?: string | string[], options?: BaseWebSocket.ClientOptions) {
    super(address, protocols, options);
    instrumentSocket(this);
  }
}

export function instrumentSocket(ws: BaseWebSocket): BaseWebSocket {
  const tracer = getTracerProvider().getTracer('@marz32one/otel-ws', version());
  patchNativeApis(ws, tracer);
  // _sender is available after connect in some ws versions.
  ws.once('open', () => patchNativeSendFrame(ws, tracer));
  return ws;
}

function serializeWithActiveTrace(
  data: unknown,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>,
): { serialized?: string; span?: Span; error?: Error } {
  const activeCtx = otelContext.active();
  const span = tracer.startSpan(
    'websocket.send',
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': 'websocket',
        'messaging.operation': 'send',
      },
    },
    activeCtx,
  );
  const spanCtx = trace.setSpan(activeCtx, span);

  try {
    const carrier: Record<string, string> = {};
    propagation.inject(spanCtx, carrier, defaultTextMapSetter);
    return { serialized: JSON.stringify(injectTrace(data, carrier)), span };
  } catch (err) {
    const error = err as Error;
    diag.error('[otel-ws] websocket.send: serialization failed', { error: error.message });
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
    return { error };
  }
}

function finishSendSpan(span: Span, sendErr?: Error, cb?: (err?: Error) => void): void {
  if (sendErr) {
    diag.error('[otel-ws] websocket.send: send failed', { error: sendErr.message });
    span.recordException(sendErr);
    span.setStatus({ code: SpanStatusCode.ERROR, message: sendErr.message });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
  cb?.(sendErr);
}

function withExtractedReceiveContext(
  raw: BaseWebSocket.Data,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>,
  run: (data: unknown, outCtx: Context) => void,
): void {
  const body =
    typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw.toString();
  const parsed = deserializeMessage(body);

  const carrier: Record<string, string> = {};
  if (parsed.traceparent) carrier[TRACEPARENT_HEADER] = parsed.traceparent;
  if (parsed.tracestate) carrier[TRACESTATE_HEADER] = parsed.tracestate;

  const hasTrace = Object.keys(carrier).length > 0;
  const baseCtx = otelContext.active();
  const senderCtx = hasTrace
    ? propagation.extract(baseCtx, carrier, defaultTextMapGetter)
    : baseCtx;

  const span = tracer.startSpan(
    'websocket.receive',
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'websocket',
        'messaging.operation': 'receive',
      },
    },
    senderCtx,
  );
  const outCtx = trace.setSpan(senderCtx, span);
  span.end();
  otelContext.with(outCtx, () => run(parsed.data, outCtx));
}

function patchNativeApis(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>,
): void {
  const wsAny = ws as BaseWebSocket & { [PATCHED_SYMBOL]?: boolean };
  if (wsAny[PATCHED_SYMBOL]) return;
  wsAny[PATCHED_SYMBOL] = true;

  patchNativeOnMessage(ws, tracer);
  patchNativeSend(ws, tracer);
  patchNativeSendFrame(ws, tracer);
}

function patchNativeOnMessage(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>,
): void {
  const wsAny = ws as BaseWebSocket & {
    [ORIGINAL_ON_SYMBOL]?: BaseWebSocket['on'];
    [ORIGINAL_OFF_SYMBOL]?: BaseWebSocket['off'];
    [WRAPPED_HANDLERS_SYMBOL]?: WeakMap<WsListener, WsListener>;
  };

  if (!wsAny[ORIGINAL_ON_SYMBOL]) {
    wsAny[ORIGINAL_ON_SYMBOL] = ws.on.bind(ws);
  }
  if (!wsAny[ORIGINAL_OFF_SYMBOL]) {
    wsAny[ORIGINAL_OFF_SYMBOL] = ws.off.bind(ws);
  }
  if (!wsAny[WRAPPED_HANDLERS_SYMBOL]) {
    wsAny[WRAPPED_HANDLERS_SYMBOL] = new WeakMap<WsListener, WsListener>();
  }

  const originalOn = wsAny[ORIGINAL_ON_SYMBOL]!;
  const originalOff = wsAny[ORIGINAL_OFF_SYMBOL]!;
  const wrappedHandlers = wsAny[WRAPPED_HANDLERS_SYMBOL]!;
  ws.on = ((event: WsMessageEvent, listener: WsListener) => {
    if (event !== 'message' || typeof listener !== 'function') {
      return originalOn(event, listener as never);
    }

    let wrapped = wrappedHandlers.get(listener);
    if (!wrapped) {
      wrapped = ((raw: BaseWebSocket.Data, isBinary?: boolean) => {
        withExtractedReceiveContext(raw, tracer, (data) => {
          (listener as (data: unknown, isBinary?: boolean) => void)(data, isBinary);
        });
      }) as WsListener;
      wrappedHandlers.set(listener, wrapped);
    }

    return originalOn(event, wrapped as never);
  }) as BaseWebSocket['on'];

  ws.off = ((event: WsMessageEvent, listener: WsListener) => {
    if (event !== 'message' || typeof listener !== 'function') {
      return originalOff(event, listener as never);
    }
    const wrapped = wrappedHandlers.get(listener);
    return originalOff(event, (wrapped ?? listener) as never);
  }) as BaseWebSocket['off'];
}

function patchNativeSend(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>,
): void {
  const wsAny = ws as BaseWebSocket & {
    [ORIGINAL_SEND_SYMBOL]?: BaseWebSocket['send'];
  };
  if (wsAny[ORIGINAL_SEND_SYMBOL]) return;
  wsAny[ORIGINAL_SEND_SYMBOL] = ws.send.bind(ws);
  const originalSend = wsAny[ORIGINAL_SEND_SYMBOL]!;

  ws.send = ((data: unknown, optionsOrCb?: unknown, cbMaybe?: unknown) => {
    const payload = serializeWithActiveTrace(data, tracer);
    if (!payload.serialized || !payload.span) {
      const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : cbMaybe) as ((err?: Error) => void) | undefined;
      cb?.(payload.error);
      return;
    }

    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : cbMaybe) as ((err?: Error) => void) | undefined;
    if (typeof optionsOrCb === 'function' || optionsOrCb === undefined) {
      return originalSend(payload.serialized, (sendErr?: Error) => finishSendSpan(payload.span!, sendErr, cb));
    }
    return originalSend(
      payload.serialized,
      optionsOrCb as never,
      (sendErr?: Error) => finishSendSpan(payload.span!, sendErr, cb),
    );
  }) as BaseWebSocket['send'];
}

function patchNativeSendFrame(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>,
): void {
  const withInternals = ws as WsWithInternals & {
    [ORIGINAL_SEND_FRAME_SYMBOL]?: (list: ReadonlyArray<Buffer>, cb?: (err?: Error) => void) => void;
  };
  const sender = withInternals._sender;
  if (!sender || typeof sender.sendFrame !== 'function') {
    diag.debug('[otel-ws] _sender.sendFrame unavailable, skip patch');
    return;
  }
  if (withInternals[ORIGINAL_SEND_FRAME_SYMBOL]) return;

  withInternals[ORIGINAL_SEND_FRAME_SYMBOL] = sender.sendFrame.bind(sender);
  const originalSendFrame = withInternals[ORIGINAL_SEND_FRAME_SYMBOL]!;

  sender.sendFrame = (list: ReadonlyArray<Buffer>, cb?: (err?: Error) => void) => {
    const activeCtx = otelContext.active();
    const span = tracer.startSpan(
      'websocket.send',
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'websocket',
          'messaging.operation': 'send',
        },
      },
      activeCtx,
    );
    const spanCtx = trace.setSpan(activeCtx, span);
    const patched = injectTraceIntoFrames(list, spanCtx);

    return originalSendFrame(patched, (sendErr?: Error) => {
      finishSendSpan(span, sendErr, cb);
    });
  };
}

function injectTraceIntoFrames(list: ReadonlyArray<Buffer>, injectCtx: Context): ReadonlyArray<Buffer> {
  const carrier: Record<string, string> = {};
  propagation.inject(injectCtx, carrier, defaultTextMapSetter);
  return list.map((frame) => injectTraceIntoSingleFrame(frame, carrier));
}

function injectTraceIntoSingleFrame(frame: Buffer, carrier: Record<string, string>): Buffer {
  if (frame.length < 2) return frame;

  const byte0 = frame[0];
  const opcode = byte0 & 0x0f;
  if (opcode !== 0x1) return frame; // text frame only

  const byte1 = frame[1];
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (frame.length < offset + 2) return frame;
    payloadLen = frame.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (frame.length < offset + 8) return frame;
    const longLen = Number(frame.readBigUInt64BE(offset));
    if (!Number.isSafeInteger(longLen)) return frame;
    payloadLen = longLen;
    offset += 8;
  }

  let maskKey: Buffer | undefined;
  if (masked) {
    if (frame.length < offset + 4) return frame;
    maskKey = frame.subarray(offset, offset + 4);
    offset += 4;
  }
  if (frame.length < offset + payloadLen) return frame;

  const payload = frame.subarray(offset, offset + payloadLen);
  const unmasked = masked && maskKey ? xorMask(payload, maskKey) : Buffer.from(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unmasked.toString('utf8')) as unknown;
  } catch {
    return frame;
  }

  const injected = injectTrace(parsed, carrier);
  const injectedText = JSON.stringify(injected);
  const injectedPayload = Buffer.from(injectedText, 'utf8');
  return buildFrame(byte0, masked, maskKey, injectedPayload);
}

function xorMask(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i += 1) {
    out[i] ^= maskKey[i % 4];
  }
  return out;
}

function buildFrame(byte0: number, masked: boolean, maskKey: Buffer | undefined, payload: Buffer): Buffer {
  const extLen: Buffer[] = [];
  let lenByte = payload.length;
  if (payload.length >= 126 && payload.length <= 0xffff) {
    lenByte = 126;
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(payload.length, 0);
    extLen.push(b);
  } else if (payload.length > 0xffff) {
    lenByte = 127;
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64BE(BigInt(payload.length), 0);
    extLen.push(b);
  }

  const header = Buffer.from([byte0, (masked ? 0x80 : 0x00) | lenByte]);
  if (!masked || !maskKey) {
    return Buffer.concat([header, ...extLen, payload]);
  }

  const maskedPayload = xorMask(payload, maskKey);
  return Buffer.concat([header, ...extLen, maskKey, maskedPayload]);
}
