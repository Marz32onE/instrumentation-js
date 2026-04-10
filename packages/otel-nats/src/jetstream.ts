import {
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import { headers, type MsgHdrs } from '@nats-io/transport-node';
import {
  jetstream as natsJetStream,
  type ConsumeOptions,
  type Consumer,
  type JetStreamClient,
  type JsMsg,
  type PubAck,
} from '@nats-io/jetstream';

import type { OtelNatsConn } from './index.js';
import { natsHeaderGetter, natsHeaderSetter } from './carrier.js';
import { publishAttrs, receiveAttrs } from './attributes.js';

/**
 * Create an instrumented JetStream client.
 * Mirrors Go version's oteljetstream.New().
 * Uses {@link https://github.com/nats-io/nats.js | @nats-io/jetstream} (nats.js v3).
 */
export function createJetStream(conn: OtelNatsConn): JetStream {
  return new JetStream(conn);
}

/**
 * JetStream client with OTel trace propagation.
 * Mirrors Go version's oteljetstream.JetStream interface.
 */
export class JetStream {
  readonly #conn: OtelNatsConn;
  readonly #js: JetStreamClient;

  constructor(conn: OtelNatsConn) {
    this.#conn = conn;
    this.#js = natsJetStream(conn.natsConn());
  }

  /**
   * Publish with a PRODUCER span.
   * Span name: "send {subject}"
   *
   * If `opts.headers` is provided, `traceparent` / `tracestate` keys in it
   * will be **overwritten** by the current span's trace context.
   */
  async publish(
    ctx: Context,
    subject: string,
    data?: Uint8Array,
    opts?: { headers?: MsgHdrs },
  ): Promise<PubAck> {
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
    const hdrs = opts?.headers ?? headers();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    try {
      const ack = await this.#js.publish(subject, data, { headers: hdrs });
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

  /**
   * Get an instrumented consumer.
   * Mirrors Go version's Consumer(ctx, stream, consumer).
   */
  async consumer(stream: string, consumerName: string): Promise<OtelConsumer> {
    const c = await this.#js.consumers.get(stream, consumerName);
    return new OtelConsumer(this.#conn, c, consumerName);
  }
}

/**
 * JetStream consumer with OTel trace propagation.
 * Mirrors Go version's Consumer interface (Consume / Messages / Fetch).
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

  /**
   * Async generator consumer — mirrors Go's Messages() + Next() pattern.
   * Each span ends when the next yield begins (lastSpan pattern).
   * The final span ends in the finally block when the generator is done.
   */
  async *messages(
    opts?: ConsumeOptions,
  ): AsyncGenerator<{ msg: JsMsg; ctx: Context }> {
    const iter = await this.#raw.consume(opts);
    let lastSpan: Span | undefined;

    try {
      for await (const msg of iter) {
        if (lastSpan) {
          lastSpan.end();
          lastSpan = undefined;
        }

        const { tracer, propagator } = this.#conn.traceContext();
        const serverAddress = this.#conn.serverAddress();

        const hdrs = msg.headers;
        const extractedCtx = hdrs
          ? propagator.extract(otelContext.active(), hdrs, natsHeaderGetter)
          : otelContext.active();

        const originSpanCtx = trace.getSpanContext(extractedCtx);
        const bodySize = msg.data?.length ?? 0;

        const span = tracer.startSpan(
          `${msg.subject} receive`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              ...receiveAttrs(msg.subject, 'receive', bodySize, serverAddress),
              'messaging.consumer.name': this.#consumerName,
            },
            links: originSpanCtx && isSpanContextValid(originSpanCtx) ? [{ context: originSpanCtx }] : [],
          },
          otelContext.active(),
        );
        lastSpan = span;

        yield { msg, ctx: trace.setSpan(otelContext.active(), span) };
      }
    } finally {
      if (lastSpan) lastSpan.end();
      await iter.close();
    }
  }

  /**
   * Batch fetch — mirrors Go's Fetch(batch).
   * Each span ends immediately (point-in-time), result is a plain array.
   */
  async fetch(
    maxMessages: number,
    opts?: { expires?: number },
  ): Promise<Array<{ msg: JsMsg; ctx: Context }>> {
    const { tracer, propagator } = this.#conn.traceContext();
    const serverAddress = this.#conn.serverAddress();

    const fetched = await this.#raw.fetch({ max_messages: maxMessages, ...opts });
    const result: Array<{ msg: JsMsg; ctx: Context }> = [];

    try {
      for await (const msg of fetched) {
        const hdrs = msg.headers;
        const extractedCtx = hdrs
          ? propagator.extract(otelContext.active(), hdrs, natsHeaderGetter)
          : otelContext.active();

        const originSpanCtx = trace.getSpanContext(extractedCtx);
        const bodySize = msg.data?.length ?? 0;

        const span = tracer.startSpan(
          `${msg.subject} receive`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              ...receiveAttrs(msg.subject, 'receive', bodySize, serverAddress),
              'messaging.consumer.name': this.#consumerName,
            },
            links: originSpanCtx && isSpanContextValid(originSpanCtx) ? [{ context: originSpanCtx }] : [],
          },
          otelContext.active(),
        );
        span.end();
        result.push({ msg, ctx: trace.setSpan(otelContext.active(), span) });
      }
    } finally {
      await fetched.close();
    }

    return result;
  }
}
