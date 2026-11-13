const env = process.env;

export const PORTS = {
  gateway: Number(env.GATEWAY_PORT) || 4000,
  users: Number(env.USERS_PORT) || 4001,
  content: Number(env.CONTENT_PORT) || 4002,
};

export const SUBGRAPHS = [
  { name: 'users', url: `http://localhost:${PORTS.users}/graphql` },
  { name: 'content', url: `http://localhost:${PORTS.content}/graphql` },
];

export const LIMITS = {
  maxPageSize: 100, // больше 100 записей за раз не отдаём
  maxDepth: 8, // максимальная вложенность запроса
  rateLimitPerMinute: Number(env.RATE_LIMIT) || 300, // запросов в минуту с одного IP
  subgraphTimeoutMs: 5000, // таймаут запроса шлюза к сервису
};
