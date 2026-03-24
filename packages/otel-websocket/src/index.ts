/**
 * @marz32one/otel-websocket
 *
 * TypeScript port of github.com/Marz32onE/instrumentation-go/otel-websocket.
 * Provides WebSocket connections with built-in OpenTelemetry trace-context
 * propagation compatible with the Go version's wire format.
 */
export {
  BinaryMessage,
  Conn,
  SCOPE_NAME,
  TextMessage,
  WebSocketLike,
  dial,
  newConn,
  otelContext,
} from './conn';
export type { Options } from './options';
export { marshalEnvelope, unmarshalEnvelope } from './message';
export type { Envelope } from './message';
export { semVersion, version } from './version';
