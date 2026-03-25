import {
  Context,
  Link,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';
import { Subscriber, Subscription } from 'rxjs';
import { WebSocketSubject, WebSocketSubjectConfig } from 'rxjs/webSocket';

import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  WireMessage,
  deserializeMessage,
} from './message.js';
import { getTracerProvider } from './options.js';
import { version } from './version.js';

/**
 * Internal instrumented subject. Not part of the public API — use {@link webSocket}
 * exactly like `rxjs/webSocket`.
 */
class InstrumentedWebSocketSubject<T> extends WebSocketSubject<T> {
  private readonly _pendingSendContexts: Context[] = [];

  private _pendingReceiveCtx: Context | undefined;
  private readonly _tracer: ReturnType<ReturnType<typeof getTracerProvider>['getTracer']>;
  private readonly _userSerializer: NonNullable<
    WebSocketSubjectConfig<T>['serializer']
  > | null;
  private readonly _userDeserializer: NonNullable<
    WebSocketSubjectConfig<T>['deserializer']
  > | null;

  constructor(urlOrConfig: string | WebSocketSubjectConfig<T>) {
    const holder: { inst?: InstrumentedWebSocketSubject<T> } = {};

    const configIn: WebSocketSubjectConfig<T> =
      typeof urlOrConfig === 'string' ? { url: urlOrConfig } : { ...urlOrConfig };

    const { serializer: userSerializer, deserializer: userDeserializer, ...rest } =
      configIn;

    const merged: WebSocketSubjectConfig<T> = {
      ...rest,
      serializer: (value: T) => holder.inst!._serializeOutgoing(value),
      deserializer: (e: MessageEvent) => holder.inst!._deserializeIncoming(e),
    };

    super(merged);
    holder.inst = this;

    this._userSerializer = userSerializer ?? null;
    this._userDeserializer = userDeserializer ?? null;
    this._tracer = getTracerProvider().getTracer('@marz32one/otel-rxjs-ws', version());
  }

  override next(value?: T): void {
    this._pendingSendContexts.push(otelContext.active());
    try {
      super.next(value!);
    } catch (err) {
      this._pendingSendContexts.pop();
      throw err;
    }
  }

  protected _subscribe(subscriber: Subscriber<T>): Subscription {
    const wrapped = new Subscriber<T>({
      next: (value: T) => {
        const ctx = this._pendingReceiveCtx;
        if (ctx) {
          otelContext.with(ctx, () => {
            subscriber.next(value);
          });
        } else {
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
      let data: unknown = value;
      if (this._userSerializer) {
        const inner = this._userSerializer(value);
        if (typeof inner !== 'string') {
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

      const wire: WireMessage<unknown> = { data };
      const tp = carrier[TRACEPARENT_HEADER];
      const ts = carrier[TRACESTATE_HEADER];
      if (tp) wire.traceparent = tp;
      if (ts) wire.tracestate = ts;

      span.setStatus({ code: SpanStatusCode.OK });
      return JSON.stringify(wire);
    } catch (err) {
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
    const raw =
      typeof e.data === 'string' || typeof e.data === 'number'
        ? String(e.data)
        : typeof Buffer !== 'undefined' && Buffer.isBuffer(e.data)
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

    const links: Link[] = [];
    const senderSc = trace.getSpanContext(senderCtx);
    if (senderSc && isSpanContextValid(senderSc)) {
      links.push({ context: senderSc });
    }

    const span = this._tracer.startSpan(
      'websocket.receive',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'websocket',
          'messaging.operation': 'receive',
        },
        links,
      },
      senderCtx,
    );
    const outCtx = trace.setSpan(senderCtx, span);
    span.end();

    this._pendingReceiveCtx = outCtx;
    queueMicrotask(() => {
      this._pendingReceiveCtx = undefined;
    });

    let result = parsed.data as T;
    if (this._userDeserializer) {
      const payload =
        typeof result === 'object' && result !== null
          ? JSON.stringify(result)
          : String(result);
      const synthetic = { ...e, data: payload } as MessageEvent;
      result = this._userDeserializer(synthetic);
    }
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
