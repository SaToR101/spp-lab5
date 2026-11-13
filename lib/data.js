import { readFileSync, readdirSync } from 'node:fs';

const DATA_DIR = new URL('../data/', import.meta.url);

// Склеивает все data/*.json в один набор { users, countries, posts, comments }
export function loadData() {
  const all = { users: [], countries: [], posts: [], comments: [] };
  for (const file of readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'))) {
    const part = JSON.parse(readFileSync(new URL(file, DATA_DIR), 'utf8'));
    for (const key of Object.keys(all)) all[key].push(...(part[key] ?? []));
  }
  return all;
}

// Группировка в Map: ключ -> массив (индекс для быстрых вложенных запросов)
export function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = item[key];
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

// Подсчёт по полю для статистики: [{ key, count }] по убыванию
export function countBy(list, key) {
  return [...groupBy(list, key)].map(([k, items]) => ({ key: String(k), count: items.length })).sort((a, b) => b.count - a.count);
}
