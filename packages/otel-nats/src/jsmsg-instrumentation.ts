import {
  type Context,
  type Span,
  SpanKind,
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import type { JsMsg } from '@nats-io/jetstream';

import { natsHeaderGetter } from './carrier.js';
import { receiveAttrs } from './attributes.js';
import { setJetStreamMessageTraceContext } from './msg-trace.js';

/** Minimal surface needed to trace JetStream messages (avoids circular imports). */
export type JetStreamTraceConn = {
  traceContext(): {
    tracer: {
      startSpan: (
        name: string,
        options: Record<string, unknown>,
        ctx: Context,
      ) => Span;
    };
    propagator: {
      extract: (ctx: Context, carrier: unknown, getter: typeof natsHeaderGetter) => Context;
    };
  };
  serverAddress(): string;
};

export type JsMsgSpanMode = 'receive' | 'process';

/**
 * Start a CONSUMER span for a JetStream message (extract + link).
 * Does not end the span — caller manages lifecycle (lastSpan vs immediate end).
 */
export function startJsMsgConsumerSpan(
  conn: JetStreamTraceConn,
  msg: JsMsg,
  consumerName: string,
  mode: JsMsgSpanMode,
): Span {
  const { tracer, propagator } = conn.traceContext();
  const serverAddress = conn.serverAddress();
  const hdrs = msg.headers;
  const extractedCtx = hdrs
    ? propagator.extract(otelContext.active(), hdrs, natsHeaderGetter)
    : otelContext.active();
  const originSpanCtx = trace.getSpanContext(extractedCtx);
  const bodySize = msg.data?.length ?? 0;
  const op = mode === 'process' ? 'process' : 'receive';
  return tracer.startSpan(
    `${msg.subject} ${op}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        ...receiveAttrs(msg.subject, op, bodySize, serverAddress),
        'messaging.consumer.name': consumerName,
      },
      links: originSpanCtx && isSpanContextValid(originSpanCtx) ? [{ context: originSpanCtx }] : [],
    },
    otelContext.active(),
  );
}

export function contextWithEndedSpan(span: Span): Context {
  return trace.setSpan(otelContext.active(), span);
}

export function attachJsMsgContext(msg: JsMsg, ctx: Context): void {
  setJetStreamMessageTraceContext(msg, ctx);
}
