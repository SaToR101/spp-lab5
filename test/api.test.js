// Интеграционные тесты: поднимаем users, content и gateway на отдельных портах
// и проверяем систему только через GraphQL, как это делает фронтенд.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

const env = { ...process.env, GATEWAY_PORT: '14000', USERS_PORT: '14001', CONTENT_PORT: '14002', RATE_LIMIT: '100000' };
const GATEWAY = `http://localhost:${env.GATEWAY_PORT}`;
const children = {};

function start(name) {
  children[name] = fork(new URL(`../services/${name}.js`, import.meta.url), { env, silent: true });
}

async function waitFor(check, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {
      // сервис ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('сервисы не запустились вовремя');
}

const health = async () => (await fetch(`${GATEWAY}/health`)).json();

async function gql(query, variables = {}) {
  const res = await fetch(`${GATEWAY}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

before(async () => {
  ['users', 'content', 'gateway'].forEach(start);
  await waitFor(async () => (await health()).status === 'ok');
});

after(() => {
  for (const child of Object.values(children)) child.kill();
});

test('запрос с несколькими уровнями вложенности через два подграфа', async () => {
  const { data, errors } = await gql(`{
    countries(sort: USERS, dir: DESC, pageSize: 1) {
      items { code usersCount users(pageSize: 2) { items { fullName postsCount posts(pageSize: 1) { items { title } } } } }
    }
  }`);
  assert.equal(errors, undefined);
  const country = data.countries.items[0];
  assert.ok(country.usersCount > 0);
  assert.equal(country.users.items.length, 2);
  assert.equal(typeof country.users.items[0].postsCount, 'number');
});

test('поиск, фильтр, сортировка и пагинация пользователей', async () => {
  const { data } = await gql(`{
    users(search: "a", filter: { gender: FEMALE, minAge: 30, maxAge: 40 }, sort: AGE, dir: DESC, page: 2, pageSize: 10) {
      pageInfo { total page hasPrev }
      items { gender age }
    }
  }`);
  const { pageInfo, items } = data.users;
  assert.equal(pageInfo.page, 2);
  assert.ok(pageInfo.hasPrev);
  assert.ok(items.every((u) => u.gender === 'FEMALE' && u.age >= 30 && u.age <= 40));
  assert.deepEqual(items.map((u) => u.age), [...items.map((u) => u.age)].sort((a, b) => b - a));
});

test('директивы @include формируют запрос динамически', async () => {
  const query = `query($a: Boolean!) { posts(pageSize: 1) { items { id author @include(if: $a) { fullName } } } }`;
  const on = await gql(query, { a: true });
  const off = await gql(query, { a: false });
  assert.ok('author' in on.data.posts.items[0]);
  assert.ok(!('author' in off.data.posts.items[0]));
});

test('мутации: создать пользователя, пост, лайк, комментарий, удалить', async () => {
  const user = await gql(`mutation { createUser(input: { firstName: "Тест", lastName: "Тестов", email: "t@t.by", countryCode: "by" }) { id country { code } } }`);
  const userId = user.data.createUser.id;
  assert.equal(user.data.createUser.country.code, 'BY');

  const post = await gql(`mutation($a: ID!) { createPost(input: { title: "Тестовый пост", body: "текст", authorId: $a }) { id author { fullName } } }`, { a: userId });
  const postId = post.data.createPost.id;
  assert.equal(post.data.createPost.author.fullName, 'Тест Тестов');

  assert.equal((await gql(`mutation { likePost(id: "${postId}") { likes } }`)).data.likePost.likes, 1);
  await gql(`mutation { addComment(postId: "${postId}", body: "привет") { id } }`);
  const check = await gql(`{ user(id: "${userId}") { postsCount posts { items { commentsCount } } } }`);
  assert.equal(check.data.user.postsCount, 1);
  assert.equal(check.data.user.posts.items[0].commentsCount, 1);

  assert.equal((await gql(`mutation { deletePost(id: "${postId}") }`)).data.deletePost, true);
  assert.equal((await gql(`mutation { deleteUser(id: "${userId}") }`)).data.deleteUser, true);
});

test('валидация входных данных и лимиты', async () => {
  const badEmail = await gql(`mutation { createUser(input: { firstName: "a", lastName: "b", email: "нет" }) { id } }`);
  assert.equal(badEmail.errors[0].extensions.code, 'BAD_USER_INPUT');

  const bigPage = await gql(`{ users(pageSize: 1000) { items { id } } }`);
  assert.match(bigPage.errors[0].message, /pageSize/);

  const deep = await gql(`{ countries { items { users { items { posts { items { comments { items { post { author { country { name } } } } } } } } } } } }`);
  assert.match(deep.errors[0].message, /глубокий/);
});

test('мониторинг и трассировка', async () => {
  const res = await gql('{ userStats { total } contentStats { posts } }');
  assert.ok(res.extensions.traceId);
  assert.deepEqual(res.extensions.spans.map((s) => s.service).sort(), ['content', 'users']);

  const metrics = await (await fetch(`${GATEWAY}/metrics`)).text();
  assert.match(metrics, /graphql_requests_total/);
  const traces = await (await fetch(`${GATEWAY}/traces`)).json();
  assert.ok(traces.length > 0);
});

test('отказоустойчивость: при падении content шлюз отдаёт частичный ответ', async () => {
  children.content.kill();
  await waitFor(async () => (await health()).status === 'degraded');

  const { data, errors } = await gql('{ users(pageSize: 2) { items { fullName postsCount } } }');
  assert.equal(data.users.items.length, 2); // users отвечает
  assert.equal(data.users.items[0].postsCount, null); // поле из content — null
  assert.ok(errors.length > 0);

  start('content');
  await waitFor(async () => (await health()).status === 'ok');
});
