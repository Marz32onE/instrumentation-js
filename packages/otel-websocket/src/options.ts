import { TextMapPropagator, TracerProvider, trace } from '@opentelemetry/api';

/** Options for configuring a Conn. */
export interface Options {
  /**
   * Custom TextMapPropagator.  When provided it is used directly; otherwise
   * the globally registered propagator (via `propagation.setGlobalPropagator`)
   * is used.
   */
  propagator?: TextMapPropagator;
  /**
   * Custom TracerProvider.  When provided it is used directly; otherwise
   * `trace.getTracerProvider()` is used.
   */
  tracerProvider?: TracerProvider;
}

/** Resolves the TracerProvider from options or falls back to the OTel global. */
export function resolveTracerProvider(opts?: Options): TracerProvider {
  return opts?.tracerProvider ?? trace.getTracerProvider();
}
