import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { webSocket } from '@marz32one/otel-rxjs-ws';
import {
  context,
  trace,
  SpanKind,
  propagation,
} from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';

const argv = process.argv.slice(2);
function getArg(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

const wsUrl = getArg('--wsUrl') ?? 'ws://localhost:8085/otel-ws';
const tempoUrl = getArg('--tempoUrl') ?? 'http://localhost:3200';
const waitFlush = Number(getArg('--waitFlush') ?? '10');

// RxJS webSocket (Node) needs a WebSocket ctor.
globalThis.WebSocket = WebSocket;

const propagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

const provider = new NodeTracerProvider({
  // We don't need to export client spans; we only need trace IDs to be
  // injected by @marz32one/otel-rxjs-ws.
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
});
provider.register({ propagator });
propagation.setGlobalPropagator(propagator);

const tracer = trace.getTracer('verify-ws-rxjs-client');

function queryTempoTrace(traceId) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 120;
  const end = now + 10;
  const url = `${tempoUrl}/api/traces/${traceId}?start=${start}&end=${end}`;
  return fetch(url, { headers: { Accept: 'application/json' } }).then((r) =>
    r.json(),
  );
}

const payload = { text: 'verify-ws-trace' };

const ack = await new Promise((resolve, reject) => {
  let subject;

  subject = webSocket({
    url: wsUrl,
    openObserver: {
      next: () => {
        const parent = tracer.startSpan('verify-client-send', {
          kind: SpanKind.CLIENT,
        });
        const parentCtx = trace.setSpan(context.active(), parent);
        context.with(parentCtx, () => {
          subject.next(payload);
        });
        parent.end();
      },
    },
  });

  const subscription = subject.subscribe({
    next: (msg) => {
      try {
        subscription.unsubscribe();
        subject.complete();
      } catch {
        // ignore
      }
      resolve(msg);
    },
    error: (err) => reject(err),
  });
});

const traceId = ack?.traceId;
if (!traceId) {
  console.error('Expected ack.traceId, got:', ack);
  console.error(
    "Hint: verify wsUrl points to /otel-ws and Sec-WebSocket-Protocol negotiation succeeded with 'otel-ws'.",
  );
  process.exit(1);
}

console.log('  traceId:', traceId);
console.log(`  Waiting ${waitFlush}s for collector/Tempo flush...`);
await sleep(waitFlush * 1000);

const traceJson = await queryTempoTrace(traceId);
const jsonStr = JSON.stringify(traceJson);

const hasSend = jsonStr.includes('websocket.send');
const hasReceive = jsonStr.includes('websocket.receive');

if (!hasSend || !hasReceive) {
  console.error('Tempo trace did not contain expected websocket spans.');
  console.error('hasSend:', hasSend, 'hasReceive:', hasReceive);
  process.exit(1);
}

console.log('  OK: Tempo trace contains websocket.send and websocket.receive');

