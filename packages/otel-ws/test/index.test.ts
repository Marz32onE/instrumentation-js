import { AddressInfo } from 'net';

import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ROOT_CONTEXT, context, propagation, trace } from '@opentelemetry/api';
import WebSocket, { WebSocketServer } from 'ws';

import { connect, instrumentSocket } from '../src/index.js';

function setupOTel() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });
  return {
    exporter,
    provider,
    teardown: () => {
      provider.shutdown();
      propagation.disable();
      trace.disable();
    },
  };
}

describe('otel-ws', () => {
  let teardown: () => void;
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    const setup = setupOTel();
    teardown = setup.teardown;
    provider = setup.provider;
    exporter = setup.exporter;
  });

  afterEach(() => teardown());

  it('injects traceparent on send (client)', async () => {
    let resolveFirst: ((msg: string) => void) | null = null;
    const firstMessage = new Promise<string>((resolve) => (resolveFirst = resolve));
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        if (resolveFirst) resolveFirst(data.toString());
      });
    });
    const port = (wss.address() as AddressInfo).port;

    const client = await connect(`ws://127.0.0.1:${port}`);
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('parent', {}, ROOT_CONTEXT);
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      client.send({ hello: 'world' });
    });

    const raw = await firstMessage;
    const parsed = JSON.parse(raw) as { traceparent?: string; data: unknown };
    expect(parsed.traceparent).toBeDefined();
    expect(parsed.traceparent).toContain(span.spanContext().traceId);
    expect(parsed.data).toEqual({ hello: 'world' });

    span.end();
    client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('extracts context on receive and creates consumer span', async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            traceparent:
              '00-12345678901234567890123456789012-0123456789012345-01',
            data: { body: 'from server' },
          }),
        );
      }, 20);
    });
    const port = (wss.address() as AddressInfo).port;
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));

    const socket = instrumentSocket<unknown, { body: string }>(raw);
    const traceId = await new Promise<string | undefined>((resolve) => {
      socket.onMessage(() => {
        resolve(trace.getSpanContext(context.active())?.traceId);
      });
    });

    expect(traceId).toBe('12345678901234567890123456789012');
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    socket.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
