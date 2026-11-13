// Автоматический сбор данных из 4 открытых источников.
// Каждый источник сохраняется в свой файл data/<source>.json в общем формате
// { users, countries, posts, comments }. Если источник недоступен — остаётся старый файл (кэш).
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DATA_DIR = new URL('../data/', import.meta.url);

// fetch с таймаутом и повторными попытками (экспоненциальная задержка 1с, 2с, 4с)
export async function fetchJson(url, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt > retries) throw new Error(`${url}: ${err.message}`);
      console.warn(`  повтор ${attempt}/${retries} для ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

const empty = () => ({ users: [], countries: [], posts: [], comments: [] });

const sources = {
  // 1. randomuser.me — 10 000 пользователей (2 страницы по 5000, seed даёт одинаковые данные при каждом сборе)
  async randomuser() {
    const out = empty();
    for (const page of [1, 2]) {
      const { results } = await fetchJson(
        `https://randomuser.me/api/?results=5000&page=${page}&seed=spp-lab5&inc=gender,name,email,dob,registered,nat,location,picture&noinfo`,
      );
      for (const u of results) {
        out.users.push({
          id: `ru-${out.users.length + 1}`,
          source: 'RANDOMUSER',
          firstName: u.name.first,
          lastName: u.name.last,
          email: u.email,
          gender: u.gender.toUpperCase(),
          age: u.dob.age,
          city: u.location.city,
          countryCode: u.nat,
          avatar: u.picture.thumbnail,
          registeredAt: u.registered.date,
        });
      }
    }
    return out;
  },

  // 2. dummyjson.com — пользователи, посты, комментарии и цитаты
  async dummyjson() {
    const [{ users }, { posts }, { comments }, { quotes }] = await Promise.all(
      ['users', 'posts', 'comments', 'quotes'].map((r) => fetchJson(`https://dummyjson.com/${r}?limit=0`)),
    );
    return {
      users: users.map((u) => ({
        id: `dj-${u.id}`,
        source: 'DUMMYJSON',
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        gender: u.gender.toUpperCase(),
        age: u.age,
        city: u.address.city,
        countryName: u.address.country, // код страны вычисляется в users-сервисе по справочнику стран
        avatar: u.image,
        registeredAt: null,
      })),
      countries: [],
      posts: [
        ...posts.map((p) => ({
          id: `dj-${p.id}`,
          source: 'DUMMYJSON',
          kind: 'POST',
          title: p.title,
          body: p.body,
          tags: p.tags,
          likes: p.reactions.likes,
          views: p.views,
          authorId: `dj-${p.userId}`,
        })),
        ...quotes.map((q) => ({
          id: `djq-${q.id}`,
          source: 'DUMMYJSON',
          kind: 'QUOTE',
          title: q.author,
          body: q.quote,
          tags: ['quote'],
          likes: 0,
          views: 0,
          authorId: `ru-${q.id}`, // цитаты «публикуют» пользователи randomuser
        })),
      ],
      comments: comments.map((c) => ({
        id: `dj-${c.id}`,
        source: 'DUMMYJSON',
        postId: `dj-${c.postId}`,
        authorId: `dj-${c.user.id}`,
        authorName: c.user.fullName,
        body: c.body,
        likes: c.likes,
      })),
    };
  },

  // 3. jsonplaceholder.typicode.com — пользователи, посты, комментарии
  async jsonplaceholder() {
    const base = 'https://jsonplaceholder.typicode.com';
    const [users, posts, comments] = await Promise.all(['users', 'posts', 'comments'].map((r) => fetchJson(`${base}/${r}`)));
    return {
      users: users.map((u) => {
        const [firstName, ...rest] = u.name.split(' ');
        return {
          id: `jp-${u.id}`,
          source: 'JSONPLACEHOLDER',
          firstName,
          lastName: rest.join(' '),
          email: u.email,
          gender: null,
          age: null,
          city: u.address.city,
          countryCode: null,
          avatar: null,
          registeredAt: null,
        };
      }),
      countries: [],
      posts: posts.map((p) => ({
        id: `jp-${p.id}`,
        source: 'JSONPLACEHOLDER',
        kind: 'POST',
        title: p.title,
        body: p.body,
        tags: [],
        likes: 0,
        views: 0,
        authorId: `jp-${p.userId}`,
      })),
      comments: comments.map((c) => ({
        id: `jp-${c.id}`,
        source: 'JSONPLACEHOLDER',
        postId: `jp-${c.postId}`,
        authorId: null,
        authorName: c.email,
        body: c.body,
        likes: 0,
      })),
    };
  },

  // 4. mledoze/countries (GitHub) — справочник всех 250 стран
  async countries() {
    const list = await fetchJson('https://raw.githubusercontent.com/mledoze/countries/master/countries.json');
    return {
      ...empty(),
      countries: list.map((c) => ({
        code: c.cca2,
        name: c.name.common,
        officialName: c.name.official,
        region: c.region,
        subregion: c.subregion || null,
        capital: c.capital?.[0] ?? null,
        area: c.area ?? null,
        languages: Object.values(c.languages ?? {}),
        currencies: Object.keys(c.currencies ?? {}),
        flag: c.flag ?? null,
      })),
    };
  },
};

export async function collect() {
  await mkdir(DATA_DIR, { recursive: true });
  // источники собираются параллельно и независимо: падение одного не ломает остальные
  const results = await Promise.allSettled(
    Object.entries(sources).map(async ([name, load]) => {
      const t = Date.now();
      const data = await load();
      await writeFile(new URL(`${name}.json`, DATA_DIR), JSON.stringify(data));
      const count = Object.values(data).reduce((s, arr) => s + arr.length, 0);
      console.log(`✔ ${name}: ${count} записей за ${Date.now() - t} мс`);
      return count;
    }),
  );
  let total = 0;
  results.forEach((r, i) => {
    const name = Object.keys(sources)[i];
    if (r.status === 'fulfilled') total += r.value;
    else console.error(`✘ ${name}: ${r.reason.message} — ${existsSync(new URL(`${name}.json`, DATA_DIR)) ? 'используется старый кэш' : 'кэша нет'}`);
  });
  console.log(`Собрано записей: ${total}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await collect();
