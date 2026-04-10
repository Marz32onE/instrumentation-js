import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import Ws from 'ws';
import { wsconnect } from '../../src/index.js';
import { startNatsContainerWithWebSocket, setupOTel } from './helpers.js';

const enc = new TextEncoder();

describe('[integration] WebSocket (wsconnect)', () => {
  let wsUrl: string;
  let stopContainer: () => Promise<void>;
  let otel: ReturnType<typeof setupOTel>;

  beforeAll(async () => {
    const c = await startNatsContainerWithWebSocket();
    wsUrl = c.wsUrl;
    stopContainer = c.stop;
  });

  afterAll(async () => {
    await stopContainer();
  });

  beforeEach(() => {
    otel = setupOTel();
  });

  afterEach(async () => {
    await otel.teardown();
  });

  it('publish injects traceparent into NATS message headers over WebSocket', async () => {
    const conn = await wsconnect({
      servers: wsUrl,
      wsFactory: (u) => ({
        socket: new Ws(u) as unknown as globalThis.WebSocket,
        encrypted: u.startsWith('wss:'),
      }),
    });

    const subj = 'integration.ws.traceheaders';
    const readFirst = (async () => {
      const gen = conn.subscribe(subj);
      for await (const { msg } of gen) {
        return msg;
      }
      return undefined;
    })();

    conn.publish(ROOT_CONTEXT, subj, enc.encode('payload'));

    const msg = await readFirst;
    await conn.drain();

    expect(msg).toBeDefined();
    const tp = msg?.headers?.get('traceparent');
    expect(tp).toBeTruthy();
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  }, 30_000);
});
