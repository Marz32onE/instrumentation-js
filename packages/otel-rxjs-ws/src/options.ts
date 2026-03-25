import { trace, TracerProvider } from '@opentelemetry/api';

/** @internal */
export function getTracerProvider(): TracerProvider {
  return trace.getTracerProvider();
}
