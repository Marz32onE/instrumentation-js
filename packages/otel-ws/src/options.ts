import { trace, TracerProvider } from '@opentelemetry/api';

export function getTracerProvider(): TracerProvider {
  return trace.getTracerProvider();
}
