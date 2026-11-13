import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { readFileSync } from 'node:fs';
import { parse } from 'graphql';

// SDL сервиса = общие типы (common.graphql) + собственная схема
export function readSchema(name) {
  const read = (f) => readFileSync(new URL(`../schema/${f}.graphql`, import.meta.url), 'utf8');
  return read('common') + '\n' + read(name);
}

// Трассировка: каждый запрос логируется с trace-id, который прислал шлюз
const tracingPlugin = (name) => ({
  async requestDidStart({ request, contextValue }) {
    const start = performance.now();
    return {
      async willSendResponse({ errors }) {
        const ms = (performance.now() - start).toFixed(1);
        const op = request.query?.includes('_entities') ? '_entities' : request.operationName ?? 'anonymous';
        console.log(`[${name}] trace=${contextValue.traceId ?? '-'} op=${op} ${ms}ms${errors ? ` errors=${errors.length}` : ''}`);
      },
    };
  },
});

export async function startSubgraph({ name, port, resolvers }) {
  const server = new ApolloServer({
    schema: buildSubgraphSchema([{ typeDefs: parse(readSchema(name)), resolvers }]),
    plugins: [tracingPlugin(name)],
    includeStacktraceInErrorResponses: false,
  });
  const { url } = await startStandaloneServer(server, {
    listen: { port },
    context: async ({ req }) => ({ traceId: req.headers['x-trace-id'] }),
  });
  console.log(`[${name}] подграф запущен: ${url}`);
}
