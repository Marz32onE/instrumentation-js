import { describe, it, expect, afterEach } from '@jest/globals';
import { natsTracingEnabled } from '../src/env-flags.js';

const ENV_GLOBAL = 'OTEL_INSTRUMENTATION_JS_TRACING_ENABLED';
const ENV_MODULE = 'OTEL_NATS_TRACING_ENABLED';

function saveEnv(): Record<string, string | undefined> {
  return {
    [ENV_GLOBAL]: process.env[ENV_GLOBAL],
    [ENV_MODULE]: process.env[ENV_MODULE],
  };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('natsTracingEnabled', () => {
  let saved: Record<string, string | undefined>;

  afterEach(() => {
    restoreEnv(saved);
  });

  it('returns true when neither env var is set (default)', () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    delete process.env[ENV_MODULE];
    expect(natsTracingEnabled()).toBe(true);
  });

  it('returns true when module env var is empty string', () => {
    saved = saveEnv();
    delete process.env[ENV_GLOBAL];
    process.env[ENV_MODULE] = '';
    expect(natsTracingEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', 'FALSE', 'Off', '  false  '])(
    'returns false when module env var is "%s"',
    (value) => {
      saved = saveEnv();
      delete process.env[ENV_GLOBAL];
      process.env[ENV_MODULE] = value;
      expect(natsTracingEnabled()).toBe(false);
    },
  );

  it('returns false when global env var disables tracing regardless of module var', () => {
    saved = saveEnv();
    process.env[ENV_GLOBAL] = 'false';
    process.env[ENV_MODULE] = 'true';
    expect(natsTracingEnabled()).toBe(false);
  });

  it('returns false when global env var is "0"', () => {
    saved = saveEnv();
    process.env[ENV_GLOBAL] = '0';
    delete process.env[ENV_MODULE];
    expect(natsTracingEnabled()).toBe(false);
  });

  it('returns false when global is enabled but module is disabled', () => {
    saved = saveEnv();
    process.env[ENV_GLOBAL] = 'true';
    process.env[ENV_MODULE] = '0';
    expect(natsTracingEnabled()).toBe(false);
  });
});
