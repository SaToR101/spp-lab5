// Шлюз GraphQL Federation (порт 4000): единая точка входа для фронтенда.
// Собирает суперграф из подграфов users и content, раздаёт фронтенд,
// ограничивает нагрузку, собирает метрики и трассировки.
import express from 'express';
import rateLimit from 'express-rate-limit';
import client from 'prom-client';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloGateway, RemoteGraphQLDataSource } from '@apollo/gateway';
import { composeServices } from '@apollo/composition';
import { GraphQLError, parse } from 'graphql';
import { readSchema } from '../lib/subgraph.js';
import { PORTS, SUBGRAPHS, LIMITS } from '../lib/config.js';

// ---------- Мониторинг (Prometheus, GET /metrics) ----------
client.collectDefaultMetrics();
const requestsTotal = new client.Counter({ name: 'graphql_requests_total', help: 'GraphQL запросы', labelNames: ['operation', 'status'] });
const requestDuration = new client.Histogram({ name: 'graphql_request_duration_seconds', help: 'Время ответа шлюза', labelNames: ['operation'] });
const subgraphDuration = new client.Histogram({ name: 'subgraph_request_duration_seconds', help: 'Время ответа подграфов', labelNames: ['service', 'status'] });

// ---------- Трассировка: последние 100 запросов (GET /traces) ----------
const traces = [];

// Запрос шлюза к подграфу: пробрасываем trace-id, ставим таймаут, замеряем время (span)
class TracedDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }) {
    if (context?.traceId) request.http.headers.set('x-trace-id', context.traceId);
  }

  async process(options) {
    const start = performance.now();
    let status = 'ok';
    try {
      return await super.process(options);
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      const ms = performance.now() - start;
      subgraphDuration.observe({ service: this.name, status }, ms / 1000);
      options.context?.spans?.push({ service: this.name, ms: +ms.toFixed(1), status });
    }
  }
}

const tracingPlugin = {
  async requestDidStart() {
    const start = performance.now();
    return {
      async willSendResponse({ request, response, contextValue, errors }) {
        const ms = performance.now() - start;
        const operation = request.operationName ?? 'anonymous';
        const status = errors?.length ? 'error' : 'ok';
        requestsTotal.inc({ operation, status });
        requestDuration.observe({ operation }, ms / 1000);
        const trace = { traceId: contextValue.traceId, operation, ms: +ms.toFixed(1), status, spans: contextValue.spans, at: new Date().toISOString() };
        traces.unshift(trace);
        traces.length = Math.min(traces.length, 100);
        console.log(`[gateway] trace=${trace.traceId} op=${operation} ${trace.ms}ms ${status} spans=${trace.spans.map((s) => `${s.service}:${s.ms}ms`).join(',')}`);
        // фронтенд получает trace-id и время прямо в ответе GraphQL
        if (response.body.kind === 'single') {
          const { traceId, spans } = trace;
          response.body.singleResult.extensions = { ...response.body.singleResult.extensions, traceId, durationMs: trace.ms, spans };
        }
      },
    };
  },
};

// ---------- Контроль нагрузки: ограничение глубины запроса ----------
// shortcut: фрагменты считаются без учёта глубины места вставки; для строгого контроля — graphql-query-complexity
function depthLimit(context) {
  return {
    Field(node, key, parent, path, ancestors) {
      const fields = ancestors.filter((a) => a.kind === 'Field');
      if (node.name.value.startsWith('__') || fields.some((f) => f.name.value.startsWith('__'))) return; // introspection
      if (fields.length + 1 > LIMITS.maxDepth) {
        context.reportError(new GraphQLError(`Слишком глубокий запрос: максимум ${LIMITS.maxDepth} уровней`, { nodes: [node] }));
      }
    },
  };
}

// ---------- Federation: статическая сборка суперграфа ----------
// Схема собирается из SDL-файлов, поэтому шлюз стартует, даже если какой-то подграф лежит,
// а запросы к живым подграфам продолжают работать (частичный ответ + ошибка по упавшему).
const { supergraphSdl, errors } = composeServices(
  SUBGRAPHS.map(({ name, url }) => ({ name, url, typeDefs: parse(readSchema(name)) })),
);
if (errors) throw new Error(`Ошибка композиции суперграфа:\n${errors.map((e) => e.message).join('\n')}`);

const gateway = new ApolloGateway({
  supergraphSdl,
  buildService: ({ name, url }) =>
    new TracedDataSource({ name, url, fetcher: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(LIMITS.subgraphTimeoutMs) }) }),
});

const server = new ApolloServer({ gateway, plugins: [tracingPlugin], validationRules: [depthLimit], includeStacktraceInErrorResponses: false });
await server.start();

const app = express();
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

app.use(
  '/graphql',
  rateLimit({
    windowMs: 60_000,
    limit: LIMITS.rateLimitPerMinute,
    message: { errors: [{ message: 'Слишком много запросов, попробуйте через минуту', extensions: { code: 'RATE_LIMITED' } }] },
  }),
  express.json({ limit: '100kb' }),
  expressMiddleware(server, {
    context: async ({ req, res }) => {
      const traceId = req.get('x-trace-id') ?? randomUUID().slice(0, 8);
      res.set('x-trace-id', traceId);
      return { traceId, spans: [] };
    },
  }),
);

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

app.get('/traces', (_req, res) => res.json(traces));

// Проверка здоровья: шлюз опрашивает каждый подграф
app.get('/health', async (_req, res) => {
  const services = await Promise.all(
    SUBGRAPHS.map(async ({ name, url }) => {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{__typename}"}', signal: AbortSignal.timeout(2000) });
        return { name, status: r.ok ? 'up' : 'down' };
      } catch {
        return { name, status: 'down' };
      }
    }),
  );
  const ok = services.every((s) => s.status === 'up');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', uptimeSec: Math.round(process.uptime()), services });
});

app.listen(PORTS.gateway, () => {
  console.log(`[gateway] http://localhost:${PORTS.gateway}  (GraphQL: /graphql, метрики: /metrics, трассы: /traces, здоровье: /health)`);
});
