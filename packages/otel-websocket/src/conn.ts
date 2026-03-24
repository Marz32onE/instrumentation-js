/**
 * @module otelwebsocket
 *
 * TypeScript port of github.com/Marz32onE/instrumentation-go/otel-websocket.
 *
 * Wraps a `ws` WebSocket and adds OpenTelemetry distributed-tracing support by
 * propagating the W3C Trace Context inside the WebSocket message body.
 *
 * # How it works
 *
 * **Sender (writeMessage):** The current span's trace-context headers (e.g.
 * `traceparent`, `tracestate`) are injected into a lightweight JSON envelope
 * that wraps the original payload.  The envelope is sent as the WebSocket
 * message body.
 *
 * **Receiver (readMessage):** The JSON envelope is unwrapped, trace-context
 * headers are extracted and used to reconstruct the remote span context, and a
 * new `Context` that carries the propagated span is returned to the caller.
 *
 * # Wire format
 *
 * ```json
 * { "headers": { "traceparent": "00-…-01" }, "payload": "<base64>" }
 * ```
 *
 * The payload is base64-encoded to match Go's `json.Marshal([]byte)` behaviour,
 * ensuring cross-language compatibility with the Go client/server.
 */
import {
  Context,
  Link,
  SpanKind,
  SpanStatusCode,
  TextMapPropagator,
  context as otelContext,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';
import WebSocket from 'ws';

import { marshalEnvelope, unmarshalEnvelope } from './message';
import { Options, resolveTracerProvider } from './options';
import { version } from './version';

/** Instrumentation scope name used for Tracer creation. */
export const SCOPE_NAME = '@marz32one/otel-websocket';

/** WebSocket message type for UTF-8 text frames (matches gorilla/websocket TextMessage = 1). */
export const TextMessage = 1;

/** WebSocket message type for binary frames (matches gorilla/websocket BinaryMessage = 2). */
export const BinaryMessage = 2;

/** RawData is the union type of values emitted by the `ws` message event. */
type RawData = Buffer | ArrayBuffer | Buffer[];

/**
 * Minimal WebSocket interface satisfied by `ws.WebSocket`.  Accepting this
 * interface (instead of the concrete class) makes the library easier to test
 * and keeps the door open for browser-compatible adapters.
 */
export interface WebSocketLike {
  send(data: string | Buffer, cb?: (err?: Error) => void): void;
  close(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}

interface PendingResolver {
  resolve: (msg: { data: Buffer; isBinary: boolean }) => void;
  reject: (err: Error) => void;
}

/**
 * Conn is a WebSocket connection with built-in OpenTelemetry trace-context
 * propagation.  It delegates to an underlying `WebSocketLike` so that callers
 * can still use all other `ws` methods directly via the `raw` accessor.
 */
export class Conn {
  private readonly _ws: WebSocketLike;
  /**
   * When set, use this custom propagator; otherwise fall back to the global
   * `propagation` proxy which forwards to whatever is registered globally.
   */
  private readonly _propagator: TextMapPropagator | null;
  private readonly _tracer: ReturnType<ReturnType<typeof resolveTracerProvider>['getTracer']>;
  private _messageQueue: Array<{ data: Buffer; isBinary: boolean }> = [];
  private _pendingResolvers: PendingResolver[] = [];
  private _closed = false;

  constructor(ws: WebSocketLike, opts?: Options) {
    this._ws = ws;
    this._propagator = opts?.propagator ?? null;
    this._tracer = resolveTracerProvider(opts).getTracer(SCOPE_NAME, version());

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const data = normaliseData(raw);
      if (this._pendingResolvers.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._pendingResolvers.shift()!.resolve({ data, isBinary });
      } else {
        this._messageQueue.push({ data, isBinary });
      }
    });

    ws.on('close', () => {
      this._closed = true;
      const err = new Error('WebSocket connection closed');
      for (const r of this._pendingResolvers) {
        r.reject(err);
      }
      this._pendingResolvers = [];
    });

    ws.on('error', (err: Error) => {
      for (const r of this._pendingResolvers) {
        r.reject(err);
      }
      this._pendingResolvers = [];
    });
  }

  /** Exposes the underlying WebSocket for callers that need raw access. */
  get raw(): WebSocketLike {
    return this._ws;
  }

  /**
   * writeMessage encodes data together with the trace-context headers extracted
   * from ctx and sends the resulting JSON envelope over the WebSocket
   * connection.  Creates a `websocket.send` producer span.
   *
   * @param ctx    Context carrying the current span whose trace context is propagated.
   * @param messageType  TextMessage (1) or BinaryMessage (2).
   * @param data   Application payload.
   */
  async writeMessage(
    ctx: Context,
    messageType: number,
    data: Buffer,
  ): Promise<void> {
    const span = this._tracer.startSpan(
      'websocket.send',
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'websocket.message.type': messageType,
          'messaging.message.body.size': data.length,
        },
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);

    try {
      const carrier: Record<string, string> = {};
      this._injectContext(spanCtx, carrier);

      const encoded = marshalEnvelope(carrier, data);
      // Preserve the wire-level message type: text frames as string, binary as Buffer.
      const wireData: string | Buffer =
        messageType === BinaryMessage ? Buffer.from(encoded) : encoded;

      await this._send(wireData);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * readMessage reads the next envelope from the connection, extracts the
   * trace-context headers, and returns a new Context carrying the remote span.
   * Creates a `websocket.receive` consumer span linked to the sender's span.
   *
   * If the message was **not** produced by this library (i.e. it is not a valid
   * JSON envelope), the raw bytes are returned unchanged and no span context is
   * injected – making it safe to introduce the library incrementally.
   *
   * @param ctx  Base context; returned unchanged when the message is plain.
   * @returns    Tuple of [context, messageType, payload].
   */
  async readMessage(ctx: Context): Promise<[Context, number, Buffer]> {
    const { data, isBinary } = await this._nextMessage();
    const msgType = isBinary ? BinaryMessage : TextMessage;

    const env = unmarshalEnvelope(data);
    if (!env) {
      // Plain (non-envelope) message – return as-is without injecting span context.
      return [ctx, msgType, data];
    }

    // Extract sender's trace context from the envelope headers.
    const senderCtx = this._extractContext(ctx, env.headers);

    const payloadBytes = Buffer.from(env.payload, 'base64');

    const links: Link[] = [];
    const senderSc = trace.getSpanContext(senderCtx);
    if (senderSc && isSpanContextValid(senderSc)) {
      links.push({ context: senderSc });
    }

    // Start receive span under the sender's trace so the returned context
    // carries the same trace ID (async messaging convention).
    const span = this._tracer.startSpan(
      'websocket.receive',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'websocket.message.type': msgType,
          'messaging.message.body.size': payloadBytes.length,
        },
        links,
      },
      senderCtx,
    );
    const outCtx = trace.setSpan(senderCtx, span);
    span.end();

    return [outCtx, msgType, payloadBytes];
  }

  /** Closes the underlying WebSocket connection. */
  close(): void {
    this._ws.close();
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  private _injectContext(ctx: Context, carrier: Record<string, string>): void {
    if (this._propagator) {
      this._propagator.inject(ctx, carrier, defaultTextMapSetter);
    } else {
      propagation.inject(ctx, carrier, defaultTextMapSetter);
    }
  }

  private _extractContext(ctx: Context, carrier: Record<string, string>): Context {
    if (this._propagator) {
      return this._propagator.extract(ctx, carrier, defaultTextMapGetter);
    }
    return propagation.extract(ctx, carrier, defaultTextMapGetter);
  }

  private _send(data: string | Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._ws.send(data, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private _nextMessage(): Promise<{ data: Buffer; isBinary: boolean }> {
    return new Promise<{ data: Buffer; isBinary: boolean }>((resolve, reject) => {
      if (this._messageQueue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        resolve(this._messageQueue.shift()!);
        return;
      }
      if (this._closed) {
        reject(new Error('WebSocket connection closed'));
        return;
      }
      this._pendingResolvers.push({ resolve, reject });
    });
  }
}

/**
 * newConn wraps an existing `ws.WebSocket` with trace-context propagation.
 * Any `Options` may be provided to customise the propagator or tracer provider.
 */
export function newConn(ws: WebSocketLike, opts?: Options): Conn {
  return new Conn(ws, opts);
}

/**
 * dial connects to the WebSocket server at the given URL and returns a Conn
 * with trace-context propagation enabled.  It is a thin wrapper around the
 * `ws` constructor.
 *
 * @param _ctx    Context (reserved for future span creation; accepted for API
 *                parity with the Go version).
 * @param url     WebSocket URL (e.g. `ws://host:port/path`).
 * @param headers Optional HTTP headers to include in the upgrade request.
 * @param opts    Optional Conn options.
 */
export function dial(
  _ctx: Context,
  url: string,
  headers?: Record<string, string>,
  opts?: Options,
): Promise<Conn> {
  return new Promise<Conn>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      resolve(new Conn(ws, opts));
    });
    ws.once('error', (err: Error) => {
      reject(err);
    });
  });
}

// ── private helpers ──────────────────────────────────────────────────────────

/** Normalises the various forms of `RawData` emitted by `ws` into a Buffer. */
function normaliseData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data as ArrayBuffer);
}

// Re-export otelContext so consumers don't need to import @opentelemetry/api
// just to get root context in tests or simple scripts.
export { otelContext };
