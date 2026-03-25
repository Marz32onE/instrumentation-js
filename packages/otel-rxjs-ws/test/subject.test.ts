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
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import WS, { WebSocketServer } from 'ws';
import { firstValueFrom, timeout } from 'rxjs';

import { webSocket } from '../src/index.js';

const WS_CTOR = WS as unknown as typeof WebSocket;
const TEST_TIMEOUT = 5_000;

function setupOTel() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register({
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
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

function startEchoServer() {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(data.toString()));
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function startCaptureServer() {
  let resolveFirst: ((msg: string) => void) | null = null;
  const firstMessage = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });

  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const str = data.toString();
      if (resolveFirst) {
        resolveFirst(str);
        resolveFirst = null;
      }
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    firstMessage,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function startSendingServer(messageToSend: string) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => ws.send(messageToSend));
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

describe('webSocket (rxjs/webSocket compatible surface)', () => {
  let teardown: () => void;
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    const setup = setupOTel();
    teardown = setup.teardown;
    provider = setup.provider;
    exporter = setup.exporter;
  });

  afterEach(() => {
    teardown();
  });

  it('embeds traceparent in the JSON body on next()', async () => {
    const server = startCaptureServer();
    const ws = webSocket<{ body: string }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const sub = ws.subscribe();

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('parent', {}, ROOT_CONTEXT);
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    context.with(ctx, () => {
      ws.next({ body: 'hello' });
    });

    const raw = await server.firstMessage;
    const parsed = JSON.parse(raw);

    expect(parsed.traceparent).toBeDefined();
    expect(parsed.traceparent).toContain(span.spanContext().traceId);
    expect(parsed.data).toEqual({ body: 'hello' });

    span.end();
    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('creates a PRODUCER span on next()', async () => {
    const server = startCaptureServer();
    const ws = webSocket<string>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const sub = ws.subscribe();
    ws.next('test-msg');
    await server.firstMessage;

    const spans = exporter.getFinishedSpans();
    const sendSpan = spans.find((s) => s.name === 'websocket.send');
    expect(sendSpan).toBeDefined();
    expect(sendSpan!.kind).toBe(SpanKind.PRODUCER);

    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('creates a CONSUMER span on receive', async () => {
    const msg = JSON.stringify({
      traceparent:
        '00-12345678901234567890123456789012-0123456789012345-01',
      data: { body: 'from server' },
    });
    const server = startSendingServer(msg);
    const ws = webSocket<{ body: string }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const received = await firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));

    expect(received).toEqual({ body: 'from server' });

    const spans = exporter.getFinishedSpans();
    const recvSpan = spans.find((s) => s.name === 'websocket.receive');
    expect(recvSpan).toBeDefined();
    expect(recvSpan!.kind).toBe(SpanKind.CONSUMER);

    ws.complete();
    await server.close();
  });

  it('sets active context in subscribe next (trace id)', async () => {
    const msg = JSON.stringify({
      traceparent:
        '00-12345678901234567890123456789012-0123456789012345-01',
      data: { body: 'from server' },
    });
    const server = startSendingServer(msg);
    const ws = webSocket<{ body: string }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const tidPromise = new Promise<string | undefined>((resolve) => {
      ws.subscribe({
        next: () => {
          resolve(trace.getSpanContext(context.active())?.traceId);
        },
      });
    });

    const tid = await Promise.race([
      tidPromise,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), TEST_TIMEOUT)),
    ]);

    expect(tid).toBe('12345678901234567890123456789012');

    ws.complete();
    await server.close();
  });

  it('handles header-style envelope on receive', async () => {
    const payload = Buffer.from(
      JSON.stringify({ body: 'hello', api: 'Test' }),
    ).toString('base64');
    const msg = JSON.stringify({
      headers: {
        traceparent:
          '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      },
      payload,
    });
    const server = startSendingServer(msg);
    const ws = webSocket<{ body: string; api: string }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const received = await firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));

    expect(received).toEqual({ body: 'hello', api: 'Test' });

    ws.complete();
    await server.close();
  });

  it('propagates trace context in a round-trip', async () => {
    const server = startEchoServer();
    const ws = webSocket<string>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const msgPromise = firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('client', {}, ROOT_CONTEXT);
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    context.with(ctx, () => {
      ws.next('round-trip');
    });

    const received = await msgPromise;
    expect(received).toBe('round-trip');

    const spans = exporter.getFinishedSpans();
    const recvSpan = spans.find((s) => s.name === 'websocket.receive');
    expect(recvSpan?.spanContext().traceId).toBe(span.spanContext().traceId);

    span.end();
    ws.complete();
    await server.close();
  });

  it('handles messages without trace context', async () => {
    const msg = JSON.stringify({ value: 42 });
    const server = startSendingServer(msg);
    const ws = webSocket<{ value: number }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const received = await firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));

    expect(received).toEqual({ value: 42 });

    ws.complete();
    await server.close();
  });

  it('matches rxjs factory: webSocket({ url, WebSocketCtor })', async () => {
    const server = startCaptureServer();
    const ws = webSocket({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });
    const sub = ws.subscribe();
    ws.next({ x: 1 });
    const raw = await server.firstMessage;
    const parsed = JSON.parse(raw);
    expect(parsed.data).toEqual({ x: 1 });
    expect(parsed.traceparent).toBeDefined();
    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('records ERROR status when custom deserializer throws', async () => {
    const msg = JSON.stringify({
      traceparent: '00-12345678901234567890123456789012-0123456789012345-01',
      data: 'boom',
    });
    const server = startSendingServer(msg);
    const ws = webSocket<string>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
      deserializer: () => {
        throw new Error('deserializer failed');
      },
    });

    await new Promise<void>((resolve) => {
      ws.subscribe({ error: () => resolve() });
    });

    const spans = exporter.getFinishedSpans();
    const recvSpan = spans.find((s) => s.name === 'websocket.receive');
    expect(recvSpan).toBeDefined();
    expect(recvSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(recvSpan!.events.some((e) => e.name === 'exception')).toBeTruthy();

    ws.complete();
    await server.close();
  });

  it('provides correct receive context for two consecutive messages', async () => {
    const msg1 = JSON.stringify({
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001-01',
      data: 'first',
    });
    const msg2 = JSON.stringify({
      traceparent: '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000002-01',
      data: 'second',
    });

    const wss = new (await import('ws')).WebSocketServer({ port: 0 });
    wss.on('connection', (client) => {
      setTimeout(() => client.send(msg1), 20);
      setTimeout(() => client.send(msg2), 40);
    });
    const { port } = wss.address() as import('net').AddressInfo;

    const ws = webSocket<string>({
      url: `ws://127.0.0.1:${port}`,
      WebSocketCtor: WS_CTOR,
    });

    const receivedTraceIds: (string | undefined)[] = [];
    await new Promise<void>((resolve) => {
      let count = 0;
      ws.subscribe({
        next: () => {
          receivedTraceIds.push(trace.getSpanContext(context.active())?.traceId);
          if (++count === 2) resolve();
        },
      });
    });

    expect(receivedTraceIds[0]).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(receivedTraceIds[1]).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    ws.complete();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
