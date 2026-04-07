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

/** ws@5 passes `string[]` to `handleProtocols`; this package's wrapper may pass a `Set` for the user callback. */
function offeredHasJson(protocols: Iterable<string>): boolean {
  return [...protocols].includes('json');
}

function createNegotiatingServer(): WsPkg.Server {
  return new WsPkg.Server({
    port: 0,
    handleProtocols: (protocols) => {
      const list = [...(protocols as Iterable<string>)];
      const prefixed = list.find((p) => p.startsWith(`${OTEL_WS_PROTOCOL}+`));
      if (prefixed) return prefixed;
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
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
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
      const client = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
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
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
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
    const raw = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
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

  it('WebSocket.Server auto-instruments server sockets on connection', async () => {
    // OtelWebSocket client offers ["otel-ws+json", "otel-ws", "json"]; server returns "otel-ws+json".
    // Server auto-instruments with envelope: true → extracts trace context from incoming envelope.
    const wss = new WebSocket.Server({
      port: 0,
      handleProtocols: (protocols: Iterable<string>) =>
        [...protocols].includes('json') ? 'json' : false,
    });
    const receiveTraceId = await new Promise<string | undefined>((resolve, reject) => {
      wss.on('connection', (ws) => {
        // No instrumentSocket call — auto-instrumented by WebSocket.Server
        ws.on('message', () => {
          resolve(trace.getSpanContext(context.active())?.traceId);
        });
      });
      const port = (wss.address() as AddressInfo).port;
      const client = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
      client.once('open', () => {
        client.send(
          { text: 'auto-instrumented' },
          (err) => { if (err) reject(err); },
        );
      });
      client.once('error', reject);
    });

    expect(receiveTraceId).toBeDefined();
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('WebSocket.Server sends with trace context injected', async () => {
    const wss = new WebSocket.Server({
      port: 0,
      handleProtocols: (protocols: Iterable<string>) =>
        [...protocols].includes('json') ? 'json' : false,
    });
    wss.on('connection', (ws) => {
      // No instrumentSocket call — send is auto-patched by WebSocket.Server
      ws.send({ reply: true });
    });
    const port = (wss.address() as AddressInfo).port;

    // Use a native WsPkg client offering the full protocol list so it can receive the raw
    // wire envelope without OtelWebSocket unwrapping it.
    const wire = await new Promise<string>((resolve, reject) => {
      const client = new WsPkg(`ws://127.0.0.1:${port}`, ['otel-ws+json', OTEL_WS_PROTOCOL, 'json']);
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
    const wss = createNegotiatingServer();
    wss.on('connection', (ws) => {
      setTimeout(() => {
        // Legacy flat format — not an envelope
        ws.send(JSON.stringify({ body: 'legacy', traceparent: '00-12345678901234567890123456789012-0123456789012345-01' }));
      }, 20);
    });
    const port = (wss.address() as AddressInfo).port;

    const received = await new Promise<{ data: unknown; traceId: string | undefined }>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
      client.on('message', (data) => {
        resolve({
          data,
          traceId: trace.getSpanContext(context.active())?.traceId,
        });
      });
    });

    // Data delivered as-is (legacy payload parsed into object)
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

  describe('WebSocket.Server handleProtocols', () => {
    it('case 1: without user handleProtocols and client offers json — handshake fails', async () => {
      const wss = new WebSocket.Server({ port: 0 });
      wss.on('connection', () => {});
      const port = (wss.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`, ['json']);
        c.once('open', () => {
          reject(new Error('expected handshake failure'));
        });
        c.once('error', (err: Error) => {
          expect(err.message).toContain('Server sent no subprotocol');
          resolve();
        });
      });
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('case 2: client offers no subprotocols — negotiated protocol empty', async () => {
      const wss = new WebSocket.Server({ port: 0 });
      wss.on('connection', () => {});
      const port = (wss.address() as AddressInfo).port;
      const protocol = await new Promise<string>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`);
        c.once('open', () => {
          resolve(c.protocol);
          c.close();
        });
        c.once('error', reject);
      });
      expect(protocol).toBe('');
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('case 3: client json only — bare json on wire', async () => {
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          offeredHasJson(protocols) ? 'json' : false,
      });
      wss.on('connection', () => {});
      const port = (wss.address() as AddressInfo).port;
      const protocol = await new Promise<string>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`, ['json']);
        c.once('open', () => {
          resolve(c.protocol);
          c.close();
        });
        c.once('error', reject);
      });
      expect(protocol).toBe('json');
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('case 4: WebSocket.Server returns "otel-ws+json"; native client sees prefixed protocol, OtelWebSocket facade strips prefix', async () => {
      // After fix: server returns "otel-ws+<selected>" (not bare "json") so the client can detect otel-ws awareness.
      // User handler receives only the stripped rest-list (no otel-ws token).
      let userArg: Set<string> | undefined;
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) => {
          userArg = new Set(protocols);
          return offeredHasJson(protocols) ? 'json' : false;
        },
      });
      wss.on('connection', () => {});
      const port = (wss.address() as AddressInfo).port;
      const url = `ws://127.0.0.1:${port}`;

      // Native WsPkg client offers compound + bare user tokens (no bare otel-ws sentinel needed).
      const nativeProtocol = await new Promise<string>((resolve, reject) => {
        const c = new WsPkg(url, ['otel-ws+json', 'json']);
        c.once('open', () => {
          resolve(c.protocol);
          c.close();
        });
        c.once('error', reject);
      });
      expect(nativeProtocol).toBe('otel-ws+json');
      expect(userArg).toBeDefined();
      // User handler only received the non-otel-ws protocols
      expect([...(userArg as Set<string>)].sort()).toEqual(['json']);

      // OtelWebSocket facade strips "otel-ws+" → returns "json"
      const otelFacadeProtocol = await new Promise<string>((resolve, reject) => {
        const c = new WebSocket(url, 'json');
        c.once('open', () => {
          resolve(c.protocol);
          c.close();
        });
        c.once('error', reject);
      });
      expect(otelFacadeProtocol).toBe('json');

      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('case 5: client offers only otel-ws (no user subprotocol) — server rejects', async () => {
      // After fix: rest.length === 0 → server returns false → handshake rejected.
      // Rationale: otel-ws alone carries no application payload type; a user subprotocol is required.
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: () => 'json',
      });
      wss.on('connection', () => {});
      const port = (wss.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`, [OTEL_WS_PROTOCOL]);
        c.once('open', () => reject(new Error('expected handshake failure')));
        c.once('error', () => resolve());
      });
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });

  it('OtelWebSocket user-facing protocol is empty when plain server returns bare "otel-ws"', async () => {
    // A plain ws.Server that happens to return bare "otel-ws" (non-WebSocket.Server).
    // WebSocket.Server no longer returns bare "otel-ws" (it returns "otel-ws+<user>" or false),
    // so this tests a legacy / non-standard server returning "otel-ws" alone.
    // Client: wire = "otel-ws" → setOtelActive (recognized prefix) → facade returns "".
    const wss = new WsPkg.Server({
      port: 0,
      handleProtocols: (protocols: Iterable<string>) =>
        [...protocols].includes(OTEL_WS_PROTOCOL) ? OTEL_WS_PROTOCOL : false,
    });
    wss.on('connection', () => {});
    const port = (wss.address() as AddressInfo).port;

    // new WebSocket(url) — no explicit protocols → user=[], protocolsProvided=false → no throw
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

  // ────────────────────────────────────────────────────────────────────────────
  // otel-ws.md spec scenarios (A – H)
  // ────────────────────────────────────────────────────────────────────────────
  describe('otel-ws.md spec scenarios', () => {
    // ── Section 1: Standard WebSocket subprotocol behaviour (no otel-ws) ───────

    // Case A omitted (user instruction: ignore Case A).

    it('Case B: ws client "json" → ws server (json) → connection success, protocol "json"', async () => {
      // Baseline RFC 6455 behaviour — client offers "json", server returns "json".
      // ws@5 passes the offered protocols as a string[] (not Set) to handleProtocols.
      const wss = new WsPkg.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          [...protocols].includes('json') ? 'json' : false,
      });
      const port = (wss.address() as AddressInfo).port;

      const protocol = await new Promise<string>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`, ['json']);
        c.once('open', () => { resolve(c.protocol); c.close(); });
        c.once('error', reject);
      });

      expect(protocol).toBe('json');
      await new Promise<void>((r) => wss.close(() => r()));
    });

    // ── Section 2: OtelWebSocket client behaviour ─────────────────────────────

    it('Case C: OtelWebSocket → plain ws server returns "json" → trace DISABLED, raw payload sent', async () => {
      // After fix: client enables envelope ONLY when server returns "otel-ws+" prefix or bare "otel-ws".
      // Plain ws server returns bare "json" → no prefix → envelope DISABLED → raw payload sent.
      let serverReceived: string | undefined;
      const wss = new WsPkg.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          [...protocols].includes('json') ? 'json' : false,
      });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => { serverReceived = data.toString(); });
      });
      const port = (wss.address() as AddressInfo).port;

      const client = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });
      // Server returned bare "json" → userFacingProtocolFromWire("json") = "json"
      expect(client.protocol).toBe('json');

      client.send('hello');
      await new Promise<void>((r) => setTimeout(r, 30));
      client.close();

      // Server receives raw payload — NOT wrapped in envelope (trace disabled)
      expect(serverReceived).toBe('hello');

      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('Case D: OtelWebSocket → server supports binary only, no match → connection rejected', async () => {
      // Spec (otel-ws.md): client offers "otel-ws,json" → server (binary only) returns no matching protocol
      // → OTEL-WS Client "detects empty" → closes/errors.
      // In practice with ws@5: handleProtocols returning false sends HTTP 400; ws client gets an error event.
      // Current behaviour: connection is rejected (ws library rejects before client can proactively close).
      // Spec note: "主動關閉" (actively close) describes client-initiated close; ws does this via error path.
      const wss = new WsPkg.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) => {
          // Server only understands "binary"; rejects otel-ws/json offers
          return [...protocols].includes('binary') ? 'binary' : false;
        },
      });
      const port = (wss.address() as AddressInfo).port;

      const rejected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
        ws.once('open', () => resolve(false)); // should not open
        ws.once('error', () => resolve(true)); // error = server rejected
      });

      expect(rejected).toBe(true);
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('Case E: OtelWebSocket without user sub-protocol connects successfully and stays passthrough', async () => {
      // New spec: no user sub-protocol on client side should not reject connection.
      // It should run in passthrough mode (no envelope), while still emitting send/receive spans.
      const wss = new WsPkg.Server({ port: 0 });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => ws.send(data.toString()));
      });
      const port = (wss.address() as AddressInfo).port;

      const received = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, '');
        ws.once('open', () => {
          expect(ws.protocol).toBe('');
          ws.send('raw-no-protocol');
        });
        ws.once('message', (data) => {
          resolve(data as string);
          ws.close();
        });
        ws.once('error', reject);
      });
      expect(received).toBe('raw-no-protocol');

      const spans = exporter.getFinishedSpans();
      const sendSpans = spans.filter((s) => s.name === 'websocket.send');
      const receiveSpans = spans.filter((s) => s.name === 'websocket.receive');
      expect(sendSpans).toHaveLength(1);
      expect(receiveSpans).toHaveLength(1);

      await new Promise<void>((r) => wss.close(() => r()));
    });

    // ── Section 3: WebSocket.Server behaviour ─────────────────────────────

    it('Case F: plain ws client without sub-protocol → OtelWebSocket.Server connects with passthrough', async () => {
      // New spec: when client sends no sub-protocol, otel server must not reject.
      // Connection should stay passthrough (raw payload), while server still emits send/receive spans.
      let serverReceived: string | undefined;
      const wss = new WebSocket.Server({ port: 0 });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          serverReceived = data.toString();
          ws.send('server-raw-ack');
        });
      });
      const port = (wss.address() as AddressInfo).port;

      const clientReceived = await new Promise<string>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`);
        c.once('open', () => c.send('client-raw-msg'));
        c.once('message', (data: WsPkg.Data) => {
          resolve(Buffer.isBuffer(data) ? data.toString() : String(data));
          c.close();
        });
        c.once('error', reject);
      });

      expect(serverReceived).toBe('client-raw-msg');
      expect(clientReceived).toBe('server-raw-ack');
      const spans = exporter.getFinishedSpans();
      const sendSpans = spans.filter((s) => s.name === 'websocket.send');
      const receiveSpans = spans.filter((s) => s.name === 'websocket.receive');
      expect(sendSpans).toHaveLength(1);
      expect(receiveSpans).toHaveLength(1);

      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('Case G: OtelWebSocket client → WebSocket.Server → trace enabled, server receives envelope', async () => {
      // otel-ws client offers ["otel-ws","json"] → WebSocket.Server strips "otel-ws",
      // calls user handler with ["json"] → returns "json" (bare) → negotiated protocol "json".
      // Server: first offered was "otel-ws" → envelope: true → otel active.
      // Client: OtelWebSocket always sets active on open → sends envelopes.
      let serverReceivedTraceId: string | undefined;
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          [...protocols].includes('json') ? 'json' : false,
      });
      wss.on('connection', (ws) => {
        ws.on('message', () => {
          serverReceivedTraceId = trace.getSpanContext(context.active())?.traceId;
        });
      });
      const port = (wss.address() as AddressInfo).port;
      const tracer = provider.getTracer('case-g');
      const parent = tracer.startSpan('parent', {}, ROOT_CONTEXT);

      const client = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'json');
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });

      await new Promise<void>((resolve) => {
        // Server must be ready to receive; wait for connection + send in span context
        context.with(trace.setSpan(ROOT_CONTEXT, parent), () => {
          client.send('hello');
        });
        setTimeout(resolve, 50);
      });
      parent.end();

      // Server extracted the parent's trace ID from the envelope
      expect(serverReceivedTraceId).toBe(parent.spanContext().traceId);

      // Client user-facing protocol: server returned "otel-ws+json" → facade strips prefix → "json"
      expect(client.protocol).toBe('json');

      // Verify spans were created
      const spans = exporter.getFinishedSpans();
      expect(spans.some((s) => s.name === 'websocket.send')).toBeTruthy();
      expect(spans.some((s) => s.name === 'websocket.receive')).toBeTruthy();

      client.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('Case H: ws client "json" → WebSocket.Server → trace disabled, server receives raw payload', async () => {
      // Plain ws client offers ["json"] (no otel-ws prefix).
      // WebSocket.Server: list[0] = "json" ≠ "otel-ws" → envelope: false → passthrough.
      // Server receives raw payload, no span context extraction.
      let serverReceived: string | undefined;
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          [...protocols].includes('json') ? 'json' : false,
      });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => { serverReceived = data.toString(); });
      });
      const port = (wss.address() as AddressInfo).port;

      const client = await new Promise<WsPkg>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`, ['json']);
        c.once('open', () => resolve(c));
        c.once('error', reject);
      });

      client.send('raw-hello');
      await new Promise<void>((r) => setTimeout(r, 30));
      client.close();

      // Server receives raw payload — NOT wrapped in envelope
      expect(serverReceived).toBe('raw-hello');

      // A websocket.receive span IS created (passthrough mode — withPassthroughReceiveContext still
      // creates a root span), but no remote trace context is extracted from an otel-ws envelope.
      const spans = exporter.getFinishedSpans();
      const recvSpan = spans.find((s) => s.name === 'websocket.receive');
      expect(recvSpan).toBeDefined();
      expect(recvSpan!.parentSpanId).toBeUndefined(); // root span — no extracted remote context

      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('Case I: server-side ws.protocol strips otel-ws+ prefix for OtelWebSocket client connections', async () => {
      // OtelWebSocket client offers ["otel-ws+json","json"] → WebSocket.Server selects "otel-ws+json".
      // Server connection handler should expose ws.protocol === "json" (not "otel-ws+json").
      let serverProtocol: string | undefined;
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          [...protocols].includes('json') ? 'json' : false,
      });
      wss.on('connection', (ws) => {
        serverProtocol = ws.protocol;
      });
      const port = (wss.address() as AddressInfo).port;

      await new Promise<void>((resolve, reject) => {
        const c = new WebSocket(`ws://127.0.0.1:${port}`, ['json']);
        c.once('open', () => { c.close(); resolve(); });
        c.once('error', reject);
      });

      await new Promise<void>((r) => setTimeout(r, 20));
      expect(serverProtocol).toBe('json');

      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('Case J: server-side ws.protocol unchanged for plain (non-otel-ws) client connections', async () => {
      // Plain ws client offers ["json"] (no otel-ws).
      // WebSocket.Server should NOT alter ws.protocol — user sees the raw selected protocol.
      let serverProtocol: string | undefined;
      const wss = new WebSocket.Server({
        port: 0,
        handleProtocols: (protocols: Iterable<string>) =>
          [...protocols].includes('json') ? 'json' : false,
      });
      wss.on('connection', (ws) => {
        serverProtocol = ws.protocol;
      });
      const port = (wss.address() as AddressInfo).port;

      await new Promise<void>((resolve, reject) => {
        const c = new WsPkg(`ws://127.0.0.1:${port}`, ['json']);
        c.once('open', () => { c.close(); resolve(); });
        c.once('error', reject);
      });

      await new Promise<void>((r) => setTimeout(r, 20));
      expect(serverProtocol).toBe('json');

      await new Promise<void>((r) => wss.close(() => r()));
    });
  });
  // ── end otel-ws.md spec scenarios ─────────────────────────────────────────

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
