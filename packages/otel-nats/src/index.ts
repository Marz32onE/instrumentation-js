import {
  type Context,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import {
  connect as natsConnect,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
  type NodeConnectionOptions,
  headers as natsHeaders,
} from '@nats-io/transport-node';
import type { ConnectionOptions as CoreConnectionOptions, WsConnectionOptions } from '@nats-io/nats-core';

import { natsHeaderGetter, natsHeaderSetter } from './carrier.js';
import { publishAttrs, receiveAttrs, SCOPE_NAME } from './attributes.js';
import {
  type NatsInstrumentationOptions,
  resolvePropagator,
  resolveTracerProvider,
} from './options.js';
import { version } from './version.js';

export type { NatsInstrumentationOptions };
export type { NodeConnectionOptions };
export { natsHeaderGetter, natsHeaderSetter } from './carrier.js';
/** Core client connection options (from @nats-io/nats-core), for typing {@link wsconnect} alongside {@link WsConnectionOptions}. */
export type { CoreConnectionOptions, WsConnectionOptions };

/**
 * Connect to NATS with OTel trace propagation.
 * Mirrors Go version's otelnats.Connect().
 * Uses {@link https://github.com/nats-io/nats.js | @nats-io/transport-node} (nats.js v3) TCP transport.
 */
export async function connect(
  opts?: NodeConnectionOptions,
  traceOpts?: NatsInstrumentationOptions,
): Promise<OtelNatsConn> {
  const nc = await natsConnect(opts);
  return new OtelNatsConn(nc, traceOpts);
}

/**
 * Connect over W3C WebSocket (browser / Deno / Node with global WebSocket).
 * Requires peer dependency `@nats-io/nats-core`. Trace context uses NATS message headers
 * the same as {@link connect}.
 *
 * @see https://nats-io.github.io/nats.js/core/functions/wsconnect.html
 */
export async function wsconnect(
  opts?: WsConnectionOptions | CoreConnectionOptions,
  traceOpts?: NatsInstrumentationOptions,
): Promise<OtelNatsConn> {
  const { wsconnect: natsWsConnect, headers: coreHeaders } = await import('@nats-io/nats-core');
  const nc = await natsWsConnect(opts);
  return new OtelNatsConn(nc, traceOpts, () => coreHeaders());
}

export class OtelNatsConn {
  readonly #nc: NatsConnection;
  readonly #traceOpts: NatsInstrumentationOptions | undefined;
  readonly #createHeaders: () => MsgHdrs;
  readonly #serverAddress: string;

  constructor(
    nc: NatsConnection,
    traceOpts?: NatsInstrumentationOptions,
    createHeaders?: () => MsgHdrs,
  ) {
    this.#nc = nc;
    this.#traceOpts = traceOpts;
    this.#createHeaders = createHeaders ?? (() => natsHeaders());
    this.#serverAddress = OtelNatsConn.#parseServerAddress(nc);
  }

  static #parseServerAddress(nc: NatsConnection): string {
    try {
      const url = new URL(nc.getServer());
      return url.hostname;
    } catch {
      return nc.getServer();
    }
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

  /** Returns the cached server hostname for span attributes. */
  serverAddress(): string {
    return this.#serverAddress;
  }

  async close(): Promise<void> {
    await this.#nc.close();
  }

  async drain(): Promise<void> {
    await this.#nc.drain();
  }

  /**
   * Publish with a PRODUCER span (fire-and-forget).
   * Injects W3C trace context into NATS message headers.
   * Span name: "{subject} send"
   *
   * This is synchronous — `NatsConnection.publish()` does not return a
   * Promise. Throws synchronously if the connection is closed.
   */
  publish(
    ctx: Context,
    subject: string,
    data?: Uint8Array,
  ): void {
    const { tracer, propagator } = this.traceContext();
    const serverAddress = this.serverAddress();
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
    const hdrs = this.#createHeaders();
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
        `${subject} process`,
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
      `${subject} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: publishAttrs(subject, bodySize, serverAddress),
      },
      ctx,
    );
    const spanCtx = trace.setSpan(ctx, span);
    const hdrs = this.#createHeaders();
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
