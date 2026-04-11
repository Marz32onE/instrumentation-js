import type { SpanAttributes } from '@opentelemetry/api';

export const MESSAGING_SYSTEM = 'nats';
export const SCOPE_NAME = '@marz32one/otel-nats';

/**
 * Attributes for a PRODUCER span (publish / request send side).
 * Follows OTel messaging semconv v1.27.0.
 */
export function publishAttrs(
  subject: string,
  bodySize: number,
  serverAddress: string,
): SpanAttributes {
  const attrs: SpanAttributes = {
    'messaging.system': MESSAGING_SYSTEM,
    'messaging.destination.name': subject,
    'messaging.operation.type': 'send',
    'messaging.operation.name': 'publish',
  };
  if (bodySize > 0) {
    attrs['messaging.message.body.size'] = bodySize;
  }
  if (serverAddress) {
    attrs['server.address'] = serverAddress;
  }
  return attrs;
}

/**
 * Attributes for a CONSUMER span (subscribe receive side).
 * operationType: 'process' for push/callback, 'receive' for pull/fetch.
 */
export function receiveAttrs(
  subject: string,
  operationType: 'process' | 'receive',
  bodySize: number,
  serverAddress: string,
  consumerGroup?: string,
): SpanAttributes {
  const attrs: SpanAttributes = {
    'messaging.system': MESSAGING_SYSTEM,
    'messaging.destination.name': subject,
    'messaging.operation.type': operationType,
    'messaging.operation.name': operationType,
  };
  if (bodySize > 0) {
    attrs['messaging.message.body.size'] = bodySize;
  }
  if (consumerGroup) {
    attrs['messaging.consumer.group.name'] = consumerGroup;
  }
  if (serverAddress) {
    attrs['server.address'] = serverAddress;
  }
  return attrs;
}
