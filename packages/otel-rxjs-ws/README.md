# @marz32one/otel-rxjs-ws

RxJS **`webSocket`-style** OpenTelemetry instrumentation, aligned with [`instrumentation-go/otel-gorilla-ws`](https://github.com/Marz32onE/instrumentation-go/tree/main/otel-gorilla-ws).

This package is **ESM-only** (`"type": "module"`). Run `npm run build` so `dist/` exists before consuming from `file:` or npm.

## Wire formats

| Kind | Shape |
|------|--------|
| **Embedded** (default send) | `{ "traceparent"?, "tracestate"?, "data": … }` |
| **Header-style** (receive compat) | `{ "headers": { "traceparent"?, … }, "payload": "<base64>" }` |

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

## License

Apache-2.0
