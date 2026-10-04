const test = require('node:test');
const assert = require('node:assert/strict');
const {ApiService} = require('../dist/service.js');
const {MemoryRepository} = require('../dist/memory-repository.js');

const validBirthday = {calendar: 'lunar', year: 2025, month: 6, day: 1, leapMonth: true};
const impossibleBirthdays = [
  {calendar: 'lunar', year: 2025, month: 2, day: 30},
  {calendar: 'lunar', year: 2026, month: 6, day: 1, leapMonth: true},
];

function fixture() {
  const api = new ApiService(new MemoryRepository(), () => Date.UTC(2026, 9, 4));
  const call = (action, payload) => api.invoke({action, payload}, 'owner');
  const ok = async (action, payload) => {
    const result = await call(action, payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  return {call, ok};
}

test('account profiles reject impossible dated lunar birthdays without changing a saved birthday', async () => {
  const f = fixture();
  await f.ok('account.profile.update', {patch: {name: '测试家人', country: '中国', city: '杭州', birthday: validBirthday}});
  for (const birthday of impossibleBirthdays) {
    const response = await f.call('account.profile.update', {patch: {birthday}});
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.ok('account.profile.get')).profile.birthday, validBirthday);
  }
});

test('administrator create/update paths reject nonexistent lunar dates and retain prior person data', async () => {
  const f = fixture();
  const circle = (await f.ok('circle.create', {name: '生日核对', type: 'family', mode: 'shared'})).circle;
  const profile = {circleId: circle.id, name: '家人', country: '中国', city: '杭州', deferRelation: true};
  for (const birthday of impossibleBirthdays) {
    const response = await f.call('person.create', {...profile, birthday});
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, 'INVALID_INPUT');
  }
  assert.equal((await f.ok('person.list', {circleId: circle.id})).persons.length, 0);
  const person = (await f.ok('person.create', {...profile, birthday: validBirthday})).person;
  for (const birthday of impossibleBirthdays) {
    const response = await f.call('person.update', {circleId: circle.id, personId: person.id, patch: {birthday}});
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.ok('person.list', {circleId: circle.id})).persons[0].birthday, validBirthday);
  }
});

test('yearless annual lunar birthdays and partially covered boundary years remain recordable', async () => {
  const f = fixture();
  for (const birthday of [
    {calendar: 'lunar', month: 2, day: 30},
    {calendar: 'lunar', month: 6, day: 1, leapMonth: true},
    {calendar: 'lunar', year: 1900, month: 1, day: 1},
    {calendar: 'lunar', year: 2100, month: 12, day: 30},
    validBirthday,
  ]) {
    const result = await f.ok('account.profile.update', {patch: {birthday}});
    assert.deepEqual(result.profile.birthday, birthday);
  }
});
