import test from 'node:test';

test('публичная точка входа собранного пакета загружается без браузера', async () => {
  await import('@deathwarriors/game-core');
});
