import {
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { headers as transportHeaders, type Payload } from '@nats-io/transport-node';
import {
  jetstream as natsJetStream,
  type BoundPushConsumerOptions,
  type ConsumeOptions,
  type Consumer,
  type ConsumerInfo,
  type ConsumerMessages,
  type Consumers,
  type FetchOptions,
  type JetStreamClient,
  type JetStreamPublishOptions,
  type JsMsg,
  type NextOptions,
  type OrderedConsumerOptions,
  type OrderedPushConsumerOptions,
  type PubAck,
  type PushConsumer,
  type PushConsumerOptions,
} from '@nats-io/jetstream';

import type { OtelNatsConn } from './index.js';
import { natsHeaderSetter } from './carrier.js';
import { publishAttrs } from './attributes.js';
import {
  attachJsMsgContext,
  contextWithEndedSpan,
  startJsMsgConsumerSpan,
} from './jsmsg-instrumentation.js';
import type { JetStreamTraceConn } from './jsmsg-instrumentation.js';

export { getJetStreamMessageTraceContext } from './msg-trace.js';

/** Optional OTel parent context (same idea as {@link OtelContextMixin} on core). */
export type JetStreamOtelMixin = {
  otelContext?: Context;
  /** When set, adds `Nats-Trace-Dest` to publish headers (NATS server 2.11+). */
  traceDestination?: string;
};

/**
 * Create an instrumented JetStream client backed by {@link jetstream} from `@nats-io/jetstream`.
 */
export function createJetStream(conn: OtelNatsConn): JetStream {
  return new JetStream(conn);
}

function wrapConsumeCallbackOptions(
  conn: JetStreamTraceConn,
  consumerName: string,
  mode: 'receive' | 'process',
  opts?: ConsumeOptions,
): ConsumeOptions | undefined {
  if (!opts?.callback) return opts;
  const user = opts.callback;
  return {
    ...opts,
    callback: (msg: JsMsg): void | Promise<never> => {
      const span = startJsMsgConsumerSpan(conn, msg, consumerName, mode);
      const ctx = trace.setSpan(otelContext.active(), span);
      attachJsMsgContext(msg, ctx);
      try {
        return otelContext.with(ctx, () => user(msg));
      } finally {
        span.end();
      }
    },
  };
}

function wrapPushConsumeCallbackOptions(
  conn: JetStreamTraceConn,
  consumerName: string,
  opts?: PushConsumerOptions,
): PushConsumerOptions | undefined {
  if (!opts?.callback) return opts;
  const user = opts.callback;
  return {
    ...opts,
    callback: (msg: JsMsg): void | Promise<never> => {
      const span = startJsMsgConsumerSpan(conn, msg, consumerName, 'process');
      const ctx = trace.setSpan(otelContext.active(), span);
      attachJsMsgContext(msg, ctx);
      try {
        return otelContext.with(ctx, () => user(msg));
      } finally {
        span.end();
      }
    },
  };
}

/**
 * Wraps {@link ConsumerMessages} so each yielded {@link JsMsg} gets a CONSUMER span
 * (lastSpan pattern until the next message).
 */
export class OtelConsumerMessages {
  readonly #conn: OtelNatsConn;
  readonly #inner: ConsumerMessages;
  readonly #consumerName: string;
  readonly #mode: 'receive' | 'process';

  constructor(
    conn: OtelNatsConn,
    inner: ConsumerMessages,
    consumerName: string,
    mode: 'receive' | 'process',
  ) {
    this.#conn = conn;
    this.#inner = inner;
    this.#consumerName = consumerName;
    this.#mode = mode;
  }

  close(): Promise<void | Error> {
    return this.#inner.close();
  }

  closed(): Promise<void | Error> {
    return this.#inner.closed();
  }

  status(): AsyncIterable<import('@nats-io/jetstream').ConsumerNotification> {
    return this.#inner.status();
  }

  stop(err?: Error): void {
    (this.#inner as { stop(e?: Error): void }).stop(err);
  }

  getProcessed(): number {
    return (this.#inner as { getProcessed(): number }).getProcessed();
  }

  getPending(): number {
    return (this.#inner as { getPending(): number }).getPending();
  }

  getReceived(): number {
    return (this.#inner as { getReceived(): number }).getReceived();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<JsMsg> {
    let lastSpan: Span | undefined;
    try {
      for await (const msg of this.#inner) {
        if (lastSpan) {
          lastSpan.end();
          lastSpan = undefined;
        }
        const span = startJsMsgConsumerSpan(this.#conn, msg, this.#consumerName, this.#mode);
        lastSpan = span;
        const ctx = trace.setSpan(otelContext.active(), span);
        attachJsMsgContext(msg, ctx);
        yield msg;
      }
    } finally {
      if (lastSpan) lastSpan.end();
    }
  }
}

class OtelConsumersDelegate {
  readonly #conn: OtelNatsConn;
  readonly #inner: Consumers;

  constructor(conn: OtelNatsConn, inner: Consumers) {
    this.#conn = conn;
    this.#inner = inner;
  }

  get(
    stream: string,
    name?: string | Partial<OrderedConsumerOptions>,
  ): Promise<OtelConsumer> {
    return this.#inner.get(stream, name).then((c) => {
      const consumerName = typeof name === 'string' ? name : 'ordered';
      return new OtelConsumer(this.#conn, c, consumerName);
    });
  }

  getConsumerFromInfo(ci: ConsumerInfo): OtelConsumer {
    const c = this.#inner.getConsumerFromInfo(ci);
    return new OtelConsumer(this.#conn, c, ci.name);
  }

  getPushConsumer(
    stream: string,
    name?: string | Partial<OrderedPushConsumerOptions>,
  ): Promise<OtelPushConsumer> {
    return this.#inner.getPushConsumer(stream, name).then((p) => {
      const consumerName = typeof name === 'string' ? name : 'push';
      return new OtelPushConsumer(this.#conn, p, consumerName);
    });
  }

  getBoundPushConsumer(opts: BoundPushConsumerOptions): Promise<OtelPushConsumer> {
    return this.#inner.getBoundPushConsumer(opts).then((p) => new OtelPushConsumer(this.#conn, p, 'bound'));
  }
}

/**
 * JetStream client: same surface as {@link JetStreamClient} for `publish`, `consumers`,
 * `streams`, `apiPrefix`, `getOptions`, `jetstreamManager`, and `startBatch`.
 */
export class JetStream {
  readonly #conn: OtelNatsConn;
  readonly #js: JetStreamClient;
  readonly #consumers: OtelConsumersDelegate;

  constructor(conn: OtelNatsConn) {
    this.#conn = conn;
    this.#js = natsJetStream(conn.natsConn());
    this.#consumers = new OtelConsumersDelegate(conn, this.#js.consumers);
  }

  get apiPrefix(): string {
    return this.#js.apiPrefix;
  }

  get streams(): JetStreamClient['streams'] {
    return this.#js.streams;
  }

  getOptions(): ReturnType<JetStreamClient['getOptions']> {
    return this.#js.getOptions();
  }

  jetstreamManager(checkAPI?: boolean): ReturnType<JetStreamClient['jetstreamManager']> {
    return this.#js.jetstreamManager(checkAPI);
  }

  startBatch(
    subj: string,
    payload?: Payload,
    opts?: Partial<JetStreamPublishOptions>,
  ): ReturnType<JetStreamClient['startBatch']> {
    return this.#js.startBatch(subj, payload, opts);
  }

  get consumers(): OtelConsumersDelegate {
    return this.#consumers;
  }

  /**
   * Instrumented publish — same parameters as {@link JetStreamClient.publish}.
   */
  async publish(
    subject: string,
    data?: Uint8Array,
    opts?: Partial<JetStreamPublishOptions> & JetStreamOtelMixin,
  ): Promise<PubAck> {
    const { otelContext: oc, traceDestination: tdOpt, ...rest } = opts ?? {};
    const ctx = oc ?? otelContext.active();
    const { tracer, propagator } = this.#conn.traceContext();
    const serverAddress = this.#conn.serverAddress();
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
    const hdrs = rest.headers ?? transportHeaders();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    const traceDestination = tdOpt ?? this.#conn.defaultTraceDestination();
    if (traceDestination) {
      hdrs.set('Nats-Trace-Dest', traceDestination);
    }

    try {
      const ack = await this.#js.publish(subject, data, {
        ...rest,
        headers: hdrs,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return ack;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }
}

/**
 * Pull consumer with tracing on {@link Consumer.consume}, {@link Consumer.fetch}, and {@link Consumer.next}.
 */
export class OtelConsumer {
  readonly #conn: OtelNatsConn;
  readonly #raw: Consumer;
  readonly #consumerName: string;

  constructor(conn: OtelNatsConn, raw: Consumer, consumerName: string) {
    this.#conn = conn;
    this.#raw = raw;
    this.#consumerName = consumerName;
  }

  isPullConsumer(): boolean {
    return this.#raw.isPullConsumer();
  }

  isPushConsumer(): boolean {
    return this.#raw.isPushConsumer();
  }

  consume(opts?: ConsumeOptions): Promise<OtelConsumerMessages> {
    const wrapped = wrapConsumeCallbackOptions(this.#conn, this.#consumerName, 'receive', opts);
    return this.#raw.consume(wrapped).then(
      (m) => new OtelConsumerMessages(this.#conn, m, this.#consumerName, 'receive'),
    );
  }

  fetch(opts?: FetchOptions): Promise<OtelConsumerMessages> {
    return this.#raw.fetch(opts).then(
      (m) => new OtelConsumerMessages(this.#conn, m, this.#consumerName, 'receive'),
    );
  }

  async next(opts?: NextOptions): Promise<JsMsg | null> {
    const msg = await this.#raw.next(opts);
    if (!msg) return null;
    const span = startJsMsgConsumerSpan(this.#conn, msg, this.#consumerName, 'receive');
    const ctx = contextWithEndedSpan(span);
    span.end();
    attachJsMsgContext(msg, ctx);
    return msg;
  }

  info(cached?: boolean): Promise<ConsumerInfo> {
    return this.#raw.info(cached);
  }

  delete(): Promise<boolean> {
    return this.#raw.delete();
  }
}

/**
 * Push consumer with tracing on {@link PushConsumer.consume}.
 */
export class OtelPushConsumer {
  readonly #conn: OtelNatsConn;
  readonly #raw: PushConsumer;
  readonly #consumerName: string;

  constructor(conn: OtelNatsConn, raw: PushConsumer, consumerName: string) {
    this.#conn = conn;
    this.#raw = raw;
    this.#consumerName = consumerName;
  }

  isPullConsumer(): boolean {
    return this.#raw.isPullConsumer();
  }

  isPushConsumer(): boolean {
    return this.#raw.isPushConsumer();
  }

  consume(opts?: PushConsumerOptions): Promise<OtelConsumerMessages> {
    const wrapped = wrapPushConsumeCallbackOptions(this.#conn, this.#consumerName, opts);
    return this.#raw.consume(wrapped).then(
      (m) => new OtelConsumerMessages(this.#conn, m, this.#consumerName, 'process'),
    );
  }

  info(cached?: boolean): Promise<ConsumerInfo> {
    return this.#raw.info(cached);
  }

  delete(): Promise<boolean> {
    return this.#raw.delete();
  }
}
