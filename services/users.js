// Подграф users: пользователи и страны (порт 4001)
import { randomUUID } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { loadData, groupBy, countBy } from '../lib/data.js';
import { paginate, when } from '../lib/list.js';
import { startSubgraph } from '../lib/subgraph.js';
import { PORTS } from '../lib/config.js';

const data = loadData();

// ---- индексы в памяти: поиск по id за O(1), вложенные списки без перебора ----
const countries = data.countries;
const countryByCode = new Map(countries.map((c) => [c.code, c]));
const codeByName = new Map(countries.map((c) => [c.name.toLowerCase(), c.code]));
for (const c of countries) c._search = `${c.name} ${c.officialName} ${c.capital ?? ''} ${c.code}`.toLowerCase();

const users = data.users;
const userById = new Map();
const prepareUser = (u) => {
  u.countryCode ??= codeByName.get(u.countryName?.toLowerCase()) ?? null;
  u._search = `${u.firstName} ${u.lastName} ${u.email} ${u.city ?? ''}`.toLowerCase();
  userById.set(u.id, u);
};
users.forEach(prepareUser);
let usersByCountry = groupBy(users, 'countryCode');

const userSort = { NAME: (u) => `${u.lastName} ${u.firstName}`, AGE: (u) => u.age, REGISTERED_AT: (u) => u.registeredAt };
const countrySort = { NAME: (c) => c.name, AREA: (c) => c.area, USERS: (c) => usersByCountry.get(c.code)?.length ?? 0 };

function listUsers(list, { search, filter = {}, sort, dir, page, pageSize }) {
  return paginate(list, {
    search,
    filters: [
      ...when(filter.source, (u) => u.source === filter.source),
      ...when(filter.gender, (u) => u.gender === filter.gender),
      ...when(filter.countryCode, (u) => u.countryCode === filter.countryCode.toUpperCase()),
      ...when(filter.minAge, (u) => u.age != null && u.age >= filter.minAge),
      ...when(filter.maxAge, (u) => u.age != null && u.age <= filter.maxAge),
    ],
    sortKey: userSort[sort],
    dir,
    page,
    pageSize,
  });
}

const resolvers = {
  Query: {
    users: (_, args) => listUsers(users, args),
    user: (_, { id }) => userById.get(id),
    countries: (_, { search, region, sort, dir, page, pageSize }) =>
      paginate(countries, { search, filters: when(region, (c) => c.region === region), sortKey: countrySort[sort], dir, page, pageSize }),
    country: (_, { code }) => countryByCode.get(code.toUpperCase()),
    regions: () => [...new Set(countries.map((c) => c.region))].sort(),
    userStats: () => ({}),
  },
  UserStats: {
    total: () => users.length,
    countries: () => countries.length,
    bySource: () => countBy(users, 'source'),
    byGender: () => countBy(users.filter((u) => u.gender), 'gender'),
    byCountry: (_, { limit }) =>
      countBy(users, 'countryCode')
        .slice(0, limit)
        .map((b) => ({ key: `${countryByCode.get(b.key)?.flag ?? ''} ${b.key}`.trim(), count: b.count })),
  },
  Mutation: {
    createUser: (_, { input }) => {
      if (!input.firstName.trim() || !input.lastName.trim()) throw badInput('Имя и фамилия обязательны');
      if (!/^\S+@\S+\.\S+$/.test(input.email)) throw badInput('Некорректный email');
      if (input.age != null && (input.age < 0 || input.age > 150)) throw badInput('Некорректный возраст');
      const code = input.countryCode?.toUpperCase() ?? null;
      if (code && !countryByCode.has(code)) throw badInput(`Страна ${code} не найдена`);
      const user = { ...input, id: `local-${randomUUID().slice(0, 8)}`, source: 'LOCAL', countryCode: code, city: null, avatar: null, registeredAt: new Date().toISOString() };
      prepareUser(user);
      users.unshift(user);
      usersByCountry = groupBy(users, 'countryCode');
      return user;
    },
    deleteUser: (_, { id }) => {
      const i = users.findIndex((u) => u.id === id);
      if (i === -1) return false;
      users.splice(i, 1);
      userById.delete(id);
      usersByCountry = groupBy(users, 'countryCode');
      return true;
    },
  },
  User: {
    // вызывается, когда другой подграф (content) ссылается на пользователя по id
    __resolveReference: ({ id }) => userById.get(id),
    fullName: (u) => `${u.firstName} ${u.lastName}`.trim(),
    country: (u) => countryByCode.get(u.countryCode),
  },
  Country: {
    __resolveReference: ({ code }) => countryByCode.get(code),
    usersCount: (c) => usersByCountry.get(c.code)?.length ?? 0,
    users: (c, args) => listUsers(usersByCountry.get(c.code) ?? [], args),
  },
};

const badInput = (msg) => new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });

console.log(`[users] загружено: ${users.length} пользователей, ${countries.length} стран`);
await startSubgraph({ name: 'users', port: PORTS.users, resolvers });
