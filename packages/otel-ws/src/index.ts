import {
  Context,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  trace,
} from '@opentelemetry/api';
import WebSocket from 'ws';

import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  WireMessage,
  deserializeMessage,
} from './message.js';
import { getTracerProvider } from './options.js';
import { version } from './version.js';

export type MessageHandler<T = unknown> = (data: T, ctx: Context) => void;

export interface InstrumentedSocket<TSend = unknown, TReceive = unknown> {
  readonly raw: WebSocket;
  send(data: TSend, cb?: (err?: Error) => void): void;
  onMessage(handler: MessageHandler<TReceive>): () => void;
  close(code?: number, reason?: string): void;
}

export function connect(url: string): Promise<InstrumentedSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onOpen = () => {
      ws.off('error', onErr);
      resolve(instrumentSocket(ws));
    };
    const onErr = (err: Error) => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onErr);
  });
}

export function instrumentSocket<TSend = unknown, TReceive = unknown>(
  ws: WebSocket,
): InstrumentedSocket<TSend, TReceive> {
  const tracer = getTracerProvider().getTracer('@marz32one/otel-ws', version());

  const send = (data: TSend, cb?: (err?: Error) => void) => {
    const activeCtx = otelContext.active();
    const span = tracer.startSpan(
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

    let serialized: string;
    try {
      const carrier: Record<string, string> = {};
      propagation.inject(spanCtx, carrier, defaultTextMapSetter);

      const wire: WireMessage<TSend> = { data };
      const tp = carrier[TRACEPARENT_HEADER];
      const ts = carrier[TRACESTATE_HEADER];
      if (tp) wire.traceparent = tp;
      if (ts) wire.tracestate = ts;

      serialized = JSON.stringify(wire);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.end();
      cb?.(err as Error);
      return;
    }

    ws.send(serialized, (sendErr) => {
      if (sendErr) {
        span.recordException(sendErr);
        span.setStatus({ code: SpanStatusCode.ERROR, message: sendErr.message });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
      cb?.(sendErr);
    });
  };

  const onMessage = (handler: MessageHandler<TReceive>) => {
    const listener = (raw: WebSocket.Data) => {
      const body =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : raw.toString();
      const parsed = deserializeMessage<TReceive>(body);

      const carrier: Record<string, string> = {};
      if (parsed.traceparent) carrier[TRACEPARENT_HEADER] = parsed.traceparent;
      if (parsed.tracestate) carrier[TRACESTATE_HEADER] = parsed.tracestate;

      const hasTrace = Object.keys(carrier).length > 0;
      const baseCtx = otelContext.active();
      const senderCtx = hasTrace
        ? propagation.extract(baseCtx, carrier, defaultTextMapGetter)
        : baseCtx;

      const span = tracer.startSpan(
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
      span.end();

      otelContext.with(outCtx, () => handler(parsed.data, outCtx));
    };

    ws.on('message', listener);
    return () => ws.off('message', listener);
  };

  return {
    raw: ws,
    send,
    onMessage,
    close: (code?: number, reason?: string) => ws.close(code, reason),
  };
}
