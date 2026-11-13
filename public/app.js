// Фронтенд ЛР5 «GraphQL Explorer».
// С бэкендом общается ТОЛЬКО через GraphQL: единственный адрес — POST /graphql на шлюзе.
// Никаких REST-запросов и прямых обращений к подграфам здесь нет.
'use strict';

// ---------- утилиты ----------
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Данные приходят из внешних API, поэтому всё, что вставляем в HTML, экранируем (защита от XSS)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
const num = (value) => (value === '' || value == null ? null : Number(value));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(n ?? 0);
const cut = (text, max = 140) => (text.length > max ? `${text.slice(0, max)}…` : text);
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

const GENDER = { MALE: 'муж.', FEMALE: 'жен.' };
const KIND = { POST: 'посты', QUOTE: 'цитаты' };
const PAGE_SIZE = 20;
const PAGE_INFO = 'pageInfo { total page pageSize totalPages hasNext hasPrev }';

// ---------- панель справа: ошибки и последний запрос ----------
function showErrors(messages, append = false) {
  const box = $('#errors');
  if (!append) box.innerHTML = '';
  for (const message of new Set(messages)) box.insertAdjacentHTML('beforeend', `<div>${esc(message)}</div>`);
}

function showDebug(query, variables, json, ms) {
  const ext = json?.extensions; // шлюз кладёт в ответ trace-id и время каждого сервиса
  const spans = (ext?.spans ?? []).map((s) => `${s.service} ${s.ms} мс`).join(', ');
  $('#debugMeta').textContent = `· ${Math.round(ms)} мс${ext?.traceId ? ` · trace ${ext.traceId}` : ''}${spans ? ` · ${spans}` : ''}`;
  $('#debugQuery').textContent = query.trim();
  $('#debugVars').textContent = JSON.stringify(variables, null, 2);
}

// ---------- GraphQL-клиент ----------
// opts.silent — не трогать панель «последний запрос»; opts.append — не стирать прежние ошибки
async function gql(query, variables = {}, operationName, opts = {}) {
  const started = performance.now();
  let response;
  let json;
  try {
    response = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables, operationName }),
      signal: AbortSignal.timeout(15_000),
    });
    json = await response.json();
  } catch (err) {
    showErrors([`Нет связи со шлюзом: ${err.message}`], opts.append);
    throw err;
  }
  if (!opts.silent) showDebug(query, variables, json, performance.now() - started);
  showErrors((json.errors ?? []).map((e) => e.message), opts.append);
  // data == null — запрос провалился целиком; иначе это частичный ответ (часть полей может быть null)
  if (!json.data) throw new Error(json.errors?.[0]?.message ?? `HTTP ${response.status}`);
  return json.data;
}

function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (el.name) values[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return values;
}

// ---------- запросы (строятся динамически по состоянию формы) ----------
function usersQuery(f) {
  const withPosts = f.withPosts || f.withComments;
  return `query Users($search: String, $filter: UserFilter, $sort: UserSort, $dir: SortDir, $page: Int, $pageSize: Int) {
  users(search: $search, filter: $filter, sort: $sort, dir: $dir, page: $page, pageSize: $pageSize) {
    ${PAGE_INFO}
    items {
      id source fullName email gender age city avatar
      ${f.withCountry ? 'country { code name flag region }' : ''}
      ${
        withPosts
          ? `postsCount
      posts(pageSize: 3) {
        items {
          id title likes
          ${f.withComments ? 'commentsCount comments(pageSize: 2) { items { body authorName } }' : ''}
        }
      }`
          : ''
      }
    }
  }
}`;
}

const usersVars = (f, page) => ({
  search: f.search || null,
  filter: clean({ source: f.source, gender: f.gender, countryCode: f.countryCode, minAge: num(f.minAge), maxAge: num(f.maxAge) }),
  sort: f.sort,
  dir: f.dir,
  page,
  pageSize: PAGE_SIZE,
});

// Для постов вложенные данные включаются директивами @include (второй способ динамики)
const POSTS_QUERY = `query Posts($search: String, $filter: PostFilter, $sort: PostSort, $dir: SortDir, $page: Int, $pageSize: Int, $withAuthor: Boolean!, $withComments: Boolean!) {
  posts(search: $search, filter: $filter, sort: $sort, dir: $dir, page: $page, pageSize: $pageSize) {
    ${PAGE_INFO}
    items {
      id source kind title body tags likes views commentsCount
      author @include(if: $withAuthor) { id fullName country { name flag } }
      comments(pageSize: 3) @include(if: $withComments) { items { body authorName author { fullName } } }
    }
  }
}`;

const postsVars = (f, page) => ({
  search: f.search || null,
  filter: clean({ source: f.source, kind: f.kind, tag: f.tag, minLikes: num(f.minLikes) }),
  sort: f.sort,
  dir: f.dir,
  page,
  pageSize: PAGE_SIZE,
  withAuthor: f.withAuthor,
  withComments: f.withComments,
});

const COUNTRIES_QUERY = `query Countries($search: String, $region: String, $sort: CountrySort, $dir: SortDir, $page: Int, $pageSize: Int, $withUsers: Boolean!) {
  countries(search: $search, region: $region, sort: $sort, dir: $dir, page: $page, pageSize: $pageSize) {
    ${PAGE_INFO}
    items {
      code name officialName region subregion capital area languages currencies flag usersCount
      users(pageSize: 3) @include(if: $withUsers) {
        items { id fullName age postsCount posts(pageSize: 2) { items { title } } }
      }
    }
  }
}`;

const countriesVars = (f, page) => ({
  search: f.search || null,
  region: f.region || null,
  sort: f.sort,
  dir: f.dir,
  page,
  pageSize: PAGE_SIZE,
  withUsers: f.withUsers,
});

// Статистика берётся двумя независимыми запросами: если упадёт один сервис, второй блок всё равно покажется
const USER_STATS_QUERY = `query UserStats {
  userStats { total countries bySource { key count } byGender { key count } byCountry(limit: 10) { key count } }
}`;
const CONTENT_STATS_QUERY = `query ContentStats {
  contentStats { posts comments bySource { key count } byKind { key count } }
  tags(limit: 15) { key count }
}`;

// ---------- отрисовка ----------
function renderPager(pager, info) {
  if (!pager) return;
  pager.innerHTML = `
    <button data-page="${info.page - 1}" ${info.hasPrev ? '' : 'disabled'}>← Назад</button>
    <span>Страница ${info.page} из ${fmt(info.totalPages)} · найдено ${fmt(info.total)}</span>
    <button data-page="${info.page + 1}" ${info.hasNext ? '' : 'disabled'}>Вперёд →</button>`;
}

const unavailable = (what) => `<div class="nested muted">${esc(what)} недоступны (сервис не отвечает)</div>`;

function commentsBlock(post) {
  if (!post.comments) return '';
  const items = post.comments.items.map((c) => `<div class="muted">💬 ${esc(c.author?.fullName ?? c.authorName ?? 'аноним')}: ${esc(cut(c.body, 100))}</div>`);
  return `<div class="nested">${items.join('') || '<div class="muted">комментариев нет</div>'}</div>`;
}

function userPostsBlock(user) {
  if (user.posts === undefined) return ''; // вложенные посты не запрашивались
  if (user.posts === null) return unavailable('Посты');
  const items = user.posts.items.map(
    (p) => `<div>📝 ${esc(cut(p.title, 80))} <span class="muted">♥ ${p.likes}</span>${commentsBlock(p)}</div>`,
  );
  return `<div class="nested"><div class="muted">Постов у пользователя: ${user.postsCount ?? '—'}</div>${items.join('')}</div>`;
}

function renderUsers({ users }, list, pager) {
  renderPager(pager, users.pageInfo);
  if (!users.items.length) {
    list.innerHTML = '<p class="empty">Ничего не найдено</p>';
    return;
  }
  list.innerHTML = users.items
    .map(
      (u) => `<div class="card">
    <h3>${u.avatar ? `<img src="${esc(u.avatar)}" alt="" loading="lazy" />` : ''}${esc(u.fullName)}</h3>
    <div class="muted">${esc(u.email)}</div>
    <div><span class="badge">${esc(u.source)}</span>${u.gender ? esc(GENDER[u.gender]) : ''} ${u.age != null ? `${u.age} лет` : ''} ${u.city ? `· ${esc(u.city)}` : ''}</div>
    ${u.country ? `<div>${esc(u.country.flag)} ${esc(u.country.name)} <span class="muted">(${esc(u.country.region)})</span></div>` : ''}
    ${userPostsBlock(u)}
    <div class="actions"><button data-action="deleteUser" data-id="${esc(u.id)}">Удалить</button></div>
  </div>`,
    )
    .join('');
}

function renderPosts({ posts }, list, pager) {
  renderPager(pager, posts.pageInfo);
  if (!posts.items.length) {
    list.innerHTML = '<p class="empty">Ничего не найдено</p>';
    return;
  }
  list.innerHTML = posts.items
    .map((p) => {
      let author = '';
      if (p.author !== undefined) {
        author = p.author
          ? `<div>👤 ${esc(p.author.fullName)} ${p.author.country ? `<span class="muted">${esc(p.author.country.flag)} ${esc(p.author.country.name)}</span>` : ''}</div>`
          : '<div class="muted">👤 автор недоступен или не указан</div>';
      }
      return `<div class="card">
    <h3>${esc(p.title)}</h3>
    <div><span class="badge">${p.kind === 'QUOTE' ? 'цитата' : 'пост'}</span><span class="badge">${esc(p.source)}</span>${p.tags.map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}</div>
    <p>${esc(cut(p.body, 300))}</p>
    <div class="muted">♥ ${fmt(p.likes)} · 👁 ${fmt(p.views)} · 💬 ${fmt(p.commentsCount)}</div>
    ${author}
    ${commentsBlock(p)}
    <div class="actions">
      <button data-action="likePost" data-id="${esc(p.id)}">♥ Лайк</button>
      <button data-action="addComment" data-id="${esc(p.id)}">💬 Комментировать</button>
      <button data-action="deletePost" data-id="${esc(p.id)}">Удалить</button>
    </div>
  </div>`;
    })
    .join('');
}

function renderCountries({ countries }, list, pager) {
  renderPager(pager, countries.pageInfo);
  if (!countries.items.length) {
    list.innerHTML = '<p class="empty">Ничего не найдено</p>';
    return;
  }
  list.innerHTML = countries.items
    .map((c) => {
      let users = '';
      if (c.users) {
        const rows = c.users.items.map((u) => {
          const posts = u.posts ? u.posts.items.map((p) => `<div class="nested muted">📝 ${esc(cut(p.title, 60))}</div>`).join('') : '';
          return `<div>👤 ${esc(u.fullName)} <span class="muted">${u.age != null ? `${u.age} лет · ` : ''}постов: ${u.postsCount ?? '—'}</span>${posts}</div>`;
        });
        users = `<div class="nested">${rows.join('') || '<div class="muted">пользователей нет</div>'}</div>`;
      }
      return `<div class="card">
    <h3>${esc(c.flag)} ${esc(c.name)}</h3>
    <div class="muted">${esc(c.officialName)}</div>
    <div><span class="badge">${esc(c.region)}</span>${c.subregion ? `<span class="badge">${esc(c.subregion)}</span>` : ''}</div>
    <div>Столица: ${esc(c.capital ?? '—')} · площадь: ${c.area != null ? `${fmt(c.area)} км²` : '—'}</div>
    <div class="muted">Языки: ${esc(c.languages.join(', ') || '—')} · валюты: ${esc(c.currencies.join(', ') || '—')}</div>
    <div>Пользователей в базе: <b>${fmt(c.usersCount)}</b></div>
    ${users}
  </div>`;
    })
    .join('');
}

function barBlock(title, buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const rows = buckets
    .map((b) => `<div class="bar"><span>${esc(b.key)}</span><div style="width:${Math.max(2, Math.round((b.count / max) * 100))}%"></div><span>${fmt(b.count)}</span></div>`)
    .join('');
  return `<div class="bars"><h3>${esc(title)}</h3>${rows}</div>`;
}

const bigBlock = (title, value, caption) =>
  `<div class="bars"><h3>${esc(title)}</h3><div class="big">${fmt(value)}</div><div class="muted">${esc(caption)}</div></div>`;

function renderStats({ users, content }, list) {
  const blocks = [];
  if (users) {
    blocks.push(
      bigBlock('Пользователи', users.total, `в справочнике ${fmt(users.countries)} стран`),
      barBlock('Пользователи по источникам', users.bySource),
      barBlock('Пользователи по полу', users.byGender.map((b) => ({ ...b, key: GENDER[b.key] ?? b.key }))),
      barBlock('Топ-10 стран по числу пользователей', users.byCountry),
    );
  } else {
    blocks.push(`<div class="bars"><h3>Пользователи</h3>${unavailable('Статистика пользователей')}</div>`);
  }
  if (content) {
    blocks.push(
      bigBlock('Посты и цитаты', content.contentStats.posts, `комментариев: ${fmt(content.contentStats.comments)}`),
      barBlock('Посты и комментарии по источникам', content.contentStats.bySource),
      barBlock('Посты и цитаты', content.contentStats.byKind.map((b) => ({ ...b, key: KIND[b.key] ?? b.key }))),
      barBlock('Популярные теги', content.tags),
    );
  } else {
    blocks.push(`<div class="bars"><h3>Контент</h3>${unavailable('Статистика контента')}</div>`);
  }
  list.innerHTML = blocks.join('');
}

async function loadStats() {
  showErrors([]);
  const opts = { append: true };
  const [users, content] = await Promise.allSettled([gql(USER_STATS_QUERY, {}, 'UserStats', opts), gql(CONTENT_STATS_QUERY, {}, 'ContentStats', opts)]);
  return { users: users.value?.userStats ?? null, content: content.value ?? null };
}

// ---------- вкладки ----------
const TABS = {
  users: { load: (f, page) => gql(usersQuery(f), usersVars(f, page), 'Users'), render: renderUsers },
  posts: { load: (f, page) => gql(POSTS_QUERY, postsVars(f, page), 'Posts'), render: renderPosts },
  countries: { load: (f, page) => gql(COUNTRIES_QUERY, countriesVars(f, page), 'Countries'), render: renderCountries },
  stats: { load: () => loadStats(), render: renderStats },
};
const state = { users: { page: 1 }, posts: { page: 1 }, countries: { page: 1 } };
const requestNo = {};

async function loadTab(name) {
  const section = $(`#${name}`);
  const list = $('.list', section);
  const pager = $('.pager', section);
  const form = $('form.filters', section);
  const filters = form ? formValues(form) : {};
  const no = (requestNo[name] = (requestNo[name] ?? 0) + 1);
  list.style.opacity = '0.5';
  try {
    const data = await TABS[name].load(filters, state[name]?.page ?? 1);
    if (no !== requestNo[name]) return; // пока грузилось, пользователь уже изменил фильтр — ответ устарел
    TABS[name].render(data, list, pager);
  } catch (err) {
    if (no !== requestNo[name]) return;
    list.innerHTML = `<p class="empty">Не удалось загрузить данные: ${esc(err.message)}</p>`;
    if (pager) pager.innerHTML = '';
  } finally {
    if (no === requestNo[name]) list.style.opacity = '';
  }
}

$('#tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-tab]');
  if (!button) return;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === button));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === button.dataset.tab));
  loadTab(button.dataset.tab);
});

// любое изменение фильтров -> первая страница и новый запрос (с задержкой, чтобы не слать запрос на каждую букву)
for (const name of ['users', 'posts', 'countries']) {
  const form = $(`#${name} form.filters`);
  const reload = debounce(() => {
    state[name].page = 1;
    loadTab(name);
  }, 300);
  form.addEventListener('input', reload);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    reload();
  });
}

// ---------- мутации ----------
const ACTIONS = {
  deleteUser: {
    ask: 'Удалить пользователя?',
    query: 'mutation DeleteUser($id: ID!) { deleteUser(id: $id) }',
    name: 'DeleteUser',
    vars: (id) => ({ id }),
  },
  deletePost: {
    ask: 'Удалить пост?',
    query: 'mutation DeletePost($id: ID!) { deletePost(id: $id) }',
    name: 'DeletePost',
    vars: (id) => ({ id }),
  },
  likePost: {
    query: 'mutation LikePost($id: ID!) { likePost(id: $id) { id likes } }',
    name: 'LikePost',
    vars: (id) => ({ id }),
  },
  addComment: {
    prompt: 'Текст комментария:',
    query: 'mutation AddComment($postId: ID!, $body: String!) { addComment(postId: $postId, body: $body) { id } }',
    name: 'AddComment',
    vars: (id, text) => ({ postId: id, body: text }),
  },
};

document.addEventListener('click', async (e) => {
  const pageButton = e.target.closest('.pager button[data-page]');
  if (pageButton) {
    const tab = pageButton.closest('section').id;
    state[tab].page = Number(pageButton.dataset.page);
    loadTab(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const action = ACTIONS[button.dataset.action];
  let text;
  if (action.ask && !confirm(action.ask)) return;
  if (action.prompt) {
    text = prompt(action.prompt);
    if (!text?.trim()) return;
  }
  const tab = button.closest('section').id;
  button.disabled = true;
  try {
    await gql(action.query, action.vars(button.dataset.id, text), action.name);
    await loadTab(tab);
  } catch {
    button.disabled = false; // текст ошибки уже показан в правой панели
  }
});

$('#createUser').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = formValues(e.target);
  const input = { firstName: v.firstName, lastName: v.lastName, email: v.email };
  if (v.age !== '') input.age = Number(v.age);
  if (v.countryCode) input.countryCode = v.countryCode.toUpperCase();
  try {
    await gql('mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id fullName } }', { input }, 'CreateUser');
    e.target.reset();
    $('#users form.filters [name="search"]').value = input.email; // сразу показываем созданного пользователя
    state.users.page = 1;
    loadTab('users');
  } catch {
    // ошибка валидации уже показана в правой панели
  }
});

$('#createPost').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = formValues(e.target);
  const input = { title: v.title, body: v.body, authorId: v.authorId, tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean) };
  try {
    await gql('mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { id title } }', { input }, 'CreatePost');
    e.target.reset();
    $('#posts form.filters [name="search"]').value = input.title; // сразу показываем созданный пост
    state.posts.page = 1;
    loadTab('posts');
  } catch {
    // ошибка валидации уже показана в правой панели
  }
});

// ---------- заполнение выпадающих списков (тоже через GraphQL) ----------
function fillSelect(select, options) {
  select.insertAdjacentHTML('beforeend', options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join(''));
}

async function initFilters() {
  // справочник стран больше лимита страницы (100), поэтому берём 3 страницы одним запросом через алиасы
  const pages = [1, 2, 3].map((p) => `c${p}: countries(sort: NAME, page: ${p}, pageSize: 100) { items { code name } }`).join('\n');
  const opts = { silent: true, append: true };
  const [geo, tags] = await Promise.allSettled([
    gql(`query UsersFilters { regions ${pages} }`, {}, 'UsersFilters', opts),
    gql('query ContentFilters { tags(limit: 60) { key } }', {}, 'ContentFilters', opts),
  ]);
  if (geo.status === 'fulfilled') {
    const countries = [...geo.value.c1.items, ...geo.value.c2.items, ...geo.value.c3.items];
    fillSelect($('#users select[name="countryCode"]'), countries.map((c) => ({ value: c.code, label: c.name })));
    fillSelect($('#countries select[name="region"]'), geo.value.regions.filter(Boolean).map((r) => ({ value: r, label: r })));
  }
  if (tags.status === 'fulfilled') {
    fillSelect($('#posts select[name="tag"]'), tags.value.tags.map((t) => ({ value: t.key, label: t.key })));
  }
}

initFilters();
loadTab('users');
