import {
  type TextMapPropagator,
  type TracerProvider,
  propagation,
  trace,
} from '@opentelemetry/api';

export interface NatsInstrumentationOptions {
  tracerProvider?: TracerProvider;
  propagators?: TextMapPropagator;
}

export function resolveTracerProvider(opts?: NatsInstrumentationOptions): TracerProvider {
  return opts?.tracerProvider ?? trace.getTracerProvider();
}

export function resolvePropagator(opts?: NatsInstrumentationOptions): TextMapPropagator {
  return opts?.propagators ?? propagation;
}
