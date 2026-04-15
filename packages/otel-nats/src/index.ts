import { connect as natsConnect, type NodeConnectionOptions } from '@nats-io/transport-node';
import type { NatsInstrumentationOptions } from './options.js';
import { OtelNatsConn } from './core.js';

export * from './core.js';
export type { NodeConnectionOptions };

/**
 * Connect to NATS with OTel trace propagation.
 * Uses {@link https://github.com/nats-io/nats.js | @nats-io/transport-node} (nats.js v3) TCP transport.
 */
export async function connect(
  opts?: NodeConnectionOptions,
  traceOpts?: NatsInstrumentationOptions,
): Promise<OtelNatsConn> {
  const nc = await natsConnect(opts);
  return new OtelNatsConn(nc, traceOpts);
}
