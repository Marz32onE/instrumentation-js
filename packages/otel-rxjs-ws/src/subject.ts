import {
  Context,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  defaultTextMapGetter,
  defaultTextMapSetter,
  diag,
  propagation,
  trace,
} from '@opentelemetry/api';
import { Subscriber, Subscription } from 'rxjs';
import { WebSocketSubject } from 'rxjs/webSocket';
import type { WebSocketSubjectConfig as RxWebSocketSubjectConfig } from 'rxjs/webSocket';

/** RxJS config plus optional `prependOtelSubprotocol` (default true).
 * When enabled, otel-ws tokens are prepended only if user protocols are provided.
 */
export type WebSocketSubjectConfig<T = unknown> = RxWebSocketSubjectConfig<T> & {
  prependOtelSubprotocol?: boolean;
  /**
   * Programmatic tracing on/off switch. Useful in browser environments where
   * `process.env` is unavailable. When omitted, Node.js environments read
   * `OTEL_WS_TRACING_ENABLED` / `OTEL_INSTRUMENTATION_JS_TRACING_ENABLED`;
   * browser environments default to `true`. An explicit `false` here takes
   * priority over any environment variable.
   */
  tracingEnabled?: boolean;
};

import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  buildEnvelope,
  deserializeMessage,
} from './wire-message.js';
import { getTracerProvider } from './options.js';
import { version } from './version.js';
import { wsTracingEnabled } from './env-flags.js';

const OTEL_WS_PROTOCOL = 'otel-ws';
const OTEL_WS_INSTRUMENTED_PREFIX = `${OTEL_WS_PROTOCOL}+`;

function normalizeUserProtocols(protocols?: string | string[]): string[] {
  if (protocols == null) return [];
  const arr = Array.isArray(protocols) ? [...protocols] : [protocols];
  return arr.filter((p): p is string => typeof p === 'string' && p.length > 0 && p !== OTEL_WS_PROTOCOL);
}

/** Offer: compound `otel-ws+P` tokens first, then bare user protocols.
 * - No protocol config (undefined) → `['otel-ws']`, default trace-enabled offer.
 * - Explicitly empty protocol (`''` or `[]`) → empty offer, passthrough mode (no otel-ws injection).
 */
function buildClientProtocolOffer(protocols: string | string[] | undefined): string[] {
  // undefined = user did not configure a protocol → offer bare 'otel-ws' by default
  if (protocols === undefined) return [OTEL_WS_PROTOCOL];

  const user = [...new Set(normalizeUserProtocols(protocols))];
  return user.length === 0
    ? []
    : [...user.map(p => `${OTEL_WS_INSTRUMENTED_PREFIX}${p}`), ...user];
}

function userFacingProtocolFromWire(wire: string): string {
  if (wire.startsWith(OTEL_WS_INSTRUMENTED_PREFIX)) {
    return wire.slice(OTEL_WS_INSTRUMENTED_PREFIX.length);
  }
  if (wire === OTEL_WS_PROTOCOL) {
    return '';
  }
  return wire;
}

/**
 * Client: enable envelope only when the server explicitly acknowledged otel-ws by returning
 * "otel-ws" (bare) or the "otel-ws+<subprotocol>" prefix — NOT for bare user subprotocols.
 * Matches otel-ws `OtelWebSocket` / otel-ws.md Case C (downgrade when server returns bare Pi).
 */
function clientEnvelopeActive(wire: string): boolean {
  return (
    wire === OTEL_WS_PROTOCOL || wire.startsWith(OTEL_WS_INSTRUMENTED_PREFIX)
  );
}


// ---------------------------------------------------------------------------
// FallbackWebSocket — transparent proxy used when the default ['otel-ws'] offer
// is rejected by a server that performs strict subprotocol validation.
// On the first close-before-open it retries once without any protocol; if that
// also fails the close event is forwarded to RxJS normally.
// ---------------------------------------------------------------------------

type WsLike = InstanceType<typeof WebSocket>;

function createFallbackCtor(OrigCtor: new (...a: unknown[]) => WsLike) {
  return class FallbackWebSocket {
    private _ws!: WsLike;
    private _opened = false;
    private _retried = false;
    private _binaryType: BinaryType = 'blob';
    private readonly _url: string;

    // Handler storage shared across both WS instances so RxJS property
    // assignments made after construction are captured correctly.
    private readonly _h: {
      onopen:    ((ev: Event) => unknown) | null;
      onclose:   ((ev: CloseEvent) => unknown) | null;
      onmessage: ((ev: MessageEvent) => unknown) | null;
      onerror:   ((ev: Event) => unknown) | null;
    } = { onopen: null, onclose: null, onmessage: null, onerror: null };

    constructor(url: string, protocols?: string | string[]) {
      this._url = url;
      this._connect(protocols);
    }

    private _connect(protocols?: string | string[]) {
      const ws = protocols?.length
        ? new OrigCtor(this._url, protocols)
        : new OrigCtor(this._url);
      this._ws = ws;
      ws.binaryType = this._binaryType;

      ws.onopen    = (e) => { this._opened = true; this._h.onopen?.call(this, e); };
      ws.onmessage = (e) => this._h.onmessage?.call(this, e);
      ws.onerror   = (e) => {
        if (!this._opened && !this._retried) {
          // Pre-open error: suppress so RxJS does not error the observable before
          // the close event triggers our retry. If the retry also fails, the close
          // handler will forward the close to RxJS which errors it naturally.
          return;
        }
        this._h.onerror?.call(this, e);
      };
      ws.onclose   = (e) => {
        if (!this._opened && !this._retried) {
          // Server rejected our subprotocol offer — retry once without protocols.
          this._retried = true;
          this._connect();
          return;
        }
        this._h.onclose?.call(this, e);
      };
    }

    // RxJS assigns these as plain properties after constructing the socket.
    get onopen()    { return this._h.onopen; }    set onopen(h)    { this._h.onopen = h; }
    get onclose()   { return this._h.onclose; }   set onclose(h)   { this._h.onclose = h; }
    get onmessage() { return this._h.onmessage; } set onmessage(h) { this._h.onmessage = h; }
    get onerror()   { return this._h.onerror; }   set onerror(h)   { this._h.onerror = h; }

    // Delegated to the active inner socket.
    get readyState()     { return this._ws.readyState; }
    // After successful fallback, protocol === '' → clientEnvelopeActive returns false → passthrough mode.
    get protocol()       { return this._ws.protocol; }
    get url()            { return this._ws.url; }
    get bufferedAmount() { return this._ws.bufferedAmount; }
    get extensions()     { return this._ws.extensions; }
    get binaryType()              { return this._binaryType; }
    set binaryType(v: BinaryType) { this._binaryType = v; this._ws.binaryType = v; }

    send(d: Parameters<WsLike['send']>[0])       { this._ws.send(d); }
    close(code?: number, reason?: string)         { this._ws.close(code, reason); }
    addEventListener(...a: Parameters<WsLike['addEventListener']>)       { this._ws.addEventListener(...a); }
    removeEventListener(...a: Parameters<WsLike['removeEventListener']>) { this._ws.removeEventListener(...a); }
    dispatchEvent(e: Event): boolean              { return this._ws.dispatchEvent(e); }
  };
}

function defaultSerializer<T>(value: T): string {
  return JSON.stringify(value);
}

function defaultDeserializer<T>(event: MessageEvent): T {
  return JSON.parse(String(event.data)) as T;
}

/**
 * Internal instrumented subject. Not part of the public API — use {@link webSocket}
 * exactly like `rxjs/webSocket`.
 */
class InstrumentedWebSocketSubject<T> extends WebSocketSubject<T> {
  // Queue of send contexts: one pushed per next() call, shifted when the serializer runs.
  // Array is necessary because RxJS may buffer messages when the socket is not yet OPEN,
  // delaying serialization until after next() returns.
  private readonly _pendingSendContexts: Context[] = [];

  // Queue of receive contexts, one pushed per incoming message and shifted per
  // subscriber next() call. Keeps consecutive messages from sharing a single field.
  private readonly _pendingReceiveCtxs: Context[] = [];

  private readonly _tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>;
  private readonly _userSerializer: NonNullable<
    WebSocketSubjectConfig<T>['serializer']
  > | null;
  private readonly _userDeserializer: NonNullable<
    WebSocketSubjectConfig<T>['deserializer']
  > | null;
  private _otelProtocolActive = false;
  private readonly _tracingEnabled: boolean;

  constructor(urlOrConfig: string | WebSocketSubjectConfig<T>) {
    const holder: { inst?: InstrumentedWebSocketSubject<T> } = {};

    const configIn: WebSocketSubjectConfig<T> =
      typeof urlOrConfig === 'string' ? { url: urlOrConfig } : { ...urlOrConfig };

    const {
      serializer: userSerializer,
      deserializer: userDeserializer,
      prependOtelSubprotocol,
      tracingEnabled: tracingEnabledOpt,
      ...rest
    } = configIn;

    // Config option takes priority over env var (enables programmatic control in browser).
    const tracingEnabled = tracingEnabledOpt !== undefined ? tracingEnabledOpt : wsTracingEnabled();
    const prepend = prependOtelSubprotocol !== false && tracingEnabled;

    const userOpenObserver = configIn.openObserver;
    const userCloseObserver = configIn.closingObserver;
    const merged: WebSocketSubjectConfig<T> = {
      ...rest,
      protocol: prepend
        ? buildClientProtocolOffer(configIn.protocol)
        : configIn.protocol,
      // When the default offer (['otel-ws']) is used, wrap the WebSocket constructor
      // so that a server-side subprotocol rejection is handled transparently: the
      // proxy retries once without any protocol and connects in passthrough mode.
      WebSocketCtor: (prepend && configIn.protocol === undefined)
        ? (createFallbackCtor(
            (rest.WebSocketCtor ?? WebSocket) as unknown as new (...a: unknown[]) => WsLike,
          ) as unknown as typeof WebSocket)
        : rest.WebSocketCtor,
      openObserver: {
        next: (event: Event) => {
          if (tracingEnabled) {
            const target = event.target as WebSocket | null;
            const rawProtocol = target?.protocol ?? '';
            holder.inst!._otelProtocolActive = clientEnvelopeActive(rawProtocol);
            if (prepend && target) {
              const facade = userFacingProtocolFromWire(rawProtocol);
              Object.defineProperty(target, 'protocol', {
                configurable: true,
                enumerable: true,
                get: () => facade,
              });
            }
          }
          userOpenObserver?.next?.(event);
        },
      },
      closingObserver: {
        next: (value: void) => {
          // Clear stale context queues so they don't bleed across reconnects.
          holder.inst!._pendingSendContexts.length = 0;
          holder.inst!._pendingReceiveCtxs.length = 0;
          userCloseObserver?.next?.(value);
        },
      },
      serializer: (value: T) => holder.inst!._serializeOutgoing(value),
      deserializer: (e: MessageEvent) => holder.inst!._deserializeIncoming(e),
    };

    super(merged);
    holder.inst = this;

    this._tracingEnabled = tracingEnabled;
    this._userSerializer = userSerializer ?? null;
    this._userDeserializer = userDeserializer ?? null;
    this._tracer = getTracerProvider().getTracer('@marz32one/otel-rxjs-ws', version());
  }

  override next(value: T): void {
    if (this._tracingEnabled) {
      this._pendingSendContexts.push(otelContext.active());
    }
    const lenBefore = this._pendingSendContexts.length;
    try {
      super.next(value);
    } catch (err) {
      // Only remove the context we just pushed if the serializer didn't already shift it.
      // The serializer shifts the context, so if length is unchanged, serialization never ran.
      if (this._tracingEnabled && this._pendingSendContexts.length === lenBefore) {
        this._pendingSendContexts.pop();
      }
      throw err;
    }
  }

  protected _subscribe(subscriber: Subscriber<T>): Subscription {
    const wrapped = new Subscriber<T>({
      next: (value: T) => {
        const ctx = this._pendingReceiveCtxs.shift();
        if (ctx) {
          otelContext.with(ctx, () => {
            subscriber.next(value);
          });
        } else {
          if (this._tracingEnabled) {
            diag.warn('[otel-rxjs-ws] receive context queue empty, delivering without extracted trace context');
          }
          subscriber.next(value);
        }
      },
      error: (err: unknown) => {
        subscriber.error(err);
      },
      complete: () => {
        subscriber.complete();
      },
    });
    wrapped.add(subscriber);
    return (
      WebSocketSubject.prototype as unknown as {
        _subscribe: (sub: Subscriber<T>) => Subscription;
      }
    )._subscribe.call(this, wrapped);
  }

  private _serializeOutgoing(value: T): ReturnType<
    NonNullable<WebSocketSubjectConfig<T>['serializer']>
  > {
    if (!this._tracingEnabled) {
      return this._userSerializer
        ? this._userSerializer(value)
        : defaultSerializer(value);
    }

    const activeCtx =
      this._pendingSendContexts.shift() ?? otelContext.active();
    const span = this._tracer.startSpan(
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
      if (!this._otelProtocolActive) {
        const out = this._userSerializer
          ? this._userSerializer(value)
          : defaultSerializer(value);
        span.setStatus({ code: SpanStatusCode.OK });
        return out;
      }

      let data: unknown = value;
      if (this._userSerializer) {
        const inner = this._userSerializer(value);
        if (typeof inner !== 'string') {
          diag.warn('[otel-rxjs-ws] _serializeOutgoing: user serializer returned non-string, trace wrapping skipped');
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'non-string serializer output: trace wrapping skipped',
          });
          return inner;
        }
        try {
          data = JSON.parse(inner) as unknown;
        } catch {
          data = inner;
        }
      }

      const carrier: Record<string, string> = {};
      propagation.inject(spanCtx, carrier, defaultTextMapSetter);

      span.setStatus({ code: SpanStatusCode.OK });
      return JSON.stringify(buildEnvelope(data, carrier));
    } catch (err) {
      diag.error('[otel-rxjs-ws] _serializeOutgoing: serialization failed', { error: (err as Error).message });
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      span.end();
    }
  }

  private _deserializeIncoming(e: MessageEvent): T {
    if (!this._tracingEnabled) {
      return this._userDeserializer
        ? this._userDeserializer(e)
        : defaultDeserializer<T>(e);
    }

    if (!this._otelProtocolActive) {
      const span = this._tracer.startSpan(
        'websocket.receive',
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            'messaging.system': 'websocket',
            'messaging.operation': 'receive',
          },
        },
        otelContext.active(),
      );
      const outCtx = trace.setSpan(otelContext.active(), span);
      try {
        const result = this._userDeserializer
          ? this._userDeserializer(e)
          : defaultDeserializer<T>(e);
        this._pendingReceiveCtxs.push(outCtx);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        diag.error('[otel-rxjs-ws] _deserializeIncoming: deserialization failed', { error: (err as Error).message });
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    }

    // Use dynamic access to avoid a static 'Buffer' type reference;
    // tsconfig targets browser lib (no @types/node) so Buffer is not in scope.
    const NodeBuffer = (globalThis as Record<string, unknown>)['Buffer'] as
      | { isBuffer(v: unknown): v is { toString(enc: string): string } }
      | undefined;
    const raw =
      typeof e.data === 'string' || typeof e.data === 'number'
        ? String(e.data)
        : NodeBuffer?.isBuffer(e.data)
          ? e.data.toString('utf8')
          : String(e.data);

    const parsed = deserializeMessage<T>(raw);

    const carrier: Record<string, string> = {};
    if (parsed.traceparent) carrier[TRACEPARENT_HEADER] = parsed.traceparent;
    if (parsed.tracestate) carrier[TRACESTATE_HEADER] = parsed.tracestate;

    const hasTrace = Object.keys(carrier).length > 0;
    const baseCtx = otelContext.active();
    const senderCtx = hasTrace
      ? propagation.extract(baseCtx, carrier, defaultTextMapGetter)
      : baseCtx;

    const span = this._tracer.startSpan(
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

    let result = parsed.data;
    if (this._userDeserializer) {
      const payload =
        typeof result === 'object' && result !== null
          ? JSON.stringify(result)
          : String(result);
      const synthetic = { ...e, data: payload } as MessageEvent;
      try {
        result = this._userDeserializer(synthetic);
      } catch (err) {
        diag.error('[otel-rxjs-ws] _deserializeIncoming: user deserializer failed', { error: (err as Error).message });
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.end();
        throw err;
      }
    }

    span.end();
    this._pendingReceiveCtxs.push(outCtx);
    return result;
  }
}

/**
 * Drop-in replacement for `import { webSocket } from 'rxjs/webSocket'`.
 * Signature and return type match RxJS; adds trace propagation and
 * `websocket.send` / `websocket.receive` spans using the global OTel API.
 */
export function webSocket<T>(
  urlOrConfig: string | WebSocketSubjectConfig<T>,
): WebSocketSubject<T> {
  return new InstrumentedWebSocketSubject<T>(urlOrConfig) as WebSocketSubject<T>;
}
