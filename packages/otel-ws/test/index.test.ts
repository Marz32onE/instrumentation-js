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
import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import WsPkg from 'ws';

import WebSocket, { instrumentSocket } from '../src/index.js';

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
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        if (resolveFirst) resolveFirst(data.toString());
      });
    });
    const port = (wss.address() as AddressInfo).port;

    const client = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('parent', {}, ROOT_CONTEXT);
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      client.send({ hello: 'world' });
    });

    const raw = await firstMessage;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // flat format: traceparent injected alongside original fields
    expect(parsed.traceparent).toBeDefined();
    expect(parsed.traceparent as string).toContain(span.spanContext().traceId);
    expect(parsed.hello).toBe('world');
    expect(parsed.data).toBeUndefined();
    expect(parsed.payload).toBeUndefined();

    span.end();
    client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('extracts context on receive and creates consumer span', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            traceparent: '00-12345678901234567890123456789012-0123456789012345-01',
            body: 'from server',
          }),
        );
      }, 20);
    });
    const port = (wss.address() as AddressInfo).port;
    const traceId = await new Promise<string | undefined>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('message', () => {
        resolve(trace.getSpanContext(context.active())?.traceId);
      });
    });

    expect(traceId).toBe('12345678901234567890123456789012');
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    // client closed by test process
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('patches native ws.on("message") and keeps extracted context', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
            body: 'native-handler',
          }),
        );
      }, 20);
    });
    const port = (wss.address() as AddressInfo).port;
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

    const traceId = await new Promise<string | undefined>((resolve) => {
      socket.on('message', () => {
        resolve(trace.getSpanContext(context.active())?.traceId);
      });
    });

    expect(traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    socket.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('records error and sets ERROR status when send fails', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    const client = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

    // Terminate the socket abruptly, then wait for CLOSED state
    client.terminate();
    await new Promise<void>((r) => client.once('close', r));

    // ws.send() on a CLOSED socket calls callback with error on nextTick
    await new Promise<void>((resolve) => {
      client.send({ hello: 'world' }, (err) => {
        expect(err).toBeDefined();
        resolve();
      });
    });

    const spans = exporter.getFinishedSpans();
    const sendSpan = spans.find((s) => s.name === 'websocket.send');
    expect(sendSpan).toBeDefined();
    expect(sendSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(sendSpan!.events.some((e) => e.name === 'exception')).toBeTruthy();

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('handles plain text message without trace context', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      setTimeout(() => ws.send('plain text'), 20);
    });
    const port = (wss.address() as AddressInfo).port;
    const received = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('message', (data) => resolve(data as string));
    });

    expect(received).toBe('plain text');

    // no-op
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('injects trace in Buffer.concat(Sender.frame(...)) via _sender.sendFrame patch', async () => {
    let resolveFirst: ((msg: string) => void) | null = null;
    const firstMessage = new Promise<string>((resolve) => (resolveFirst = resolve));
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        if (resolveFirst) resolveFirst(data.toString());
      });
    });
    const port = (wss.address() as AddressInfo).port;
    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));

    const tracer = provider.getTracer('test-native-frame');
    const parent = tracer.startSpan('native-parent', {}, ROOT_CONTEXT);
    const senderCtor = (WsPkg as unknown as {
      Sender?: { frame: (data: Buffer, options: unknown) => Buffer[] };
    }).Sender;
    if (!senderCtor?.frame) {
      throw new Error('ws Sender.frame unavailable');
    }

    const options = {
      fin: true,
      rsv1: false,
      opcode: 1,
      mask: false,
      readOnly: false,
    };
    const mergedFrame = Buffer.concat(senderCtor.frame(Buffer.from(JSON.stringify({ hello: 'frame' }), 'utf8'), options));

    await new Promise<void>((resolve, reject) => {
      context.with(trace.setSpan(ROOT_CONTEXT, parent), () => {
        (raw as unknown as {
          _sender?: { sendFrame: (list: Buffer[], cb?: (err?: Error) => void) => void };
        })._sender?.sendFrame([mergedFrame], (err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    parent.end();
    const wire = await firstMessage;
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(parsed.traceparent).toBeDefined();
    expect(parsed.hello).toBe('frame');

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.send')).toBeTruthy();
    raw.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('instruments server socket for receive/send/sendFrame', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    const receiveTraceIds: Array<string | undefined> = [];

    wss.on('connection', (rawWs) => {
      const ws = instrumentSocket(rawWs as unknown as WebSocket);
      ws.on('message', (msg) => {
        receiveTraceIds.push(trace.getSpanContext(context.active())?.traceId);

        ws.send({ ack: true, via: 'send' });

        const senderCtor = (WsPkg as unknown as {
          Sender?: { frame: (data: Buffer, options: unknown) => Buffer[] };
        }).Sender;
        const sender = (ws as unknown as {
          _sender?: { sendFrame: (list: Buffer[], cb?: (err?: Error) => void) => void };
        })._sender;
        if (!senderCtor?.frame || !sender?.sendFrame) return;

        const options = {
          fin: true,
          rsv1: false,
          opcode: 1,
          mask: false,
          readOnly: false,
        };
        const merged = Buffer.concat(
          senderCtor.frame(Buffer.from(JSON.stringify({ ack: true, via: 'sendFrame' }), 'utf8'), options),
        );
        sender.sendFrame([merged]);
      });
    });

    const port = (wss.address() as AddressInfo).port;
    const client = await new Promise<WsPkg>((resolve, reject) => {
      const ws = new WsPkg(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

    const wireMessages = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      client.on('message', (data) => {
        received.push(data.toString());
        if (received.length === 2) resolve(received);
      });
      client.send(
        JSON.stringify({
          text: 'from client',
          traceparent: '00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01',
        }),
        (err) => err && reject(err),
      );
    });

    const parsed = wireMessages.map((w) => JSON.parse(w) as Record<string, unknown>);
    expect(parsed.every((m) => typeof m.traceparent === 'string')).toBeTruthy();
    expect(receiveTraceIds[0]).toBe('cccccccccccccccccccccccccccccccc');

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();
    expect(spans.filter((s) => s.name === 'websocket.send').length).toBeGreaterThanOrEqual(2);

    client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
