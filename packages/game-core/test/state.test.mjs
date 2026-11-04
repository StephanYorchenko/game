import assert from 'node:assert/strict';
import test from 'node:test';
import { getCell, getOccupant, loadWorld, parseWorld, ScenarioValidationError, serializeWorld } from '@deathwarriors/game-core';

const cross = () => [[0,0,0,0,0], [0,0,1,0,0], [0,1,0,1,0], [0,0,1,0,0], [0,0,0,0,0]];
const stats = () => ({ hp: 10, maxHP: 10, strength: 2, agility: 1, damage: 3, movement: 2, resistance: 0 });
function scenario() {
  const cells = Array.from({ length: 9 }, () => ({ surface: 'floor', area: 'inside', structure: null }));
  cells[0].structure = { id: 'wall', kind: 'wall' };
  cells[1].structure = { id: 'door', kind: 'door', state: 'closed', reinforcement: null, interactionMask: cross() };
  cells[2].structure = { id: 'window', kind: 'window', state: 'open', reinforcement: { hp: 6, maxHP: 8, resistance: 2 }, interactionMask: cross() };
  cells[3].structure = { id: 'chest', kind: 'obstacle', blocksMovement: true, blocksAttack: false };
  cells[8] = { surface: 'ground', area: 'outside', structure: null };
  return {
    version: 1, map: { width: 3, height: 3, cells },
    units: [
      { id: 'guard', kind: 'unit', definitionId: 'archer', side: 'defender', alive: true, position: { x: 1, y: 1 }, stats: stats(), attackMask: cross(), keywords: ['guard'] },
      { id: 'wolf', kind: 'unit', definitionId: 'wolf', side: 'enemy', alive: true, position: { x: 2, y: 2 }, stats: stats(), attackMask: cross(), keywords: [] },
    ],
    traps: [{ id: 'snare', kind: 'trap', definitionId: 'snare', position: { x: 1, y: 2 } }],
  };
}

test('заданная карта загружается с раздельными слоями и устойчивыми ID', () => {
  const input = scenario();
  const world = loadWorld(input);
  assert.deepEqual(world, input);
  assert.equal(getCell(world.map, { x: 1, y: 0 }).structure.id, 'door');
  assert.equal(getOccupant(world, { x: 1, y: 1 }).id, 'guard');
  assert.equal(getOccupant(world, { x: 1, y: 2 }).id, 'snare');
  assert.equal(getOccupant(world, { x: 0, y: 2 }), undefined);
  assert.equal(getCell(world.map, { x: 3, y: 0 }), undefined);
  assert.equal(getCell(world.map, { x: -1, y: 0 }), undefined);
  assert.equal(getCell(world.map, { x: 0.5, y: 0 }), undefined);
});

test('изменения состояния не меняют входные данные и не разделяют вложенные массивы', () => {
  const input = scenario();
  const world = loadWorld(input);
  world.units[0].stats.hp = 5;
  world.units[0].attackMask[0][0] = 1;
  world.units[0].keywords.push('new');
  world.units[0].position.x = 0;
  world.map.cells[2].structure.reinforcement.hp = 1;
  world.map.cells[1].structure.interactionMask[0][0] = 1;
  world.traps[0].position.x = 0;
  assert.deepEqual(input, scenario());
});

test('JSON-снимок сохраняет все данные и восстанавливается без объектов UI', () => {
  const world = loadWorld(scenario());
  assert.deepEqual(parseWorld(serializeWorld(world)), world);
  assert.throws(() => parseWorld('{'), ScenarioValidationError);
});

test('открытый или разрушенный проём сохраняется, когда его клетку занимает юнит', () => {
  for (const state of ['open', 'destroyed']) {
    const input = scenario();
    input.map.cells[2].structure.state = state;
    input.units[1].position = { x: 2, y: 0 };
    const world = loadWorld(input);
    assert.equal(getCell(world.map, { x: 2, y: 0 }).structure.id, 'window');
    assert.equal(getOccupant(world, { x: 2, y: 0 }).id, 'wolf');
  }
});

test('гибель хранится явно: нулевой HP внутри атомарного эффекта ещё не смерть', () => {
  const input = scenario();
  input.units[0].stats.hp = 0;
  assert.equal(loadWorld(input).units[0].alive, true);
  input.units[0].alive = false;
  input.units[0].position = null;
  input.traps.push({ id: 'second-trap', kind: 'trap', definitionId: 'snare', position: { x: 1, y: 1 } });
  const world = loadWorld(input);
  assert.equal(getOccupant(world, { x: 1, y: 1 }).id, 'second-trap');
  assert.deepEqual(parseWorld(serializeWorld(world)), world);
});

const invalid = [
  ['версия', s => { s.version = 2; }, '$.version'],
  ['размер поля', s => { s.map.width = 0; }, '$.map.width'],
  ['число клеток', s => { s.map.cells.pop(); }, '$.map.cells'],
  ['дыра в массиве', s => { delete s.map.cells[4]; }, '$.map.cells[4]'],
  ['повторный ID структуры и юнита', s => { s.units[0].id = 'door'; }, '$.units[0].id'],
  ['повторный ID юнита и ловушки', s => { s.traps[0].id = 'guard'; }, '$.traps[0].id'],
  ['выход за карту', s => { s.units[0].position.x = 3; }, '$.units[0].position'],
  ['дробная координата', s => { s.units[0].position.x = 0.5; }, '$.units[0].position.x'],
  ['два юнита в клетке', s => { s.units[1].position = { x: 1, y: 1 }; }, '$.units[1].position'],
  ['юнит и ловушка в клетке', s => { s.traps[0].position = { x: 1, y: 1 }; }, '$.traps[0].position'],
  ['юнит в стене', s => { s.units[0].position = { x: 0, y: 0 }; }, '$.units[0].position'],
  ['юнит в закрытом проёме', s => { s.units[0].position = { x: 1, y: 0 }; }, '$.units[0].position'],
  ['защитник снаружи', s => { s.units[0].position = { x: 2, y: 2 }; s.units.pop(); }, '$.units[0].position'],
  ['погибший занимает клетку', s => { s.units[0].alive = false; s.units[0].stats.hp = 0; }, '$.units[0]'],
  ['отрицательная характеристика', s => { s.units[0].stats.resistance = -1; }, '$.units[0].stats.resistance'],
  ['HP выше максимума', s => { s.units[0].stats.hp = 11; }, '$.units[0].stats.hp'],
  ['NaN', s => { s.units[0].stats.damage = NaN; }, '$.units[0].stats.damage'],
  ['неизвестная характеристика', s => { s.units[0].stats.damgae = 3; }, '$.units[0].stats.damgae'],
  ['неверный размер матрицы', s => { s.units[0].attackMask.pop(); }, '$.units[0].attackMask'],
  ['небинарная матрица', s => { s.map.cells[1].structure.interactionMask[0][0] = 2; }, '$.map.cells[1].structure.interactionMask[0][0]'],
];
for (const [name, mutate, path] of invalid) {
  test(`некорректный сценарий отклонён с адресом ошибки: ${name}`, () => {
    const input = scenario();
    mutate(input);
    assert.throws(() => loadWorld(input), error => error instanceof ScenarioValidationError && error.path === path);
  });
}

test('не-JSON объекты и пустые ID не принимаются', () => {
  assert.throws(() => loadWorld(new Map()), ScenarioValidationError);
  const input = scenario();
  input.units[0].id = '   ';
  assert.throws(() => loadWorld(input), /непустая строка/);
});
