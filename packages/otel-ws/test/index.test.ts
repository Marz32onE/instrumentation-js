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

import WebSocket, { instrumentSocket, userFacingProtocolFromWire } from '../src/index.js';

const OTEL_WS_PROTOCOL = 'otel-ws';

function createNegotiatingServer(): WsPkg.Server {
  return new WsPkg.Server({
    port: 0,
    handleProtocols: (protocols) => {
      const list = [...(protocols as Iterable<string>)];
      return list.includes(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false;
    },
  });
}

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
      void provider.shutdown();
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

  it('wraps payload in envelope with traceparent on send (client)', async () => {
    let resolveFirst: ((msg: string) => void) | null = null;
    const firstMessage = new Promise<string>((resolve) => (resolveFirst = resolve));
    const wss = createNegotiatingServer();
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

    // envelope format: trace headers in `header`, user data in `data`
    expect(parsed.header).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent as string).toContain(span.spanContext().traceId);
    expect(parsed.data).toEqual({ hello: 'world' });
    // trace fields must NOT appear at top level
    expect(parsed.traceparent).toBeUndefined();

    span.end();
    client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('extracts context on receive and creates consumer span', async () => {
    const wss = createNegotiatingServer();
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            header: { traceparent: '00-12345678901234567890123456789012-0123456789012345-01' },
            data: { body: 'from server' },
          }),
        );
      }, 20);
    });
    const port = (wss.address() as AddressInfo).port;
    const received = await new Promise<{ traceId: string | undefined; data: unknown }>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('message', (data) => {
        resolve({
          traceId: trace.getSpanContext(context.active())?.traceId,
          data,
        });
      });
    });

    expect(received.traceId).toBe('12345678901234567890123456789012');
    expect(received.data).toEqual({ body: 'from server' });
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('patches native ws.on("message") and keeps extracted context', async () => {
    const wss = createNegotiatingServer();
    wss.on('connection', (ws) => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            header: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
            data: { body: 'native-handler' },
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

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('wraps non-object payload (string) in envelope via _sender.sendFrame patch', async () => {
    let resolveFirst: ((msg: string) => void) | null = null;
    const firstMessage = new Promise<string>((resolve) => (resolveFirst = resolve));
    const wss = createNegotiatingServer();
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
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect(parsed.data).toEqual({ hello: 'frame' });
    expect(parsed.traceparent).toBeUndefined();

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.send')).toBeTruthy();
    raw.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('instruments server socket for receive/send/sendFrame', async () => {
    const wss = createNegotiatingServer();
    const receiveTraceIds: Array<string | undefined> = [];

    wss.on('connection', (rawWs) => {
      const ws = instrumentSocket(rawWs as unknown as WebSocket);
      ws.on('message', () => {
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
      const ws = new WsPkg(`ws://127.0.0.1:${port}`, OTEL_WS_PROTOCOL);
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
        // Send in envelope format so the server's instrumented receive can extract trace context
        JSON.stringify({
          header: { traceparent: '00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01' },
          data: { text: 'from client' },
        }),
        (err) => err && reject(err),
      );
    });

    const parsed = wireMessages.map((w) => JSON.parse(w) as Record<string, unknown>);
    // Both responses should be envelopes with traceparent in header
    expect(parsed.every((m) => typeof (m.header as Record<string, unknown>)?.traceparent === 'string')).toBeTruthy();
    expect(receiveTraceIds[0]).toBe('cccccccccccccccccccccccccccccccc');

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();
    expect(spans.filter((s) => s.name === 'websocket.send').length).toBeGreaterThanOrEqual(2);

    client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('OtelWebSocket.Server auto-instruments server sockets on connection', async () => {
    const wss = new WebSocket.Server({ port: 0 });
    const receiveTraceId = await new Promise<string | undefined>((resolve, reject) => {
      wss.on('connection', (ws) => {
        // No instrumentSocket call — auto-instrumented by OtelWebSocket.Server
        ws.on('message', () => {
          resolve(trace.getSpanContext(context.active())?.traceId);
        });
      });
      const port = (wss.address() as AddressInfo).port;
      const client = new WsPkg(`ws://127.0.0.1:${port}`, OTEL_WS_PROTOCOL);
      client.once('open', () => {
        client.send(
          JSON.stringify({
            header: { traceparent: '00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01' },
            data: { text: 'auto-instrumented' },
          }),
          (err) => { if (err) reject(err); },
        );
      });
      client.once('error', reject);
    });

    expect(receiveTraceId).toBe('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('OtelWebSocket.Server sends with trace context injected', async () => {
    const wss = new WebSocket.Server({ port: 0 });
    wss.on('connection', (ws) => {
      // No instrumentSocket call — send is auto-patched by OtelWebSocket.Server
      ws.send({ reply: true });
    });
    const port = (wss.address() as AddressInfo).port;

    const wire = await new Promise<string>((resolve, reject) => {
      const client = new WsPkg(`ws://127.0.0.1:${port}`, OTEL_WS_PROTOCOL);
      client.on('message', (data) => resolve(data.toString()));
      client.once('error', reject);
    });

    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(parsed.header).toBeDefined();
    expect((parsed.header as Record<string, unknown>).traceparent).toBeDefined();
    expect(parsed.data).toEqual({ reply: true });

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('delivers non-envelope message as-is without crashing (legacy / non-instrumented client)', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      setTimeout(() => {
        // Legacy flat format — not an envelope
        ws.send(JSON.stringify({ body: 'legacy', traceparent: '00-12345678901234567890123456789012-0123456789012345-01' }));
      }, 20);
    });
    const port = (wss.address() as AddressInfo).port;

    const received = await new Promise<{ data: unknown; traceId: string | undefined }>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('message', (data) => {
        resolve({
          data,
          traceId: trace.getSpanContext(context.active())?.traceId,
        });
      });
    });

    // Data delivered as-is (the raw parsed object)
    expect((received.data as Record<string, unknown>).body).toBe('legacy');
    // The receive span creates its own root trace — the legacy traceparent is NOT extracted
    expect(received.traceId).not.toBe('12345678901234567890123456789012');
    // A receive span is still created (with no extracted parent — it is a root span)
    const spans = exporter.getFinishedSpans();
    const recvSpan = spans.find((s) => s.name === 'websocket.receive');
    expect(recvSpan).toBeDefined();
    expect(recvSpan!.parentSpanId).toBeUndefined();

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('removes a message listener via .off() so it is no longer called', async () => {
    const wss = createNegotiatingServer();
    wss.on('connection', (ws) => {
      setTimeout(() => ws.send(
        JSON.stringify({
          header: { traceparent: '00-abababababababababababababababab01-0000000000000001-01' },
          data: { body: 'should-not-arrive' },
        }),
      ), 20);
    });
    const port = (wss.address() as AddressInfo).port;
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

    let called = false;
    const handler = () => { called = true; };
    socket.on('message', handler);
    socket.off('message', handler);

    // Give the server time to send the message
    await new Promise<void>((r) => setTimeout(r, 60));

    expect(called).toBe(false);

    socket.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('delivers binary message payload as-is (passthrough)', async () => {
    const binaryData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      setTimeout(() => ws.send(binaryData), 20);
    });
    const port = (wss.address() as AddressInfo).port;

    const received = await new Promise<WsPkg.Data>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('message', (data) => resolve(data));
    });

    // Normalize to Buffer regardless of how ws delivers binary (Buffer, Buffer[], Uint8Array)
    const buf = Array.isArray(received)
      ? Buffer.concat(received as Buffer[])
      : Buffer.from(received as Buffer | Uint8Array);
    expect(buf).toEqual(binaryData);

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('handles malformed envelope gracefully (null header, missing data)', async () => {
    const wss = new WsPkg.Server({ port: 0 });
    const messages = [
      JSON.stringify({ header: null, data: { value: 1 } }),
      JSON.stringify({ header: {}, data: null }),
    ];
    let idx = 0;
    wss.on('connection', (ws) => {
      const send = () => {
        if (idx < messages.length) ws.send(messages[idx++]);
      };
      setTimeout(send, 20);
      setTimeout(send, 40);
    });
    const port = (wss.address() as AddressInfo).port;

    const received: unknown[] = [];
    await new Promise<void>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('message', (data) => {
        received.push(data);
        if (received.length === 2) resolve();
      });
    });

    // Both messages should be delivered without throwing
    expect(received).toHaveLength(2);
    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name === 'websocket.receive')).toHaveLength(2);

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('falls back to passthrough payload when protocol is not negotiated', async () => {
    let resolveFirst: ((msg: string) => void) | null = null;
    const firstMessage = new Promise<string>((resolve) => (resolveFirst = resolve));
    const wss = new WsPkg.Server({
      port: 0,
      handleProtocols: (protocols) => {
        const list = [...(protocols as Iterable<string>)];
        return list.includes('json') ? 'json' : false;
      },
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        if (resolveFirst) resolveFirst(data.toString());
      });
    });
    const port = (wss.address() as AddressInfo).port;

    // Native client offer without `otel-ws` — avoids envelope when a server picks a bare user subprotocol.
    const client = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WsPkg(`ws://127.0.0.1:${port}`, ['json']);
      instrumentSocket(ws as unknown as WebSocket);
      ws.once('open', () => resolve(ws as unknown as WebSocket));
      ws.once('error', reject);
    });

    client.send('{"hello":"passthrough"}');
    const wire = await firstMessage;
    expect(JSON.parse(wire)).toEqual({ hello: 'passthrough' });

    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.send')).toBeTruthy();

    client.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('OtelWebSocket.Server returns bare user subprotocol when otel-ws is first in offer', async () => {
    let userArg: Set<string> | undefined;
    const wss = new WebSocket.Server({
      port: 0,
      handleProtocols: (protocols: Set<string>) => {
        userArg = new Set(protocols);
        return protocols.has('json') ? 'json' : false;
      },
    });
    wss.on('connection', () => {});
    const port = (wss.address() as AddressInfo).port;

    const negotiated = await new Promise<string>((resolve, reject) => {
      const c = new WsPkg(`ws://127.0.0.1:${port}`, [OTEL_WS_PROTOCOL, 'json']);
      c.once('open', () => {
        resolve(c.protocol);
        c.close();
      });
      c.once('error', reject);
    });

    expect(negotiated).toBe('json');
    expect(userArg).toBeDefined();
    expect([...(userArg as Set<string>)].sort()).toEqual(['json']);
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('OtelWebSocket user-facing protocol is empty when only otel-ws is negotiated', async () => {
    const wss = new WebSocket.Server({ port: 0 });
    wss.on('connection', () => {});
    const port = (wss.address() as AddressInfo).port;

    const facade = await new Promise<string>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}`);
      c.once('open', () => {
        resolve(c.protocol);
        c.close();
      });
      c.once('error', reject);
    });

    expect(facade).toBe('');
    await new Promise<void>((r) => wss.close(() => r()));
  });

});

describe('userFacingProtocolFromWire', () => {
  it('strips otel-ws+ prefix (defensive / non-RFC wire)', () => {
    expect(userFacingProtocolFromWire(`${OTEL_WS_PROTOCOL}+json`)).toBe('json');
    expect(userFacingProtocolFromWire(`${OTEL_WS_PROTOCOL}+a+b`)).toBe('a+b');
  });

  it('maps lone otel-ws to empty string', () => {
    expect(userFacingProtocolFromWire(OTEL_WS_PROTOCOL)).toBe('');
  });

  it('passes through bare subprotocols', () => {
    expect(userFacingProtocolFromWire('json')).toBe('json');
  });
});
