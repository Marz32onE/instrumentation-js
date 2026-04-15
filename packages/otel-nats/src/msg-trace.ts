import type { Context } from '@opentelemetry/api';
import type { Msg } from '@nats-io/transport-node';
import type { JsMsg } from '@nats-io/jetstream';

const coreMsgCtx = new WeakMap<Msg, Context>();
const jsMsgCtx = new WeakMap<JsMsg, Context>();

/** @internal */
export function setCoreMessageTraceContext(msg: Msg, ctx: Context): void {
  coreMsgCtx.set(msg, ctx);
}

/**
 * Returns the OpenTelemetry context associated with a core NATS `Msg` delivered
 * through {@link OtelNatsConn.subscribe} (async iterator or callback path).
 */
export function getMessageTraceContext(msg: Msg): Context | undefined {
  return coreMsgCtx.get(msg);
}

/** @internal */
export function setJetStreamMessageTraceContext(msg: JsMsg, ctx: Context): void {
  jsMsgCtx.set(msg, ctx);
}

/**
 * Returns the OpenTelemetry context for a JetStream `JsMsg` from an instrumented
 * {@link OtelConsumer} / {@link OtelPushConsumer}.
 */
export function getJetStreamMessageTraceContext(msg: JsMsg): Context | undefined {
  return jsMsgCtx.get(msg);
}
