const ENV_GLOBAL = 'OTEL_INSTRUMENTATION_JS_TRACING_ENABLED';
const ENV_MODULE = 'OTEL_WS_TRACING_ENABLED';

function envEnabledByDefault(key: string): boolean {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    return true;
  }
  const raw = process.env[key];
  if (raw === undefined) return true;
  switch (raw.trim().toLowerCase()) {
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return true;
  }
}

/**
 * Returns `true` when WebSocket tracing is enabled (default).
 * Reads {@link ENV_GLOBAL} and {@link ENV_MODULE} at call time.
 * Disable tokens (case-insensitive, trimmed): `0`, `false`, `no`, `off`.
 * Global flag overrides the module flag when set to a disable token.
 */
export function wsTracingEnabled(): boolean {
  if (!envEnabledByDefault(ENV_GLOBAL)) return false;
  return envEnabledByDefault(ENV_MODULE);
}
