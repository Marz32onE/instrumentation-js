import { GenericContainer, type StartedTestContainer } from 'testcontainers';
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

const NATS_IMAGE = 'nats:2.10-alpine';

export interface NatsContainer {
  url: string;
  container: StartedTestContainer;
  stop: () => Promise<void>;
}

export interface NatsWsContainer extends NatsContainer {
  wsUrl: string;
}

/** Start a NATS container (TCP only, optional JetStream). */
export async function startNatsContainer(opts: { jetstream?: boolean } = {}): Promise<NatsContainer> {
  const cmd = opts.jetstream ? ['-js'] : [];
  const container = await new GenericContainer(NATS_IMAGE)
    .withCommand(cmd)
    .withExposedPorts(4222)
    .start();
  const url = `nats://127.0.0.1:${container.getMappedPort(4222)}`;
  return { url, container, stop: () => container.stop() };
}

/** Start a NATS container with WebSocket listener on port 9222 (no TLS). */
export async function startNatsContainerWithWebSocket(): Promise<NatsWsContainer> {
  const wsConfig = `
websocket {
  port: 9222
  no_tls: true
}
`;
  const container = await new GenericContainer(NATS_IMAGE)
    .withCopyContentToContainer([{ content: wsConfig, target: '/etc/nats.conf' }])
    .withCommand(['-c', '/etc/nats.conf'])
    .withExposedPorts(4222, 9222)
    .start();

  const url = `nats://127.0.0.1:${container.getMappedPort(4222)}`;
  const wsUrl = `ws://127.0.0.1:${container.getMappedPort(9222)}`;
  return { url, wsUrl, container, stop: () => container.stop() };
}

/** Sets up an in-memory OTel provider with W3C propagator. */
export function setupOTel(): {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
  teardown: () => Promise<void>;
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
    async teardown(): Promise<void> {
      exporter.reset();
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
