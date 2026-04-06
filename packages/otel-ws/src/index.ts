import type { IncomingMessage } from "http";
import { EventEmitter } from "events";
import {
  Context,
  Span,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  createContextKey,
  defaultTextMapGetter,
  defaultTextMapSetter,
  diag,
  propagation,
  trace,
} from "@opentelemetry/api";
import BaseWebSocket from "ws";

import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  buildEnvelope,
  deserializeMessage,
} from "./wire-message.js";
import { getTracerProvider } from "./options.js";
import { version } from "./version.js";

const OTEL_WS_PROTOCOL = "otel-ws";
/** Defensive / non-RFC wire prefix; negotiated subprotocol is usually bare `Pi` or `otel-ws`. */
const OTEL_WS_INSTRUMENTED_PREFIX = `${OTEL_WS_PROTOCOL}+`;

const ORIGINAL_ON_SYMBOL = Symbol.for("@marz32one/otel-ws/original-on");
const ORIGINAL_OFF_SYMBOL = Symbol.for("@marz32one/otel-ws/original-off");
const ORIGINAL_SEND_SYMBOL = Symbol.for("@marz32one/otel-ws/original-send");
const WRAPPED_HANDLERS_SYMBOL = Symbol.for(
  "@marz32one/otel-ws/wrapped-handlers",
);
const ORIGINAL_SEND_FRAME_SYMBOL = Symbol.for(
  "@marz32one/otel-ws/original-send-frame",
);
const OTEL_ACTIVE_SYMBOL = Symbol.for("@marz32one/otel-ws/otel-active");
/** User subprotocols offered after `otel-ws` (used to enable envelope when server returns bare `Pi`). */
const USER_PROTO_LIST_SYMBOL = Symbol.for("@marz32one/otel-ws/user-proto-list");

// Prevents patchNativeSendFrame from double-wrapping a message that was already
// instrumented by patchNativeSend (since send() internally calls _sender.sendFrame()).
const SKIP_FRAME_INJECT_KEY = createContextKey(
  "@marz32one/otel-ws/skip-frame-inject",
);

type WsListener = (...args: unknown[]) => void;
type WsWithInternals = BaseWebSocket & {
  _sender?: {
    sendFrame?: (
      list: ReadonlyArray<Buffer>,
      cb?: (err?: Error) => void,
    ) => void;
  };
};

type WsHandleProtocols = (
  protocols: Set<string>,
  request: IncomingMessage,
) => string | false;

type WsRecord = BaseWebSocket & Record<symbol, unknown>;

// A narrow callable alias for ws.on/ws.off when passing a general listener.
// Avoids `as never` hacks caused by TypeScript's union-overload resolution on EventEmitter.
type WsEmitGeneric = (
  event: string | symbol,
  listener: WsListener,
) => BaseWebSocket;

/**
 * Maps the on-the-wire negotiated subprotocol to the user-facing `ws.protocol`
 * (strip `otel-ws+…`, map lone `otel-ws` to empty string).
 */
export function userFacingProtocolFromWire(wire: string): string {
  if (wire.startsWith(OTEL_WS_INSTRUMENTED_PREFIX)) {
    return wire.slice(OTEL_WS_INSTRUMENTED_PREFIX.length);
  }
  if (wire === OTEL_WS_PROTOCOL) {
    return "";
  }
  return wire;
}

function firstSubprotocolFromHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (value == null) return undefined;
  const joined = Array.isArray(value) ? value.join(",") : value;
  const first = joined.split(",")[0]?.trim();
  if (!first) return undefined;
  return first.split(/\s+/)[0];
}

/**
 * Client: enable envelope only when the server explicitly acknowledged otel-ws by returning
 * "otel-ws" (bare) or the "otel-ws+<subprotocol>" prefix — NOT for bare user subprotocols.
 */
function clientEnvelopeActive(wire: string): boolean {
  return (
    wire === OTEL_WS_PROTOCOL || wire.startsWith(OTEL_WS_INSTRUMENTED_PREFIX)
  );
}

/** Negotiated subprotocol as seen on the wire (prefer `_protocol`; fall back to `protocol` getter for server sockets in some runtimes). */
function readWireSubprotocol(ws: BaseWebSocket): string {
  const direct = (ws as unknown as { _protocol?: string })._protocol;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const viaGetter = typeof ws.protocol === "string" ? ws.protocol : "";
  return viaGetter;
}

function isOtelActive(ws: BaseWebSocket): boolean {
  return (ws as WsRecord)[OTEL_ACTIVE_SYMBOL] === true;
}

function setOtelActive(ws: BaseWebSocket): void {
  (ws as WsRecord)[OTEL_ACTIVE_SYMBOL] = true;
}

function startMessagingSpan(
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
  name: "websocket.send" | "websocket.receive",
  kind: SpanKind,
  parentCtx: Context,
): Span {
  return tracer.startSpan(
    name,
    {
      kind,
      attributes: {
        "messaging.system": "websocket",
        "messaging.operation": name === "websocket.send" ? "send" : "receive",
      },
    },
    parentCtx,
  );
}

export class OtelWebSocket extends BaseWebSocket {
  constructor(
    address: string,
    protocols?: string | string[],
    options?: BaseWebSocket.ClientOptions,
  ) {
    const normalized = (
      Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
    ).filter(
      (p): p is string =>
        typeof p === "string" && p.length > 0 && p !== OTEL_WS_PROTOCOL,
    );
    const user = [...new Set(normalized)];
    if (protocols !== undefined && user.length === 0) {
      throw new Error(
        "OtelWebSocket: at least one non-empty user subprotocol is required when protocols are specified.",
      );
    }

    const offer =
      user.length === 0 ? [OTEL_WS_PROTOCOL] : [OTEL_WS_PROTOCOL, ...user];
    super(address, offer, options);
    (this as WsRecord)[USER_PROTO_LIST_SYMBOL] = user;
    (this as unknown as EventEmitter).prependOnceListener("open", () => {
      const wire = String(
        (this as unknown as { protocol?: string }).protocol ?? "",
      );
      if (
        wire === OTEL_WS_PROTOCOL ||
        wire.startsWith(OTEL_WS_INSTRUMENTED_PREFIX)
      ) {
        setOtelActive(this);
      }
      // Replace the data field with a getter. Use the captured `wire` as fallback for
      // runtimes (ws@5) that do not expose `_protocol`.
      Object.defineProperty(this, "protocol", {
        configurable: true,
        enumerable: true,
        get: () =>
          userFacingProtocolFromWire(
            (this as unknown as { _protocol?: string })._protocol ?? wire,
          ),
      });
    });
    instrumentSocket(this);
  }
}

export namespace OtelWebSocket {
  /** Instrumented WebSocket server. Mirrors WebSocket.Server from the ws package. */
  export class Server extends BaseWebSocket.Server {
    constructor(options?: BaseWebSocket.ServerOptions, callback?: () => void) {
      // ws@5 ServerOptions types model handleProtocols loosely; narrow at runtime boundary.
      const userHandleProtocols: WsHandleProtocols | undefined =
        options !== undefined && typeof options.handleProtocols === "function"
          ? (options.handleProtocols as WsHandleProtocols)
          : undefined;
      super(
        {
          ...options,
          handleProtocols(
            protocols: Set<string>,
            req: IncomingMessage,
          ): string | false {
            if (!userHandleProtocols) return false;

            const list = [...protocols];
            if (list[0] === OTEL_WS_PROTOCOL) {
              // Filter out all otel-ws sentinel tokens; pass only bare user protocols.
              // Backward-compatible: handles both new ["otel-ws","json"] and legacy ["otel-ws+json","otel-ws","json"] offers.
              const userProtos = list.filter(
                (p) =>
                  p !== OTEL_WS_PROTOCOL &&
                  !p.startsWith(OTEL_WS_INSTRUMENTED_PREFIX),
              );
              // No explicit length===0 guard: if userProtos is empty, userHandleProtocols may return
              // a protocol the client never offered; ws's own handshake validation rejects it naturally.
              const selected = userHandleProtocols(new Set(userProtos), req);
              if (selected === false) return false;
              // Signal otel-ws awareness by prefixing the selected subprotocol.
              // Client enables envelope only when it receives this prefix back.
              return `${OTEL_WS_INSTRUMENTED_PREFIX}${selected}`;
            }
            return userHandleProtocols(protocols, req);
          },
        },
        callback,
      );
      this.on("connection", (ws: BaseWebSocket, req: IncomingMessage) => {
        const first = firstSubprotocolFromHeader(
          req.headers["sec-websocket-protocol"],
        );
        // Enable envelope when client offered otel-ws (bare "otel-ws" or "otel-ws+P" prefix).
        const envelope =
          first === OTEL_WS_PROTOCOL ||
          (typeof first === "string" &&
            first.startsWith(OTEL_WS_INSTRUMENTED_PREFIX));
        instrumentSocket(ws, { envelope });
      });
    }
  }

  /**
   * Options for {@link instrumentSocket}.
   * Server path: pass `envelope: true` when the client offered `otel-ws` first.
   */
  export type InstrumentSocketOptions = {
    /**
     * When the client offer's first subprotocol token was `otel-ws`, force
     * envelope mode regardless of the negotiated bare subprotocol on `ws.protocol`.
     */
    envelope?: boolean;
  };
}

export default OtelWebSocket;

export function instrumentSocket(
  ws: BaseWebSocket,
  opts?: OtelWebSocket.InstrumentSocketOptions,
): BaseWebSocket {
  const tracer = getTracerProvider().getTracer("@marz32one/otel-ws", version());
  if (ws.readyState === BaseWebSocket.OPEN) {
    const tryActivate = (): void => {
      const wire = readWireSubprotocol(ws);
      if (opts?.envelope === true) {
        setOtelActive(ws);
      } else if (opts?.envelope === false) {
        return;
      } else if (clientEnvelopeActive(wire)) {
        setOtelActive(ws);
      }
    };
    tryActivate();
    if (!isOtelActive(ws) && opts?.envelope !== false) {
      queueMicrotask(tryActivate);
    }
    patchNativeOnMessage(ws, tracer);
    patchNativeSend(ws, tracer);
    patchNativeSendFrame(ws, tracer);
  } else {
    // Client path: patch on/off/send immediately to capture handler registrations and
    // queued sends; isOtelActive() guards the actual instrumentation behavior.
    patchNativeOnMessage(ws, tracer);
    patchNativeSend(ws, tracer);
    ws.once("open", () => {
      const wire = readWireSubprotocol(ws);
      if (opts?.envelope === true) {
        setOtelActive(ws);
      } else if (opts?.envelope !== false) {
        if (clientEnvelopeActive(wire)) setOtelActive(ws);
      }
      // _sender is available only after the connection is open.
      patchNativeSendFrame(ws, tracer);
    });
  }
  return ws;
}

function serializeWithActiveTrace(
  data: unknown,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
): { serialized?: string; span?: Span; error?: Error } {
  const activeCtx = otelContext.active();
  const span = startMessagingSpan(
    tracer,
    "websocket.send",
    SpanKind.PRODUCER,
    activeCtx,
  );
  const spanCtx = trace.setSpan(activeCtx, span);

  try {
    const carrier: Record<string, string> = {};
    propagation.inject(spanCtx, carrier, defaultTextMapSetter);
    return { serialized: JSON.stringify(buildEnvelope(data, carrier)), span };
  } catch (err) {
    const error = err as Error;
    diag.error("[otel-ws] websocket.send: serialization failed", {
      error: error.message,
    });
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
    return { error };
  }
}

function finishSendSpan(
  span: Span,
  sendErr?: Error,
  cb?: (err?: Error) => void,
): void {
  if (sendErr) {
    diag.error("[otel-ws] websocket.send: send failed", {
      error: sendErr.message,
    });
    span.recordException(sendErr);
    span.setStatus({ code: SpanStatusCode.ERROR, message: sendErr.message });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
  cb?.(sendErr);
}

function wireDataToUtf8(raw: BaseWebSocket.Data): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
      "utf8",
    );
  }
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return "";
}

function withExtractedReceiveContext(
  raw: BaseWebSocket.Data,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
  run: (data: unknown, outCtx: Context) => void,
): void {
  const body = wireDataToUtf8(raw);
  const parsed = deserializeMessage(body);

  const carrier: Record<string, string> = {};
  if (parsed.traceparent) carrier[TRACEPARENT_HEADER] = parsed.traceparent;
  if (parsed.tracestate) carrier[TRACESTATE_HEADER] = parsed.tracestate;

  const hasTrace = Object.keys(carrier).length > 0;
  const baseCtx = otelContext.active();
  const senderCtx = hasTrace
    ? propagation.extract(baseCtx, carrier, defaultTextMapGetter)
    : baseCtx;

  const span = startMessagingSpan(
    tracer,
    "websocket.receive",
    SpanKind.CONSUMER,
    senderCtx,
  );
  const outCtx = trace.setSpan(senderCtx, span);
  span.end();
  otelContext.with(outCtx, () => run(parsed.data, outCtx));
}

function withPassthroughReceiveContext(
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
  run: (outCtx: Context) => void,
): void {
  const baseCtx = otelContext.active();
  const span = startMessagingSpan(
    tracer,
    "websocket.receive",
    SpanKind.CONSUMER,
    baseCtx,
  );
  const outCtx = trace.setSpan(baseCtx, span);
  span.end();
  otelContext.with(outCtx, () => run(outCtx));
}

function patchNativeOnMessage(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
): void {
  const wsAny = ws as BaseWebSocket & {
    [ORIGINAL_ON_SYMBOL]?: BaseWebSocket["on"];
    [ORIGINAL_OFF_SYMBOL]?: BaseWebSocket["off"];
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

  const originalOn = wsAny[ORIGINAL_ON_SYMBOL] as WsEmitGeneric;
  const originalOff = wsAny[ORIGINAL_OFF_SYMBOL] as WsEmitGeneric;
  const wrappedHandlers = wsAny[WRAPPED_HANDLERS_SYMBOL];
  ws.on = ((event: string | symbol, listener: WsListener) => {
    if (event !== "message" || typeof listener !== "function") {
      return originalOn(event, listener);
    }

    let wrapped = wrappedHandlers.get(listener);
    if (!wrapped) {
      wrapped = ((raw: BaseWebSocket.Data, isBinary?: boolean) => {
        if (isOtelActive(ws)) {
          withExtractedReceiveContext(raw, tracer, (data) => {
            (listener as (data: unknown, isBinary?: boolean) => void)(
              data,
              isBinary,
            );
          });
          return;
        }

        withPassthroughReceiveContext(tracer, () => {
          (listener as (data: BaseWebSocket.Data, isBinary?: boolean) => void)(
            raw,
            isBinary,
          );
        });
      }) as WsListener;
      wrappedHandlers.set(listener, wrapped);
    }

    return originalOn(event, wrapped);
  }) as BaseWebSocket["on"];

  ws.off = ((event: string | symbol, listener: WsListener) => {
    if (event !== "message" || typeof listener !== "function") {
      return originalOff(event, listener);
    }
    const wrapped = wrappedHandlers.get(listener);
    return originalOff(event, wrapped ?? listener);
  }) as BaseWebSocket["off"];
}

function patchNativeSend(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
): void {
  const wsAny = ws as BaseWebSocket & {
    [ORIGINAL_SEND_SYMBOL]?: BaseWebSocket["send"];
  };
  if (wsAny[ORIGINAL_SEND_SYMBOL]) return;
  const originalSend = ws.send.bind(ws);
  wsAny[ORIGINAL_SEND_SYMBOL] = originalSend;

  ws.send = ((data: unknown, optionsOrCb?: unknown, cbMaybe?: unknown) => {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : cbMaybe) as
      | ((err?: Error) => void)
      | undefined;
    if (!isOtelActive(ws)) {
      const activeCtx = otelContext.active();
      const span = startMessagingSpan(
        tracer,
        "websocket.send",
        SpanKind.PRODUCER,
        activeCtx,
      );
      if (typeof optionsOrCb === "function" || optionsOrCb === undefined) {
        originalSend(data as never, (sendErr?: Error) =>
          finishSendSpan(span, sendErr, cb),
        );
      } else {
        originalSend(data as never, optionsOrCb as never, (sendErr?: Error) =>
          finishSendSpan(span, sendErr, cb),
        );
      }
      return;
    }

    const payload = serializeWithActiveTrace(data, tracer);
    if (!payload.serialized || !payload.span) {
      cb?.(payload.error);
      return;
    }

    // Set SKIP_FRAME_INJECT_KEY so the sendFrame patch knows this message was already
    // instrumented and should not be double-wrapped.
    const skipCtx = otelContext.active().setValue(SKIP_FRAME_INJECT_KEY, true);
    otelContext.with(skipCtx, () => {
      if (typeof optionsOrCb === "function" || optionsOrCb === undefined) {
        originalSend(payload.serialized!, (sendErr?: Error) =>
          finishSendSpan(payload.span!, sendErr, cb),
        );
      } else {
        originalSend(
          payload.serialized!,
          optionsOrCb as never,
          (sendErr?: Error) => finishSendSpan(payload.span!, sendErr, cb),
        );
      }
    });
  }) as BaseWebSocket["send"];
}

function patchNativeSendFrame(
  ws: BaseWebSocket,
  tracer: ReturnType<ReturnType<typeof getTracerProvider>["getTracer"]>,
): void {
  const withInternals = ws as WsWithInternals & {
    [ORIGINAL_SEND_FRAME_SYMBOL]?: (
      list: ReadonlyArray<Buffer>,
      cb?: (err?: Error) => void,
    ) => void;
  };
  const sender = withInternals._sender;
  if (!sender || typeof sender.sendFrame !== "function") {
    diag.debug("[otel-ws] _sender.sendFrame unavailable, skip patch");
    return;
  }
  if (withInternals[ORIGINAL_SEND_FRAME_SYMBOL]) return;

  const originalSendFrame = sender.sendFrame.bind(sender);
  withInternals[ORIGINAL_SEND_FRAME_SYMBOL] = originalSendFrame;

  sender.sendFrame = (
    list: ReadonlyArray<Buffer>,
    cb?: (err?: Error) => void,
  ) => {
    // Skip if this frame was already instrumented by patchNativeSend.
    if (otelContext.active().getValue(SKIP_FRAME_INJECT_KEY)) {
      return originalSendFrame(list, cb);
    }

    const activeCtx = otelContext.active();
    const span = startMessagingSpan(
      tracer,
      "websocket.send",
      SpanKind.PRODUCER,
      activeCtx,
    );
    if (!isOtelActive(ws)) {
      return originalSendFrame(list, (sendErr?: Error) => {
        finishSendSpan(span, sendErr, cb);
      });
    }

    const spanCtx = trace.setSpan(activeCtx, span);
    const patched = injectTraceIntoFrames(list, spanCtx);

    return originalSendFrame(patched, (sendErr?: Error) => {
      finishSendSpan(span, sendErr, cb);
    });
  };
}

function injectTraceIntoFrames(
  list: ReadonlyArray<Buffer>,
  injectCtx: Context,
): ReadonlyArray<Buffer> {
  const carrier: Record<string, string> = {};
  propagation.inject(injectCtx, carrier, defaultTextMapSetter);
  return list.map((frame) => injectTraceIntoSingleFrame(frame, carrier));
}

function injectTraceIntoSingleFrame(
  frame: Buffer,
  carrier: Record<string, string>,
): Buffer {
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
  const unmasked =
    masked && maskKey ? xorMask(payload, maskKey) : Buffer.from(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unmasked.toString("utf8")) as unknown;
  } catch {
    return frame;
  }

  const envelope = buildEnvelope(parsed, carrier);
  const injectedPayload = Buffer.from(JSON.stringify(envelope), "utf8");
  return buildFrame(byte0, masked, maskKey, injectedPayload);
}

function xorMask(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i += 1) {
    out[i] ^= maskKey[i % 4];
  }
  return out;
}

function buildFrame(
  byte0: number,
  masked: boolean,
  maskKey: Buffer | undefined,
  payload: Buffer,
): Buffer {
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
