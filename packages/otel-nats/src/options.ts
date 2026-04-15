import {
  type TextMapPropagator,
  type TracerProvider,
  propagation,
  trace,
} from '@opentelemetry/api';

export interface NatsInstrumentationOptions {
  tracerProvider?: TracerProvider;
  propagators?: TextMapPropagator;
  /**
   * Default `traceDestination` for publishes when not set per-call (NATS server 2.11+ message tracing).
   * Merged into {@link PublishOptions.traceDestination} for core and JetStream publishes.
   */
  traceDestination?: string;
}

export function resolveTracerProvider(opts?: NatsInstrumentationOptions): TracerProvider {
  return opts?.tracerProvider ?? trace.getTracerProvider();
}

export function resolvePropagator(opts?: NatsInstrumentationOptions): TextMapPropagator {
  return opts?.propagators ?? propagation;
}
