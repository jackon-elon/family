import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveKinship } from '../src/index.ts';

const person = (id, gender, birthDate) => ({id, gender, birthDate});
const sibling = (a, b, olderPersonId) => ({type: 'sibling', personAId: a, personBId: b, olderPersonId});
const parent = (parentId, childId) => ({type: 'parent_child', parentId, childId});
const resolve = (people, relations, targetId, perspectiveId = 'me') => resolveKinship({people, relations, perspectiveId, targetId});

test('完整出生日期按年、月、日比较同辈长幼', () => {
  for (const [birthday, expected] of [['1999-12-31', '哥哥'], ['2000-01-30', '哥哥'], ['2000-02-09', '哥哥'], ['2000-02-11', '弟弟'], ['2000-03-01', '弟弟'], ['2001-01-01', '弟弟']]) {
    const result = resolve([person('me', 'female', '2000-02-10'), person('sibling', 'male', birthday)], [sibling('me', 'sibling')], 'sibling');
    assert.equal(result.status, 'resolved');
    assert.equal(result.term, expected);
  }
});

test('缺失出生日期或同日出生不猜长幼，旧的明确长幼仍可使用', () => {
  for (const date of [undefined, '2000-02-10']) {
    const people = [person('me', 'male', '2000-02-10'), person('sibling', 'female', date)];
    assert.equal(resolve(people, [sibling('me', 'sibling')], 'sibling').status, 'pending');
    assert.equal(resolve(people, [sibling('me', 'sibling', 'sibling')], 'sibling').term, '姐姐');
  }
});

test('父辈同年出生时自动得到伯父或叔叔，无需排行', () => {
  const relations = [parent('dad', 'me'), sibling('dad', 'uncle')];
  const people = [person('me', 'female', '2000-08-01'), person('dad', 'male', '1970-10-01'), person('uncle', 'male', '1970-02-01')];
  assert.equal(resolve(people, relations, 'uncle').term, '伯父');
  assert.equal(resolve(people.map(p => p.id === 'uncle' ? {...p, birthDate: '1970-12-01'} : p), relations, 'uncle').term, '叔叔');
});

test('共享父母也按完整出生日期推断长幼，姨妈不凭现有人数推断大姨', () => {
  const people = [person('me', 'female', '2000-08-01'), person('mom', 'female', '1970-10-01'), person('aunt', 'female', '1970-02-01'), person('grandma', 'female', '1940-01-01')];
  const relations = [parent('mom', 'me'), parent('grandma', 'mom'), parent('grandma', 'aunt')];
  const result = resolve(people, relations, 'aunt');
  assert.equal(result.status, 'resolved');
  assert.equal(result.term, '姨妈');
  assert.match(result.path.display, /妈妈的姐姐/);
});

test('同年堂表亲可按完整出生日期推断长幼', () => {
  const people = [person('me', 'female', '2000-08-01'), person('dad', 'male', '1970-10-01'), person('uncle', 'male', '1968-02-01'), person('cousin', 'female', '2000-08-02')];
  const result = resolve(people, [parent('dad', 'me'), sibling('dad', 'uncle'), parent('uncle', 'cousin')], 'cousin');
  assert.equal(result.status, 'resolved');
  assert.equal(result.term, '堂妹');
});

test('生日与已有明确长幼冲突时提示核对，不静默给错误称呼', () => {
  const people = [person('me', 'male', '2000-02-10'), person('sibling', 'female', '2000-02-09')];
  const result = resolve(people, [sibling('me', 'sibling', 'me')], 'sibling');
  assert.equal(result.status, 'invalid');
  assert.match(result.reason, /出生日期冲突/);
});

test('引擎拒绝不存在的日期、非标准日期及日期年份冲突', () => {
  for (const birthDate of ['2001-02-29', '2000-02-30', '2000-2-1', '2000-13-01', '2000-01-00']) {
    assert.equal(resolve([person('me', 'male', '2000-02-10'), person('sibling', 'female', birthDate)], [sibling('me', 'sibling')], 'sibling').status, 'invalid');
  }
  assert.equal(resolve([{...person('me', 'male', '2000-02-10'), birthYear: 1999}, person('sibling', 'female')], [sibling('me', 'sibling')], 'sibling').status, 'invalid');
});
