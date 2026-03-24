import * as http from 'http';
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
  Context,
  ROOT_CONTEXT,
  context as otelContext,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';
import { WebSocketServer } from 'ws';

import {
  BinaryMessage,
  Conn,
  Options,
  TextMessage,
  dial,
  newConn,
} from '../src';

// ── OTel test helpers ────────────────────────────────────────────────────────

function setupOTel(): {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
  teardown: () => void;
} {
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
      // Reset globals to noop
      propagation.disable();
      trace.disable();
    },
  };
}

// ── WebSocket server helpers ─────────────────────────────────────────────────

/**
 * Starts a WebSocketServer that wraps each incoming connection in a Conn and
 * echoes every message back – mirrors newTestServer in the Go tests.
 */
function newTestServer(
  opts?: Options,
): { wss: WebSocketServer; port: number; close: () => Promise<void> } {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (rawWs) => {
    const conn = newConn(rawWs, opts);
    const loop = async (): Promise<void> => {
      try {
        for (;;) {
          const [ctx, msgType, data] = await conn.readMessage(ROOT_CONTEXT);
          await conn.writeMessage(ctx, msgType, data);
        }
      } catch {
        // Connection closed – expected.
      }
    };
    loop().catch(() => undefined);
  });

  server.listen(0);
  const port = (server.address() as AddressInfo).port;

  return {
    wss,
    port,
    close: () =>
      new Promise((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : server.close(() => resolve()))),
      ),
  };
}

async function dialServer(port: number, opts?: Options): Promise<Conn> {
  return dial(ROOT_CONTEXT, `ws://127.0.0.1:${port}`, undefined, opts);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('otel-websocket', () => {
  let teardown: () => void;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    const setup = setupOTel();
    teardown = setup.teardown;
    provider = setup.provider;
  });

  afterEach(async () => {
    teardown();
  });

  // ── TestTracePropagation ──────────────────────────────────────────────────

  it('propagates trace context from sender to receiver', async () => {
    const { port, close } = newTestServer();

    const tracer = provider.getTracer('test');
    const [ctx, span] = startSpan(tracer, ROOT_CONTEXT, 'client-send');

    const clientConn = await dialServer(port);

    const msg = 'hello otel';
    await clientConn.writeMessage(ctx, TextMessage, Buffer.from(msg));

    // Read echo back; the context should carry the propagated span context.
    const [recvCtx, msgType, data] = await clientConn.readMessage(ROOT_CONTEXT);

    expect(msgType).toBe(TextMessage);
    expect(data.toString()).toBe(msg);

    const remoteSpan = trace.getSpanContext(recvCtx);
    expect(remoteSpan).toBeDefined();
    expect(isSpanContextValid(remoteSpan!)).toBe(true);
    // The echo carries the same trace ID that the sender originated.
    expect(remoteSpan!.traceId).toBe(span.spanContext().traceId);

    span.end();
    clientConn.close();
    await close();
  });

  // ── TestReadMessagePlain ──────────────────────────────────────────────────

  it('returns plain messages unchanged when they are not an envelope', async () => {
    // Set up a server that sends a raw (non-envelope) message.
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (rawWs) => {
      rawWs.send('plain message');
    });
    server.listen(0);
    const port = (server.address() as AddressInfo).port;

    const clientConn = await dialServer(port);
    const [ctx, , data] = await clientConn.readMessage(ROOT_CONTEXT);

    expect(data.toString()).toBe('plain message');
    // No valid span context should be injected for a plain message.
    const sc = trace.getSpanContext(ctx);
    expect(sc === undefined || !isSpanContextValid(sc)).toBe(true);

    clientConn.close();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });

  // ── TestWriteMessageNoSpan ────────────────────────────────────────────────

  it('sends and receives a binary message when no span is active', async () => {
    const { port, close } = newTestServer();

    const clientConn = await dialServer(port);
    const msg = 'no span';
    await clientConn.writeMessage(ROOT_CONTEXT, BinaryMessage, Buffer.from(msg));

    const [, msgType, data] = await clientConn.readMessage(ROOT_CONTEXT);

    expect(msgType).toBe(BinaryMessage);
    expect(data.toString()).toBe(msg);

    clientConn.close();
    await close();
  });

  // ── TestWithPropagatorsOption ─────────────────────────────────────────────

  it('honours a custom propagator supplied via Options.propagator', async () => {
    const customPropagator = new CompositePropagator({
      propagators: [new W3CTraceContextPropagator()],
    });
    const opts: Options = { propagator: customPropagator, tracerProvider: provider };

    const { port, close } = newTestServer(opts);

    const tracer = provider.getTracer('test-custom-prop');
    const [ctx, span] = startSpan(tracer, ROOT_CONTEXT, 'custom-prop-span');

    const clientConn = await dialServer(port, opts);
    await clientConn.writeMessage(ctx, TextMessage, Buffer.from('with custom prop'));

    const [recvCtx] = await clientConn.readMessage(ROOT_CONTEXT);

    const remoteSpan = trace.getSpanContext(recvCtx);
    expect(remoteSpan).toBeDefined();
    expect(isSpanContextValid(remoteSpan!)).toBe(true);
    expect(remoteSpan!.traceId).toBe(span.spanContext().traceId);

    span.end();
    clientConn.close();
    await close();
  });

  // ── TestRoundTripMultipleMessages ─────────────────────────────────────────

  it('handles multiple sequential round-trip messages correctly', async () => {
    const { port, close } = newTestServer();
    const clientConn = await dialServer(port);
    const tracer = provider.getTracer('multi-msg');

    const messages = ['first', 'second', 'third'];
    for (const msg of messages) {
      const [ctx, span] = startSpan(tracer, ROOT_CONTEXT, `send-${msg}`);
      await clientConn.writeMessage(ctx, TextMessage, Buffer.from(msg));
      const [, , data] = await clientConn.readMessage(ROOT_CONTEXT);
      expect(data.toString()).toBe(msg);
      span.end();
    }

    clientConn.close();
    await close();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Helper that starts a span and returns both the derived context and the span,
 * avoiding the need for startActiveSpan's callback form in tests.
 */
function startSpan(
  tracer: ReturnType<NodeTracerProvider['getTracer']>,
  ctx: Context,
  name: string,
): [Context, ReturnType<typeof tracer.startSpan>] {
  const span = tracer.startSpan(name, {}, ctx);
  return [trace.setSpan(ctx, span), span];
}
