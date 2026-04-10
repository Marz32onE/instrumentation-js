import {
  type Context,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import type { ConnectionOptions, Msg, NatsConnection } from 'nats';
import { connect as natsConnect, headers } from 'nats';

import { natsHeaderGetter, natsHeaderSetter } from './carrier.js';
import { publishAttrs, receiveAttrs, SCOPE_NAME } from './attributes.js';
import {
  type NatsInstrumentationOptions,
  resolvePropagator,
  resolveTracerProvider,
} from './options.js';
import { version } from './version.js';

export type { NatsInstrumentationOptions };
export { natsHeaderGetter, natsHeaderSetter } from './carrier.js';

/**
 * Connect to NATS with OTel trace propagation.
 * Mirrors Go version's otelnats.Connect().
 */
export async function connect(
  opts?: ConnectionOptions,
  traceOpts?: NatsInstrumentationOptions,
): Promise<Conn> {
  const nc = await natsConnect(opts);
  return new Conn(nc, traceOpts);
}

export class Conn {
  readonly #nc: NatsConnection;
  readonly #traceOpts: NatsInstrumentationOptions | undefined;

  constructor(nc: NatsConnection, traceOpts?: NatsInstrumentationOptions) {
    this.#nc = nc;
    this.#traceOpts = traceOpts;
  }

  /** Returns the underlying NatsConnection. Used by JetStream and tests. */
  natsConn(): NatsConnection {
    return this.#nc;
  }

  /**
   * Returns the tracer and propagator for this connection.
   * Resolves the global provider/propagator on each call so tests can swap
   * globals between cases without reconnecting.
   */
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

  /** Extracts the server hostname for span attributes. */
  serverAddress(): string {
    try {
      const url = new URL(this.#nc.getServer());
      return url.hostname;
    } catch {
      return this.#nc.getServer();
    }
  }

  async close(): Promise<void> {
    await this.#nc.close();
  }

  async drain(): Promise<void> {
    await this.#nc.drain();
  }

  /**
   * Publish with a PRODUCER span.
   * Injects W3C trace context into NATS message headers.
   * Span name: "send {subject}"
   */
  async publish(
    ctx: Context,
    subject: string,
    data?: Uint8Array,
  ): Promise<void> {
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const bodySize = data?.length ?? 0;

    const span = tracer.startSpan(
      `send ${subject}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    const hdrs = headers();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    try {
      this.#nc.publish(subject, data, { headers: hdrs });
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
   * Subscribe and yield instrumented messages as an async generator.
   * Each yielded message carries a CONSUMER span in its ctx.
   * The span ends when the next message arrives (or the loop exits).
   *
   * Passing opts.queue is equivalent to QueueSubscribe in the Go version.
   *
   * Example:
   *   for await (const { msg, ctx } of conn.subscribe('foo')) {
   *     // use ctx for child spans
   *   }
   */
  async *subscribe(
    subject: string,
    opts?: { queue?: string },
  ): AsyncGenerator<{ msg: Msg; ctx: Context }> {
    const sub = this.#nc.subscribe(subject, {
      ...(opts?.queue ? { queue: opts.queue } : {}),
    });

    for await (const msg of sub) {
      const { tracer, propagator } = this.traceContext();
      const serverAddress = this.serverAddress();

      const hdrs = msg.headers;
      const extractedCtx = hdrs
        ? propagator.extract(otelContext.active(), hdrs, natsHeaderGetter)
        : otelContext.active();

      const originSpanCtx = trace.getSpanContext(extractedCtx);
      const bodySize = msg.data?.length ?? 0;

      const span = tracer.startSpan(
        `process ${subject}`,
        {
          kind: SpanKind.CONSUMER,
          attributes: receiveAttrs(
            subject,
            'process',
            bodySize,
            serverAddress,
            opts?.queue,
          ),
          links: originSpanCtx && isSpanContextValid(originSpanCtx) ? [{ context: originSpanCtx }] : [],
        },
        otelContext.active(),
      );

      try {
        yield { msg, ctx: trace.setSpan(otelContext.active(), span) };
      } finally {
        span.end();
      }
    }
  }

  /**
   * Request-reply with a PRODUCER span.
   * Mirrors Go version's Request().
   */
  async request(
    ctx: Context,
    subject: string,
    data?: Uint8Array,
    opts?: { timeout?: number },
  ): Promise<Msg> {
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
    const bodySize = data?.length ?? 0;

    const span = tracer.startSpan(
      `send ${subject}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    const hdrs = headers();
    propagator.inject(spanCtx, hdrs, natsHeaderSetter);

    try {
      const reply = await this.#nc.request(subject, data, {
        timeout: opts?.timeout ?? 5000,
        headers: hdrs,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return reply;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }
}
