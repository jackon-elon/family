const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, filename);
};

const {birthDateForBirthday} = require('../utils/birth-date.ts');
const {gregorianForLunar, lunarForGregorian} = require('../utils/lunar-calendar.ts');
const {relationshipFor} = require('../utils/relationship.ts');
const solar = (year, month, day) => ({calendar: 'solar', year, month, day});
const lunar = (year, month, day, leapMonth = false) => ({calendar: 'lunar', year, month, day, leapMonth});

test('出生日期转换校验完整阳历，不使用无年份生日或非法日期', () => {
  assert.equal(birthDateForBirthday(solar(2000, 2, 29)), '2000-02-29');
  for (const birthday of [undefined, solar(undefined, 1, 1), solar(2001, 2, 29), solar(2000, 13, 1), solar(2000, 1, 0), {...solar(2000, 1, 1), leapMonth: true}]) {
    assert.equal(birthDateForBirthday(birthday), undefined);
  }
});

test('农历按出生年份转换，支持跨公历年和真实闰月', () => {
  assert.equal(birthDateForBirthday(lunar(2000, 1, 1)), '2000-02-05');
  assert.equal(birthDateForBirthday(lunar(1999, 12, 1)), '2000-01-07');
  assert.equal(birthDateForBirthday(lunar(2020, 4, 1)), '2020-04-23');
  assert.equal(birthDateForBirthday(lunar(2020, 4, 1, true)), '2020-05-23');
});

test('农历出生日期不套用生日提醒的小月、闰月回退规则', () => {
  for (const birthday of [lunar(undefined, 1, 1), lunar(2000, 4, 30), lunar(2000, 4, 1, true), lunar(2020, 4, 30, true), lunar(1900, 1, 1), lunar(2100, 12, 2)]) {
    assert.equal(birthDateForBirthday(birthday), undefined);
  }
  assert.equal(birthDateForBirthday(lunar(2100, 12, 1)), '2100-12-31');
});

test('官方历表覆盖内的逐月日期可以完整往返', () => {
  for (let year = 1901; year <= 2100; year++) {
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, 15, new Date(Date.UTC(year, month, 0)).getUTCDate()]) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const converted = lunarForGregorian(date);
        assert.ok(converted, date);
        assert.equal(gregorianForLunar(converted), date, date);
      }
    }
  }
});

test('称呼适配器比较农历和阳历的实际出生日，跨年不看农历年份大小', () => {
  const people = [
    {id: 'me', name: '我', gender: 'female', birthday: solar(2000, 1, 1)},
    {id: 'sibling', name: '家人', gender: 'male', birthday: lunar(1999, 12, 1)}
  ];
  const relations = [{id: 's', from: 'me', to: 'sibling', type: 'sibling'}];
  assert.equal(relationshipFor(people, relations, 'me', 'sibling').label, '弟弟');
  assert.equal(relationshipFor(people.map(p => p.id === 'me' ? {...p, birthday: solar(2000, 1, 8)} : p), relations, 'me', 'sibling').label, '哥哥');
});

test('缺出生年、同一出生日期和不可转换生日不自动判断长幼', () => {
  const me = {id: 'me', name: '我', gender: 'female', birthday: solar(2000, 2, 5)};
  const relations = [{id: 's', from: 'me', to: 'sibling', type: 'sibling'}];
  for (const birthday of [lunar(2000, 1, 1), solar(undefined, 1, 1), lunar(2000, 4, 30)]) {
    const result = relationshipFor([me, {id: 'sibling', name: '家人', gender: 'male', birthday}], relations, 'me', 'sibling');
    assert.equal(result.status, 'pending');
    assert.ok(!['哥哥', '弟弟'].includes(result.label));
  }
});

test('无需排行或手动长幼标记也能自动计算伯叔，姨妈保持基础称呼', () => {
  const people = [
    {id: 'me', name: '我', gender: 'female', birthday: solar(2000, 1, 1)},
    {id: 'dad', name: '爸爸', gender: 'male', birthday: solar(1970, 2, 5)},
    {id: 'uncle', name: '叔伯', gender: 'male', birthday: solar(1970, 1, 1)},
    {id: 'mom', name: '妈妈', gender: 'female', birthday: solar(1972, 1, 1)},
    {id: 'aunt', name: '姨妈', gender: 'female', birthday: solar(1971, 1, 1)}
  ];
  const relations = [{id: 'a', from: 'dad', to: 'me', type: 'parent'}, {id: 'b', from: 'dad', to: 'uncle', type: 'sibling'}, {id: 'c', from: 'mom', to: 'me', type: 'parent'}, {id: 'd', from: 'mom', to: 'aunt', type: 'sibling'}];
  assert.equal(relationshipFor(people, relations, 'me', 'uncle').label, '伯父');
  assert.equal(relationshipFor(people.map(p => p.id === 'uncle' ? {...p, birthday: solar(1970, 3, 1)} : p), relations, 'me', 'uncle').label, '叔叔');
  assert.equal(relationshipFor(people, relations, 'me', 'aunt').label, '姨妈');
});

test('生日与旧长幼冲突时向界面提供具体核对原因', () => {
  const people = [{id: 'me', name: '我', gender: 'female', birthday: solar(2000, 1, 1)}, {id: 'sibling', name: '家人', gender: 'male', birthday: solar(1999, 1, 1)}];
  const result = relationshipFor(people, [{id: 's', from: 'me', to: 'sibling', type: 'sibling', olderId: 'me'}], 'me', 'sibling');
  assert.equal(result.label, '关系待核对');
  assert.match(result.missing, /出生日期冲突/);
});
