import { AddressInfo } from 'net';

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
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
import { context, propagation, trace } from '@opentelemetry/api';
import WsPkg from 'ws';

import { wsTracingEnabled } from '../src/env-flags.js';
import WebSocket, { instrumentSocket } from '../src/index.js';

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

// ---------------------------------------------------------------------------
// env-flags unit tests
// ---------------------------------------------------------------------------

describe('wsTracingEnabled (otel-ws)', () => {
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

  it('returns false when global env var is "0"', () => {
    saved = saveEnv();
    process.env[ENV_GLOBAL] = '0';
    delete process.env[ENV_MODULE];
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
// Behavioral tests: no spans when tracing is disabled via env var
// ---------------------------------------------------------------------------

describe('OtelWebSocket behavioral: tracing disabled via env var', () => {
  let saved: Record<string, string | undefined>;
  let otel: ReturnType<typeof setupOTel>;

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(() => {
    otel.teardown();
    restoreEnv(saved);
  });

  it('does not create spans when OTEL_WS_TRACING_ENABLED=false', async () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    process.env[ENV_MODULE] = 'false';

    const messages: string[] = [];
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => messages.push(data.toString()));
    });
    const port = (wss.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(JSON.stringify({ hello: 'world' }));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 100);
        });
      });
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }

    expect(messages).toHaveLength(1);
    expect(otel.exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('does not wrap payload in envelope when OTEL_WS_TRACING_ENABLED=false', async () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    process.env[ENV_MODULE] = 'false';

    const messages: string[] = [];
    const wss = new WsPkg.Server({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => messages.push(data.toString()));
    });
    const port = (wss.address() as AddressInfo).port;

    const payload = JSON.stringify({ payload: 'test' });
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(payload);
          setTimeout(() => {
            ws.close();
            resolve();
          }, 100);
        });
      });
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(payload);
  });

  it('instrumentSocket() returns socket unchanged when OTEL_WS_TRACING_ENABLED=false', async () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    process.env[ENV_MODULE] = 'false';

    const wss = new WsPkg.Server({ port: 0 });
    const port = (wss.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const raw = new WsPkg(`ws://127.0.0.1:${port}`);
        raw.on('error', reject);
        raw.on('open', () => {
          const result = instrumentSocket(raw);
          expect(result).toBe(raw);
          raw.close();
          resolve();
        });
      });
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
