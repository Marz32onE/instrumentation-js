import {
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import {
  wsconnect as natsWsConnect,
  headers as natsHeaders,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
  type Payload,
  type PublishOptions,
  type RequestManyOptions,
  type RequestOptions,
  type Subscription,
  type SubscriptionOptions,
  type ConnectionOptions as CoreConnectionOptions,
  type WsConnectionOptions,
  type MsgCallback,
  type Status,
  type Stats,
  type ServerInfo,
} from '@nats-io/nats-core';

import { natsHeaderGetter, natsHeaderSetter } from './carrier.js';
import { publishAttrs, receiveAttrs, SCOPE_NAME } from './attributes.js';
import {
  type NatsInstrumentationOptions,
  resolvePropagator,
  resolveTracerProvider,
} from './options.js';
import { version } from './version.js';
import { setCoreMessageTraceContext } from './msg-trace.js';
import { natsTracingEnabled } from './env-flags.js';

export type { NatsInstrumentationOptions };
export { natsHeaderGetter, natsHeaderSetter } from './carrier.js';
export { getMessageTraceContext, getJetStreamMessageTraceContext } from './msg-trace.js';
/** Core client connection options (from @nats-io/nats-core), for typing {@link wsconnect} alongside {@link WsConnectionOptions}. */
export type { CoreConnectionOptions, WsConnectionOptions };

/**
 * Optional OTel parent context for wrapped messaging calls
 * (native `publish` / `request` shape + tracing).
 */
export type OtelContextMixin = { otelContext?: Context };

/**
 * Connect over W3C WebSocket (browser / Deno / Node with global WebSocket).
 * Requires peer dependency `@nats-io/nats-core`.
 *
 * @see https://nats-io.github.io/nats.js/core/functions/wsconnect.html
 */
export async function wsconnect(
  opts?: WsConnectionOptions | CoreConnectionOptions,
  traceOpts?: NatsInstrumentationOptions,
): Promise<OtelNatsConn> {
  const nc = await natsWsConnect(opts);
  return new OtelNatsConn(nc, traceOpts);
}

class TracedSubscription implements Subscription {
  readonly #conn: OtelNatsConn;
  readonly #inner: Subscription;
  readonly #subject: string;
  readonly #queue: string | undefined;

  constructor(conn: OtelNatsConn, inner: Subscription, subject: string, queue: string | undefined) {
    this.#conn = conn;
    this.#inner = inner;
    this.#subject = subject;
    this.#queue = queue;
  }

  get closed(): Promise<void | Error> {
    return this.#inner.closed;
  }

  unsubscribe(max?: number): void {
    this.#inner.unsubscribe(max);
  }

  drain(): Promise<void> {
    return this.#inner.drain();
  }

  isDraining(): boolean {
    return this.#inner.isDraining();
  }

  isClosed(): boolean {
    return this.#inner.isClosed();
  }

  get callback(): MsgCallback<Msg> {
    return this.#inner.callback;
  }

  getSubject(): string {
    return this.#inner.getSubject();
  }

  getReceived(): number {
    return this.#inner.getReceived();
  }

  getProcessed(): number {
    return this.#inner.getProcessed();
  }

  getPending(): number {
    return this.#inner.getPending();
  }

  getID(): number {
    return this.#inner.getID();
  }

  getMax(): number | undefined {
    return this.#inner.getMax();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Msg> {
    let lastSpan: Span | undefined;
    try {
      for await (const msg of this.#inner) {
        if (lastSpan) {
          lastSpan.end();
          lastSpan = undefined;
        }
        const span = this.#conn.startConsumerSpanForCoreMsg(this.#subject, msg, this.#queue, 'process');
        lastSpan = span;
        const ctx = trace.setSpan(otelContext.active(), span);
        setCoreMessageTraceContext(msg, ctx);
        yield msg;
      }
    } finally {
      if (lastSpan) lastSpan.end();
    }
  }
}

export class OtelNatsConn {
  readonly #nc: NatsConnection;
  readonly #traceOpts: NatsInstrumentationOptions | undefined;
  readonly #createHeaders: () => MsgHdrs;
  readonly #serverAddress: string;
  readonly #tracingEnabled: boolean;

  constructor(
    nc: NatsConnection,
    traceOpts?: NatsInstrumentationOptions,
    createHeaders?: () => MsgHdrs,
  ) {
    this.#nc = nc;
    this.#traceOpts = traceOpts;
    this.#createHeaders = createHeaders ?? (() => natsHeaders());
    this.#serverAddress = OtelNatsConn.#parseServerAddress(nc);
    this.#tracingEnabled = natsTracingEnabled();
  }

  static #parseServerAddress(nc: NatsConnection): string {
    try {
      const url = new URL(nc.getServer());
      return url.hostname;
    } catch {
      return nc.getServer();
    }
  }

  /** Used by {@link TracedSubscription} and {@link subscribe} callback wrapping. */
  startConsumerSpanForCoreMsg(
    subject: string,
    msg: Msg,
    queue: string | undefined,
    op: 'process' | 'receive',
  ): Span {
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const hdrs = msg.headers;
    const extractedCtx = hdrs
      ? propagator.extract(otelContext.active(), hdrs, natsHeaderGetter)
      : otelContext.active();
    const originSpanCtx = trace.getSpanContext(extractedCtx);
    const bodySize = msg.data?.length ?? 0;
    return tracer.startSpan(
      `${subject} ${op}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: receiveAttrs(subject, op, bodySize, serverAddress, queue),
        links: originSpanCtx && isSpanContextValid(originSpanCtx) ? [{ context: originSpanCtx }] : [],
      },
      otelContext.active(),
    );
  }

  /** Returns the underlying NatsConnection. */
  natsConn(): NatsConnection {
    return this.#nc;
  }

  traceContext(): {
    tracer: ReturnType<ReturnType<typeof resolveTracerProvider>['getTracer']>;
    propagator: ReturnType<typeof resolvePropagator>;
  } {
    const tp = resolveTracerProvider(this.#traceOpts);
    return {
      tracer: tp.getTracer(SCOPE_NAME, version()),
      propagator: resolvePropagator(this.#traceOpts),
    };
  }

  serverAddress(): string {
    return this.#serverAddress;
  }

  /** Default trace destination from {@link NatsInstrumentationOptions.traceDestination}. */
  defaultTraceDestination(): string | undefined {
    return this.#traceOpts?.traceDestination;
  }

  closed(): Promise<void | Error> {
    return this.#nc.closed();
  }

  async close(): Promise<void> {
    await this.#nc.close();
  }

  async drain(): Promise<void> {
    await this.#nc.drain();
  }

  async flush(): Promise<void> {
    await this.#nc.flush();
  }

  isClosed(): boolean {
    return this.#nc.isClosed();
  }

  isDraining(): boolean {
    return this.#nc.isDraining();
  }

  getServer(): string {
    return this.#nc.getServer();
  }

  status(): AsyncIterable<Status> {
    return this.#nc.status();
  }

  stats(): Stats {
    return this.#nc.stats();
  }

  async rtt(): Promise<number> {
    return this.#nc.rtt();
  }

  async reconnect(): Promise<void> {
    await this.#nc.reconnect();
  }

  get info(): ServerInfo | undefined {
    return this.#nc.info;
  }

  /**
   * Publish with PRODUCER span and W3C context injection.
   * Same shape as {@link NatsConnection.publish}; pass `otelContext` to choose the parent span context.
   */
  publish(
    subject: string,
    payload?: Payload,
    options?: PublishOptions & OtelContextMixin,
  ): void {
    const { otelContext: oc, ...publishRest } = options ?? {};
    if (!this.#tracingEnabled) {
      this.#nc.publish(subject, payload, publishRest);
      return;
    }
    const ctx = oc ?? otelContext.active();
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const bodySize = data?.length ?? 0;

    const span = tracer.startSpan(
      `${subject} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    const hdrs = publishRest.headers ?? this.#createHeaders();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    const traceDestination =
      publishRest.traceDestination ?? this.#traceOpts?.traceDestination;
    try {
      this.#nc.publish(subject, payload, {
        ...publishRest,
        headers: hdrs,
        traceDestination,
      });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Publish using a full `Msg` (same as {@link NatsConnection.publishMessage}).
   */
  publishMessage(msg: Msg, options?: OtelContextMixin): void {
    if (!this.#tracingEnabled) {
      this.#nc.publishMessage(msg);
      return;
    }
    const ctx = options?.otelContext ?? otelContext.active();
    if (!msg.headers) {
      (msg as { headers: MsgHdrs }).headers = this.#createHeaders();
    }
    const hdrs = msg.headers!;
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const bodySize = msg.data?.length ?? 0;
    const span = tracer.startSpan(
      `${msg.subject} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(msg.subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);
    const td = this.#traceOpts?.traceDestination;
    if (td) {
      hdrs.set('Nats-Trace-Dest', td);
    }
    try {
      this.#nc.publishMessage(msg);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Reply via {@link NatsConnection.respondMessage} with PRODUCER span on `msg.reply`.
   */
  respondMessage(msg: Msg, options?: OtelContextMixin): boolean {
    if (!msg.reply) return this.#nc.respondMessage(msg);
    if (!this.#tracingEnabled) return this.#nc.respondMessage(msg);
    const ctx = options?.otelContext ?? otelContext.active();
    if (!msg.headers) {
      (msg as { headers: MsgHdrs }).headers = this.#createHeaders();
    }
    const hdrs = msg.headers!;
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const bodySize = msg.data?.length ?? 0;
    const span = tracer.startSpan(
      `${msg.reply} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(msg.reply, bodySize, serverAddress),
      },
      ctx,
    );
    propagator.inject(trace.setSpan(ctx, span), hdrs, natsHeaderSetter);
    try {
      const ok = this.#nc.respondMessage(msg);
      span.setStatus({ code: SpanStatusCode.OK });
      return ok;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Subscribe with CONSUMER spans on each message (iterator or `callback` option).
   * Use {@link getMessageTraceContext} to read the context for a delivered `Msg`.
   */
  subscribe(subject: string, opts?: SubscriptionOptions): Subscription {
    if (!this.#tracingEnabled) return this.#nc.subscribe(subject, opts);
    if (opts?.callback) {
      const userCb = opts.callback;
      return this.#nc.subscribe(subject, {
        ...opts,
        callback: (err, msg) => {
          if (err != null || !msg) return userCb(err, msg);
          const span = this.startConsumerSpanForCoreMsg(subject, msg, opts.queue, 'process');
          const ctx = trace.setSpan(otelContext.active(), span);
          setCoreMessageTraceContext(msg, ctx);
          try {
            return otelContext.with(ctx, () => userCb(err, msg));
          } finally {
            span.end();
          }
        },
      });
    }
    const inner = this.#nc.subscribe(subject, opts);
    return new TracedSubscription(this, inner, subject, opts?.queue);
  }

  /**
   * Request-reply with PRODUCER span; reply body size recorded on success.
   */
  request(
    subject: string,
    payload?: Payload,
    opts?: RequestOptions & OtelContextMixin,
  ): Promise<Msg> {
    const { otelContext: oc, ...reqRest } = opts ?? ({} as RequestOptions & OtelContextMixin);
    if (!this.#tracingEnabled) return this.#nc.request(subject, payload, reqRest as RequestOptions);
    const ctx = oc ?? otelContext.active();
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const bodySize = data?.length ?? 0;
    const timeout = (reqRest as RequestOptions).timeout ?? 5000;

    const span = tracer.startSpan(
      `${subject} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    const hdrs = reqRest.headers ?? this.#createHeaders();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    return this.#nc
      .request(subject, payload, {
        ...(reqRest as RequestOptions),
        timeout,
        headers: hdrs,
      })
      .then((reply) => {
        span.setAttribute('messaging.message.body.size', reply.data?.length ?? 0);
        span.setStatus({ code: SpanStatusCode.OK });
        return reply;
      })
      .catch((err: Error) => {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      })
      .finally(() => {
        span.end();
      });
  }

  /**
   * Request expecting multiple responses: one PRODUCER span for the outbound request,
   * then a CONSUMER span per response (use {@link getMessageTraceContext} on each `Msg`).
   */
  async requestMany(
    subject: string,
    payload?: Payload,
    opts?: Partial<RequestManyOptions> & OtelContextMixin,
  ): Promise<AsyncIterable<Msg>> {
    const { otelContext: oc, ...rmRest } = opts ?? {};
    if (!this.#tracingEnabled) return this.#nc.requestMany(subject, payload, rmRest as RequestManyOptions);
    const ctx = oc ?? otelContext.active();
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const bodySize = data?.length ?? 0;

    const span = tracer.startSpan(
      `${subject} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    const hdrs = rmRest.headers ?? this.#createHeaders();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    const raw = await this.#nc.requestMany(subject, payload, {
      ...(rmRest as RequestManyOptions),
      headers: hdrs,
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    return OtelNatsConn.#wrapRequestManyIterable(this, raw);
  }

  static async *#wrapRequestManyIterable(
    conn: OtelNatsConn,
    source: AsyncIterable<Msg>,
  ): AsyncIterableIterator<Msg> {
    for await (const msg of source) {
      const span = conn.startConsumerSpanForCoreMsg(msg.subject, msg, undefined, 'receive');
      const ctx = trace.setSpan(otelContext.active(), span);
      setCoreMessageTraceContext(msg, ctx);
      span.end();
      yield msg;
    }
  }
}
