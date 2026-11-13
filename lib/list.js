import { GraphQLError } from 'graphql';
import { LIMITS } from './config.js';

const collator = new Intl.Collator('en', { sensitivity: 'base' });

function compare(x, y) {
  return typeof x === 'string' ? collator.compare(x, y) : x - y;
}

// Общая логика для всех списков: поиск -> фильтры -> сортировка -> пагинация.
// search ищет по заранее подготовленному полю item._search (строка в нижнем регистре).
// filters — массив функций-предикатов, sortKey — функция item -> значение.
export function paginate(list, { search, filters = [], sortKey, dir = 'ASC', page = 1, pageSize = 20 }) {
  if (pageSize < 1 || pageSize > LIMITS.maxPageSize) {
    throw new GraphQLError(`pageSize должен быть от 1 до ${LIMITS.maxPageSize}`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  page = Math.max(1, page);

  let result = list;
  const q = search?.trim().toLowerCase();
  if (q) result = result.filter((item) => item._search.includes(q));
  for (const f of filters) result = result.filter(f);

  if (sortKey) {
    const sign = dir === 'DESC' ? -1 : 1;
    result = [...result].sort((a, b) => {
      const x = sortKey(a);
      const y = sortKey(b);
      if (x == null) return y == null ? 0 : 1; // пустые значения всегда в конце
      if (y == null) return -1;
      return compare(x, y) * sign;
    });
  }

  const total = result.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    items: result.slice((page - 1) * pageSize, page * pageSize),
    pageInfo: { total, page, pageSize, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

// Добавляет фильтр, только если значение реально передано
export function when(value, predicate) {
  return value == null || value === '' ? [] : [predicate];
}
