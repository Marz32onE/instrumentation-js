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
const OTEL_WS_PROTOCOL = 'otel-ws';

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
      void provider.shutdown();
      propagation.disable();
      trace.disable();
    },
  };
}

function startEchoServer(supportsOtel = false) {
  const wss = new WebSocketServer({
    port: 0,
    ...(supportsOtel
      ? {
          handleProtocols: (protocols: Set<string>) =>
            protocols.has(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false,
        }
      : {}),
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(data.toString()));
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

function startCaptureServer(supportsOtel = false) {
  let resolveFirst: ((msg: string) => void) | null = null;
  const firstMessage = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });

  const wss = new WebSocketServer({
    port: 0,
    ...(supportsOtel
      ? {
          handleProtocols: (protocols: Set<string>) =>
            protocols.has(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false,
        }
      : {}),
  });
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

function startSendingServer(messageToSend: string, supportsOtel = false) {
  const wss = new WebSocketServer({
    port: 0,
    ...(supportsOtel
      ? {
          handleProtocols: (protocols: Set<string>) =>
            protocols.has(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false,
        }
      : {}),
  });
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

  it('sends envelope format with traceparent in header on next()', async () => {
    const server = startCaptureServer(true);
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // envelope format: trace headers in `header`, user data in `data`
    expect(parsed.header).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent as string).toContain(span.spanContext().traceId);
    expect(parsed.data).toEqual({ body: 'hello' });
    // trace fields must NOT appear at top level
    expect(parsed.traceparent).toBeUndefined();

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

  it('falls back to native serializer when protocol is not negotiated', async () => {
    let resolveFirst: ((msg: string) => void) | null = null;
    const firstMessage = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const wss = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has('json') ? 'json' : false,
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        if (resolveFirst) {
          resolveFirst(data.toString());
          resolveFirst = null;
        }
      });
    });
    const port = (wss.address() as AddressInfo).port;
    const ws = webSocket<{ plain: boolean }>({
      url: `ws://127.0.0.1:${port}`,
      WebSocketCtor: WS_CTOR,
      protocol: 'json',
      prependOtelSubprotocol: false,
    });
    const sub = ws.subscribe();
    ws.next({ plain: true });

    const raw = await firstMessage;
    expect(JSON.parse(raw)).toEqual({ plain: true });

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.send')).toBeTruthy();

    sub.unsubscribe();
    ws.complete();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('creates a CONSUMER span on receive', async () => {
    const msg = JSON.stringify({
      header: { traceparent: '00-12345678901234567890123456789012-0123456789012345-01' },
      data: { body: 'from server' },
    });
    const server = startSendingServer(msg, true);
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
      header: { traceparent: '00-12345678901234567890123456789012-0123456789012345-01' },
      data: { body: 'from server' },
    });
    const server = startSendingServer(msg, true);
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

  it('propagates trace context in a round-trip (object payload)', async () => {
    const server = startEchoServer(true);
    const ws = webSocket<{ body: string }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const msgPromise = firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('client', {}, ROOT_CONTEXT);
    const ctx = trace.setSpan(ROOT_CONTEXT, span);

    context.with(ctx, () => {
      ws.next({ body: 'round-trip' });
    });

    const received = await msgPromise;
    expect(received).toEqual({ body: 'round-trip' });

    const spans = exporter.getFinishedSpans();
    const recvSpan = spans.find((s) => s.name === 'websocket.receive');
    expect(recvSpan?.spanContext().traceId).toBe(span.spanContext().traceId);

    span.end();
    ws.complete();
    await server.close();
  });

  it('wraps string payload in envelope with trace context on next()', async () => {
    const server = startCaptureServer(true);
    const ws = webSocket<string>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const sub = ws.subscribe();
    ws.next('round-trip');
    const raw = await server.firstMessage;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // string payloads are now wrapped in envelope
    expect(parsed.header).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect(parsed.data).toBe('round-trip');
    expect(parsed.traceparent).toBeUndefined();

    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('string payload round-trips correctly through envelope', async () => {
    const server = startEchoServer(true);
    const ws = webSocket<string>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const msgPromise = firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));
    ws.subscribe();
    ws.next('hello string');

    const received = await msgPromise;
    expect(received).toBe('hello string');

    ws.complete();
    await server.close();
  });

  it('array payload round-trips correctly through envelope', async () => {
    const server = startEchoServer(true);
    const ws = webSocket<number[]>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const msgPromise = firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));
    ws.subscribe();
    ws.next([1, 2, 3]);

    const received = await msgPromise;
    expect(received).toEqual([1, 2, 3]);

    ws.complete();
    await server.close();
  });

  it('handles messages without trace context (non-envelope)', async () => {
    const msg = JSON.stringify({ value: 42 });
    const server = startSendingServer(msg);
    const ws = webSocket<{ value: number }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const received = await firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));

    // Non-envelope message delivered as-is
    expect(received).toEqual({ value: 42 });

    ws.complete();
    await server.close();
  });

  it('falls back to native deserializer when protocol is not negotiated', async () => {
    const server = startSendingServer(JSON.stringify({ plain: 'recv' }), false);
    const ws = webSocket<{ plain: string }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });

    const received = await firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));
    expect(received).toEqual({ plain: 'recv' });
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    ws.complete();
    await server.close();
  });

  it('matches rxjs factory: webSocket({ url, WebSocketCtor })', async () => {
    const server = startCaptureServer(true);
    const ws = webSocket({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });
    const sub = ws.subscribe();
    ws.next({ x: 1 });
    const raw = await server.firstMessage;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect(parsed.data).toEqual({ x: 1 });
    expect(parsed.traceparent).toBeUndefined();
    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('records ERROR status when custom deserializer throws', async () => {
    const msg = JSON.stringify({
      header: { traceparent: '00-12345678901234567890123456789012-0123456789012345-01' },
      data: { body: 'boom' },
    });
    const server = startSendingServer(msg, true);
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

  it('all original fields preserved inside envelope data', async () => {
    const server = startCaptureServer(true);
    const ws = webSocket<{ msg: string; version: string; support: string[] }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
    });
    const sub = ws.subscribe();

    ws.next({ msg: 'connect', version: '1', support: ['1'] });
    const raw = await server.firstMessage;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect(parsed.data).toEqual({ msg: 'connect', version: '1', support: ['1'] });
    // no top-level leakage
    expect(parsed.traceparent).toBeUndefined();
    expect(parsed.msg).toBeUndefined();

    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('provides correct receive context for two consecutive messages', async () => {
    const msg1 = JSON.stringify({
      header: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001-01' },
      data: { body: 'first' },
    });
    const msg2 = JSON.stringify({
      header: { traceparent: '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000002-01' },
      data: { body: 'second' },
    });

    const wss = new (await import('ws')).WebSocketServer({
      port: 0,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false,
    });
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

  it('user serializer output is wrapped in envelope', async () => {
    const server = startCaptureServer(true);
    const ws = webSocket<{ val: number }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
      serializer: (v) => JSON.stringify(v),
    });
    const sub = ws.subscribe();
    ws.next({ val: 99 });
    const raw = await server.firstMessage;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed.header).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect(parsed.data).toEqual({ val: 99 });

    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('logs warning and sets ERROR span status when serializer returns non-string', async () => {
    const server = startCaptureServer(true);
    const ws = webSocket<{ val: number }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
      // Return an ArrayBuffer — valid for ws.send() so the socket stays open,
      // but not a string, so our code sets ERROR status on the span.
      serializer: () => new ArrayBuffer(4) as unknown as string,
    });

    const sub = ws.subscribe();
    ws.next({ val: 42 });
    await server.firstMessage; // wait until the non-string value reaches the server

    const spans = exporter.getFinishedSpans();
    const sendSpan = spans.find((s) => s.name === 'websocket.send');
    expect(sendSpan).toBeDefined();
    expect(sendSpan!.status.code).toBe(SpanStatusCode.ERROR);

    sub.unsubscribe();
    ws.complete();
    await server.close();
  });

  it('provides correct receive context for many rapid consecutive messages', async () => {
    const COUNT = 10;
    // Use trace IDs with repeated hex pairs — easy to read, valid W3C (non-zero)
    const traceIds = Array.from({ length: COUNT }, (_, i) => {
      const byte = (i + 1).toString(16).padStart(2, '0');
      return byte.repeat(16);
    });
    const messages = traceIds.map((tid, i) => {
      const spanId = (i + 1).toString(16).padStart(16, '0');
      return JSON.stringify({
        header: { traceparent: `00-${tid}-${spanId}-01` },
        data: { index: i },
      });
    });

    const wss = new (await import('ws')).WebSocketServer({
      port: 0,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false,
    });
    wss.on('connection', (client) => {
      // Small delay so the client's openObserver fires and sets _otelProtocolActive
      // before any messages are processed, then send all at once to stress the queue.
      setTimeout(() => {
        for (const msg of messages) client.send(msg);
      }, 20);
    });
    const { port } = wss.address() as import('net').AddressInfo;

    const ws = webSocket<{ index: number }>({
      url: `ws://127.0.0.1:${port}`,
      WebSocketCtor: WS_CTOR,
    });

    const receivedTraceIds: (string | undefined)[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), TEST_TIMEOUT);
      ws.subscribe({
        next: () => {
          receivedTraceIds.push(trace.getSpanContext(context.active())?.traceId);
          if (receivedTraceIds.length === COUNT) {
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });

    for (let i = 0; i < COUNT; i++) {
      expect(receivedTraceIds[i]).toBe(traceIds[i]);
    }

    ws.complete();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('user deserializer receives envelope data field', async () => {
    const msg = JSON.stringify({
      header: { traceparent: '00-12345678901234567890123456789012-0123456789012345-01' },
      data: { transformed: true },
    });
    const server = startSendingServer(msg, true);

    let deserializerInput: string | undefined;
    const ws = webSocket<{ transformed: boolean }>({
      url: `ws://127.0.0.1:${server.port}`,
      WebSocketCtor: WS_CTOR,
      deserializer: (e: MessageEvent) => {
        deserializerInput = e.data as string;
        return JSON.parse(e.data as string) as { transformed: boolean };
      },
    });

    const received = await firstValueFrom(ws.pipe(timeout(TEST_TIMEOUT)));
    expect(received).toEqual({ transformed: true });
    // The deserializer should receive the inner data field as JSON string
    expect(deserializerInput).toBe(JSON.stringify({ transformed: true }));

    ws.complete();
    await server.close();
  });
});
