import type { TextMapGetter, TextMapSetter } from '@opentelemetry/api';

/**
 * Minimal structural interface for nats.MsgHdrs.
 * Using structural typing avoids a direct nats version dependency in the carrier.
 */
export interface NatsHdrs {
  get(key: string): string;
  set(key: string, value: string): void;
  keys(): string[];
}

/**
 * OTel TextMapGetter for nats.MsgHdrs.
 * Usage: propagation.extract(ctx, msg.headers, natsHeaderGetter)
 */
export const natsHeaderGetter: TextMapGetter<NatsHdrs> = {
  get(carrier: NatsHdrs, key: string): string | undefined {
    const v = carrier.get(key);
    return v !== '' ? v : undefined;
  },
  keys(carrier: NatsHdrs): string[] {
    return carrier.keys();
  },
};

/**
 * OTel TextMapSetter for nats.MsgHdrs.
 * Usage: propagation.inject(ctx, hdrs, natsHeaderSetter)
 */
export const natsHeaderSetter: TextMapSetter<NatsHdrs> = {
  set(carrier: NatsHdrs, key: string, value: string): void {
    carrier.set(key, value);
  },
};
