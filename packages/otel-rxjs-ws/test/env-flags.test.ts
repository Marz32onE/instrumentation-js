import { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { context, propagation, trace } from '@opentelemetry/api';
import WS, { WebSocketServer } from 'ws';

import { wsTracingEnabled } from '../src/env-flags.js';
import { webSocket } from '../src/index.js';

const WS_CTOR = WS as unknown as typeof WebSocket;

const ENV_GLOBAL = 'OTEL_INSTRUMENTATION_JS_TRACING_ENABLED';
const ENV_MODULE = 'OTEL_WS_TRACING_ENABLED';

function saveEnv(): Record<string, string | undefined> {
  return {
    [ENV_GLOBAL]: process.env[ENV_GLOBAL],
    [ENV_MODULE]: process.env[ENV_MODULE],
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
    teardown: () => {
      void provider.shutdown();
      propagation.disable();
      trace.disable();
      context.disable();
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

function startRawCaptureServer() {
  const messages: string[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => messages.push(data.toString()));
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    messages,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// env-flags unit tests
// ---------------------------------------------------------------------------

describe('wsTracingEnabled (otel-rxjs-ws)', () => {
  let saved: Record<string, string | undefined>;

  afterEach(() => {
    restoreEnv(saved);
  });

  it('returns true when neither env var is set (default)', () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    delete process.env[ENV_MODULE];
    expect(wsTracingEnabled()).toBe(true);
  });

  it('returns true when module env var is empty string', () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    process.env[ENV_MODULE] = '';
    expect(wsTracingEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', 'FALSE', 'Off', '  false  '])(
    'returns false when module env var is "%s"',
    (value) => {
      saved = saveEnv();
      delete process.env[ENV_GLOBAL];
      process.env[ENV_MODULE] = value;
      expect(wsTracingEnabled()).toBe(false);
    },
  );

  it('returns false when global env var disables tracing regardless of module var', () => {
    saved = saveEnv();
    process.env[ENV_GLOBAL] = 'false';
    process.env[ENV_MODULE] = 'true';
    expect(wsTracingEnabled()).toBe(false);
  });

  it('returns false when global is enabled but module is disabled', () => {
    saved = saveEnv();
    process.env[ENV_GLOBAL] = 'true';
    process.env[ENV_MODULE] = '0';
    expect(wsTracingEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests: tracingEnabled via config option
// ---------------------------------------------------------------------------

describe('webSocket() tracingEnabled config option', () => {
  let otel: ReturnType<typeof setupOTel>;

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(() => otel.teardown());

  it('does not create spans when tracingEnabled is false', async () => {
    const server = startEchoServer();
    const received: unknown[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        const subject = webSocket<unknown>({
          url: `ws://127.0.0.1:${server.port}`,
          WebSocketCtor: WS_CTOR,
          tracingEnabled: false,
        });

        const sub = subject.subscribe({
          next: (v) => {
            received.push(v);
            sub.unsubscribe();
            resolve();
          },
          error: reject,
        });

        subject.next({ hello: 'world' });
      });
    } finally {
      await server.close();
    }

    expect(received).toHaveLength(1);
    expect(otel.exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('does not wrap outgoing payload in envelope when tracingEnabled is false', async () => {
    const server = startRawCaptureServer();

    try {
      await new Promise<void>((resolve, reject) => {
        const subject = webSocket<unknown>({
          url: `ws://127.0.0.1:${server.port}`,
          WebSocketCtor: WS_CTOR,
          tracingEnabled: false,
        });

        const sub = subject.subscribe({ error: reject });
        subject.next({ payload: 'test' });

        setTimeout(() => {
          sub.unsubscribe();
          resolve();
        }, 100);
      });
    } finally {
      await server.close();
    }

    expect(server.messages).toHaveLength(1);
    const parsed = JSON.parse(server.messages[0]) as Record<string, unknown>;
    expect(parsed['header']).toBeUndefined();
    expect(parsed['payload']).toBe('test');
  });

  it('creates spans when tracingEnabled is true (default)', async () => {
    const server = startEchoServer();

    try {
      await new Promise<void>((resolve, reject) => {
        const subject = webSocket<unknown>({
          url: `ws://127.0.0.1:${server.port}`,
          WebSocketCtor: WS_CTOR,
          tracingEnabled: true,
        });

        const sub = subject.subscribe({
          next: () => {
            sub.unsubscribe();
            resolve();
          },
          error: reject,
        });

        subject.next({ hello: 'world' });
      });
    } finally {
      await server.close();
    }

    expect(otel.exporter.getFinishedSpans().length).toBeGreaterThan(0);
  });
});
