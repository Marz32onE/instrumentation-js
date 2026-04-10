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

/** Sleep helper for async tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
