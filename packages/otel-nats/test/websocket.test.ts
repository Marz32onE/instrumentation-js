import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import Ws from 'ws';

import { wsconnect } from '../src/index.js';
import { setupOTel, startNatsServerWithWebSocket } from './helpers.js';

const enc = new TextEncoder();

const wsDescribe =
  process.env['SKIP_WS_TEST'] === '1' ? describe.skip : describe;

wsDescribe('WebSocket (wsconnect)', () => {
  let wsUrl: string;
  let stopServer: () => Promise<void>;
  let serverOk = false;

  beforeAll(async () => {
    try {
      const s = await startNatsServerWithWebSocket();
      wsUrl = s.wsUrl;
      stopServer = s.stop;
      serverOk = true;
    } catch {
      serverOk = false;
    }
  }, 15_000);

  afterAll(async () => {
    if (stopServer) await stopServer();
  });

  let otel: ReturnType<typeof setupOTel>;

  beforeEach(() => {
    if (!serverOk) return;
    otel = setupOTel();
  });

  afterEach(async () => {
    if (!serverOk) return;
    await otel.teardown();
  });

  it('publish injects traceparent into NATS message headers over WebSocket', async () => {
    if (!serverOk) {
      return;
    }

    const conn = await wsconnect({
      servers: wsUrl,
      wsFactory: (u) => ({
        socket: new Ws(u) as unknown as globalThis.WebSocket,
        encrypted: u.startsWith('wss:'),
      }),
    });

    const subj = 'test.ws.traceheaders';
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
  }, 20_000);
});
