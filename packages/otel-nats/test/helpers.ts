import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
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

/**
 * Sets up an in-memory OTel provider with W3C propagator.
 * Call teardown() in afterEach to reset globals between tests.
 */
export function setupOTel(): {
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
    teardown(): void {
      exporter.reset();
      void provider.shutdown();
      // Reset globals so the next test can register a fresh provider
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

/** Find a free TCP port by briefly binding to port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.once('error', reject);
  });
}

/**
 * Starts a nats-server process on a random free port.
 * Resolves with the server URL once it is ready to accept connections.
 *
 * Requires `nats-server` in PATH. Install: brew install nats-server
 *
 * Set NATS_URL env var to skip spawning and use an external server instead.
 */
export async function startNatsServer(
  opts: { jetstream?: boolean } = {},
): Promise<{ url: string; stop: () => Promise<void> }> {
  const externalUrl = process.env['NATS_URL'];
  if (externalUrl) {
    return { url: externalUrl, stop: async () => {} };
  }

  const port = await getFreePort();

  return new Promise((resolve, reject) => {
    const args = ['--port', String(port)];
    if (opts.jetstream) {
      args.push('--jetstream', '--store_dir', os.tmpdir());
    }

    const proc = spawn('nats-server', args, { stdio: 'pipe' });
    let resolved = false;

    const onData = (data: Buffer) => {
      const line = data.toString();
      if (line.includes('Server is ready') && !resolved) {
        resolved = true;
        resolve({
          url: `nats://127.0.0.1:${port}`,
          stop: () =>
            new Promise<void>((res) => {
              proc.stdout?.destroy();
              proc.stderr?.destroy();
              proc.kill('SIGTERM');
              proc.once('exit', () => res());
            }),
        });
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'nats-server not found in PATH. Install with: brew install nats-server' +
              '\nOr set NATS_URL env var to point to a running server.',
          ),
        );
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      if (!resolved) reject(new Error('nats-server startup timeout (10s)'));
    }, 10_000);
  });
}

/** Sleep helper for async tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
