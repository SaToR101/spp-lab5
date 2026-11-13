// Запуск распределённой системы: 3 отдельных процесса (users, content, gateway).
// Супервизор перезапускает упавший сервис через 1 секунду (отказоустойчивость).
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { collect } from './collector/collect.js';

if (!existsSync(new URL('./data/randomuser.json', import.meta.url))) {
  console.log('Данных нет — запускаю сбор...');
  await collect();
}

const children = new Map();
let stopping = false;

function run(name) {
  const child = fork(new URL(`./services/${name}.js`, import.meta.url));
  children.set(name, child);
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`[supervisor] ${name} завершился (код ${code}), перезапуск через 1 с`);
    setTimeout(() => run(name), 1000);
  });
}

['users', 'content', 'gateway'].forEach(run);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children.values()) child.kill();
    process.exit(0);
  });
}
