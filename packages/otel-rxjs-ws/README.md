# @marz32one/otel-rxjs-ws

RxJS **`webSocket`-style** OpenTelemetry instrumentation, aligned with [`instrumentation-go/otel-gorilla-ws`](https://github.com/Marz32onE/instrumentation-go/tree/main/otel-gorilla-ws).

This package is **ESM-only** (`"type": "module"`). Run `npm run build` so `dist/` exists before consuming from `file:` or npm.

## Wire format

Trace headers are merged into the outgoing JSON object (**flat** — no wrapper key):

```json
{ "your": "payload", "traceparent": "00-…", "tracestate": "…" }
```

On receive, `traceparent` and `tracestate` are extracted from top-level fields; the remainder is returned as the message payload. Non-object messages (arrays, plain text) are passed through without trace extraction.

## Install

```bash
npm install @marz32one/otel-rxjs-ws @opentelemetry/api rxjs
```

## Usage

```typescript
import { webSocket } from '@marz32one/otel-rxjs-ws/webSocket';
// same as: import { webSocket } from '@marz32one/otel-rxjs-ws';

const ws = webSocket<MyType>({ url: 'ws://localhost:8082/ws' });
ws.subscribe({ next: console.log, error: console.error });
ws.next({ foo: 'bar' });
ws.complete();
```

## Spans created

| Path | Span name | Kind |
|------|-----------|------|
| `next` (outgoing) | `websocket.send` | Producer |
| Incoming message | `websocket.receive` | Consumer |

`websocket.receive` is a child of the extracted sender context when trace context is present.

## Diagnostic logging

The package logs via `@opentelemetry/api`'s `diag` — silent by default. Enable in your app entry point:

```typescript
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
```

| Level | Events logged |
|-------|--------------|
| `DEBUG` | JSON parse fallback on receive |
| `WARN` | Custom serializer returned non-string (trace wrapping skipped) |
| `ERROR` | Serialization failure; custom deserializer threw |

## License

Apache-2.0
