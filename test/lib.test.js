// Модульные тесты: данные, поиск/фильтры/сортировка/пагинация, композиция суперграфа
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'graphql';
import { composeServices } from '@apollo/composition';
import { loadData, groupBy, countBy } from '../lib/data.js';
import { paginate, when } from '../lib/list.js';
import { readSchema } from '../lib/subgraph.js';
import { SUBGRAPHS } from '../lib/config.js';

test('собрано не менее 10 000 записей минимум из 3 источников', () => {
  const data = loadData();
  const total = Object.values(data).reduce((sum, list) => sum + list.length, 0);
  assert.ok(total >= 10_000, `записей: ${total}`);

  const sources = new Set([...data.users, ...data.posts, ...data.comments].map((x) => x.source));
  if (data.countries.length) sources.add('MLEDOZE');
  assert.ok(sources.size >= 3, `источников: ${[...sources].join(', ')}`);
});

const items = [
  { id: 1, name: 'Bravo', age: 30, _search: 'bravo' },
  { id: 2, name: 'alpha', age: 20, _search: 'alpha' },
  { id: 3, name: 'Charlie', age: null, _search: 'charlie' },
  { id: 4, name: 'Delta', age: 40, _search: 'delta alpha' },
];

test('поиск без учёта регистра', () => {
  const { items: found, pageInfo } = paginate(items, { search: '  ALPHA ' });
  assert.deepEqual(found.map((x) => x.id), [2, 4]);
  assert.equal(pageInfo.total, 2);
});

test('фильтры добавляются только для переданных значений', () => {
  assert.equal(when(null, () => true).length, 0);
  assert.equal(when('', () => true).length, 0);
  const { items: found } = paginate(items, { filters: when(25, (x) => x.age >= 25) });
  assert.deepEqual(found.map((x) => x.id), [1, 4]);
});

test('сортировка по строке и числу, пустые значения в конце', () => {
  const byName = paginate(items, { sortKey: (x) => x.name }).items.map((x) => x.id);
  assert.deepEqual(byName, [2, 1, 3, 4]);
  const byAgeDesc = paginate(items, { sortKey: (x) => x.age, dir: 'DESC' }).items.map((x) => x.id);
  assert.deepEqual(byAgeDesc, [4, 1, 2, 3]);
});

test('пагинация и pageInfo', () => {
  const { items: page2, pageInfo } = paginate(items, { page: 2, pageSize: 3 });
  assert.deepEqual(page2.map((x) => x.id), [4]);
  assert.deepEqual(pageInfo, { total: 4, page: 2, pageSize: 3, totalPages: 2, hasNext: false, hasPrev: true });
});

test('слишком большой pageSize отклоняется', () => {
  assert.throws(() => paginate(items, { pageSize: 1000 }), /pageSize/);
  assert.throws(() => paginate(items, { pageSize: 0 }), /pageSize/);
});

test('groupBy и countBy', () => {
  const list = [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: null }];
  assert.equal(groupBy(list, 'k').get('a').length, 2);
  assert.deepEqual(countBy(list, 'k'), [
    { key: 'a', count: 2 },
    { key: 'b', count: 1 },
  ]);
});

test('схемы подграфов собираются в суперграф без ошибок', () => {
  const { errors, supergraphSdl } = composeServices(
    SUBGRAPHS.map(({ name, url }) => ({ name, url, typeDefs: parse(readSchema(name)) })),
  );
  assert.equal(errors, undefined, errors?.map((e) => e.message).join('\n'));
  assert.match(supergraphSdl, /type User/);
});
