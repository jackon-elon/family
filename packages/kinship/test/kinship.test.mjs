import assert from 'node:assert/strict';
import test from 'node:test';
import { getRelationshipPaths, resolveKinship } from '../src/index.ts';

const person = (id, gender, birthYear) => ({ id, gender, ...(birthYear ? { birthYear } : {}) });
const parent = (parentId, childId, kind) => ({ type: 'parent_child', parentId, childId, ...(kind ? { kind } : {}) });
const sibling = (personAId, personBId, olderPersonId, extra = {}) => ({
  type: 'sibling', personAId, personBId, ...(olderPersonId ? { olderPersonId } : {}), ...extra,
});
const spouse = (personAId, personBId, status) => ({ type: 'spouse', personAId, personBId, ...(status ? { status } : {}) });

test('父亲的哥哥为伯父，别称伯伯；切换视角重新计算', () => {
  const people = [person('me', 'male'), person('dad', 'male'), person('uncle', 'male')];
  const relations = [parent('dad', 'me'), sibling('dad', 'uncle', 'uncle')];
  const fromMe = resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'uncle' });
  assert.equal(fromMe.status, 'resolved');
  assert.equal(fromMe.term, '伯父');
  assert.deepEqual(fromMe.alternatives, ['伯伯']);
  assert.equal(fromMe.path.display, '我 → 爸爸 → 爸爸的哥哥');

  const fromUncle = resolveKinship({ people, relations, perspectiveId: 'uncle', targetId: 'me' });
  assert.equal(fromUncle.status, 'resolved');
  assert.equal(fromUncle.term, '侄子');
  assert.equal(fromUncle.path.display, '我 → 弟弟 → 弟弟的儿子');
});

test('父亲的弟弟为叔叔；没有长幼时给路径和缺项', () => {
  const people = [person('me', 'female'), person('dad', 'male'), person('uncle', 'male')];
  const known = resolveKinship({ people, relations: [parent('dad', 'me'), sibling('dad', 'uncle', 'dad')], perspectiveId: 'me', targetId: 'uncle' });
  assert.equal(known.term, '叔叔');
  const unknown = resolveKinship({ people, relations: [parent('dad', 'me'), sibling('dad', 'uncle')], perspectiveId: 'me', targetId: 'uncle' });
  assert.equal(unknown.status, 'pending');
  assert.equal(unknown.term, undefined);
  assert.match(unknown.path.display, /爸爸的兄弟/);
  assert.ok(unknown.missing.some((item) => item.includes('长幼')));
});

test('同性别兄弟的排行可判断伯叔，冲突资料须先纠正', () => {
  const people = [person('me', 'female'), person('dad', 'male', 1975), person('uncle', 'male', 1970)];
  const input = { people, perspectiveId: 'me', targetId: 'uncle' };
  const ranked = resolveKinship({ ...input, relations: [parent('dad', 'me'), sibling('dad', 'uncle', undefined, { rankOfA: 2, rankOfB: 1 })] });
  assert.equal(ranked.term, '伯父');
  const conflict = resolveKinship({ ...input, relations: [parent('dad', 'me'), sibling('dad', 'uncle', 'dad', { rankOfA: 2, rankOfB: 1 })] });
  assert.equal(conflict.status, 'invalid');
  assert.match(conflict.reason, /冲突/);
});

test('母亲的姐姐为姨妈/姨母；有排行才使用大姨/二姨', () => {
  const people = [person('me', 'male'), person('mom', 'female'), person('aunt', 'female')];
  const input = { people, perspectiveId: 'me', targetId: 'aunt' };
  const generic = resolveKinship({ ...input, relations: [parent('mom', 'me'), sibling('mom', 'aunt', 'aunt')] });
  assert.equal(generic.status, 'resolved');
  assert.equal(generic.term, '姨妈');
  assert.deepEqual(generic.alternatives, ['姨母']);
  assert.equal(generic.path.display, '我 → 妈妈 → 妈妈的姐姐');
  const oldest = resolveKinship({ ...input, relations: [parent('mom', 'me'), sibling('mom', 'aunt', 'aunt', { rankOfB: 1 })] });
  assert.equal(oldest.term, '大姨');
  const second = resolveKinship({ ...input, relations: [parent('mom', 'me'), sibling('mom', 'aunt', 'aunt', { rankOfB: 2 })] });
  assert.equal(second.term, '二姨');
});

test('祖父母、外祖父母与孙辈按视角计算', () => {
  const people = [person('me', 'female'), person('dad', 'male'), person('grandma', 'female'), person('mom', 'female'), person('grandpa', 'male')];
  const relations = [parent('dad', 'me'), parent('grandma', 'dad'), parent('mom', 'me'), parent('grandpa', 'mom')];
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'grandma' }).term, '奶奶');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'grandpa' }).term, '外公');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'grandma', targetId: 'me' }).term, '孙女');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'grandpa', targetId: 'me' }).term, '外孙女');
});

test('共享父母可推断兄弟姐妹，出生年份不同才推断长幼', () => {
  const people = [person('parent', 'female'), person('older', 'female', 1990), person('younger', 'male', 1995)];
  const relations = [parent('parent', 'older'), parent('parent', 'younger')];
  const result = resolveKinship({ people, relations, perspectiveId: 'younger', targetId: 'older' });
  assert.equal(result.term, '姐姐');
  assert.equal(result.path.steps[0].inferred, true);
  const noYears = resolveKinship({ people: people.map(({ birthYear, ...rest }) => rest), relations, perspectiveId: 'younger', targetId: 'older' });
  assert.equal(noYears.status, 'pending');
  assert.ok(noYears.missing.some((item) => item.includes('长幼')));
});

test('只录入共同祖父母时也可在出生年份足够时算出伯父', () => {
  const people = [person('me', 'female'), person('dad', 'male', 1970), person('uncle', 'male', 1966), person('grandma', 'female')];
  const relations = [parent('dad', 'me'), parent('grandma', 'dad'), parent('grandma', 'uncle')];
  const result = resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'uncle' });
  assert.equal(result.term, '伯父');
  assert.equal(result.path.steps[1].inferred, true);
});

test('关键人物性别未知时保留路径和缺项', () => {
  const people = [person('me', 'female'), person('parent', 'unknown'), person('relative', 'female')];
  const relations = [parent('parent', 'me'), sibling('parent', 'relative', 'relative')];
  const result = resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'relative' });
  assert.equal(result.status, 'pending');
  assert.equal(result.term, undefined);
  assert.equal(result.path.display, '我 → 父母 → 父母的姐姐');
  assert.ok(result.missing.some((item) => item.includes('父母') && item.includes('性别')));
});

test('伯叔家的孩子为堂亲，母系孩子为表亲；长幼未知则待补充', () => {
  const people = [person('me', 'female', 2000), person('dad', 'male'), person('uncle', 'male'), person('olderCousin', 'male', 1998), person('mom', 'female'), person('aunt', 'female'), person('youngerCousin', 'female', 2005)];
  const relations = [parent('dad', 'me'), sibling('dad', 'uncle', 'uncle'), parent('uncle', 'olderCousin'), parent('mom', 'me'), sibling('mom', 'aunt', 'aunt'), parent('aunt', 'youngerCousin')];
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'olderCousin' }).term, '堂哥');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'youngerCousin' }).term, '表妹');
  const withoutMyYear = people.map((p) => p.id === 'me' ? { id: p.id, gender: p.gender } : p);
  const pending = resolveKinship({ people: withoutMyYear, relations, perspectiveId: 'me', targetId: 'olderCousin' });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.term, undefined);
  assert.equal(pending.category, '堂兄弟');
  assert.match(pending.path.display, /爸爸的哥哥的儿子/);
  assert.ok(pending.missing.some((item) => item.includes('双方的长幼')));
  const maternal = resolveKinship({ people: withoutMyYear, relations, perspectiveId: 'me', targetId: 'youngerCousin' });
  assert.equal(maternal.status, 'pending');
  assert.equal(maternal.term, undefined);
  assert.equal(maternal.category, '表姐妹');
  const unknownGender = resolveKinship({ people: withoutMyYear.map((p) => p.id === 'olderCousin' ? {...p, gender: 'unknown'} : p), relations, perspectiveId: 'me', targetId: 'olderCousin' });
  assert.equal(unknownGender.category, undefined);
});

test('收养、继亲与前配偶展示路径但不套用普通规则', () => {
  const people = [person('me', 'female'), person('stepdad', 'male'), person('ex', 'male')];
  const step = resolveKinship({ people, relations: [parent('stepdad', 'me', 'step')], perspectiveId: 'me', targetId: 'stepdad' });
  assert.equal(step.status, 'pending');
  assert.equal(step.term, undefined);
  assert.match(step.path.display, /继父/);
  const former = resolveKinship({ people, relations: [spouse('me', 'ex', 'former')], perspectiveId: 'me', targetId: 'ex' });
  assert.equal(former.status, 'pending');
  assert.match(former.path.display, /前夫/);
});

test('没有把父亲的配偶自动认作母亲', () => {
  const people = [person('me', 'female'), person('dad', 'male'), person('partner', 'female')];
  const result = resolveKinship({ people, relations: [parent('dad', 'me'), spouse('dad', 'partner')], perspectiveId: 'me', targetId: 'partner' });
  assert.equal(result.status, 'pending');
  assert.equal(result.term, undefined);
  assert.equal(result.path.display, '我 → 爸爸 → 爸爸的妻子');
});

test('循环亲子关系无效；不相连人物不伪造称呼', () => {
  const people = [person('a', 'male'), person('b', 'female'), person('c', 'female')];
  const invalid = resolveKinship({ people, relations: [parent('a', 'b'), parent('b', 'a')], perspectiveId: 'a', targetId: 'b' });
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.reason, /循环/);
  const unrelated = resolveKinship({ people, relations: [], perspectiveId: 'a', targetId: 'c' });
  assert.equal(unrelated.status, 'unrelated');
  assert.equal(unrelated.term, undefined);
  assert.deepEqual(unrelated.paths, []);
});

test('多条最短路径给出冲突叫法时标为待核对', () => {
  const people = [person('me', 'male'), person('dad', 'male'), person('mom', 'female'), person('uncle', 'male')];
  const relations = [parent('dad', 'me'), parent('mom', 'me'), sibling('dad', 'uncle', 'uncle'), sibling('mom', 'uncle', 'uncle')];
  const result = resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'uncle' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.term, undefined);
  assert.deepEqual(new Set(result.alternatives), new Set(['伯父', '舅舅']));
  assert.equal(result.paths.length, 2);
  assert.equal(getRelationshipPaths({ people, relations, perspectiveId: 'me', targetId: 'uncle' }).length, 2);
});

test('自定义叫法优先个人设置且保留自动结果和关系路径', () => {
  const people = [person('me', 'female'), person('dad', 'male')];
  const result = resolveKinship({
    people, relations: [parent('dad', 'me')], perspectiveId: 'me', targetId: 'dad',
    overrides: [
      { perspectiveId: 'me', targetId: 'dad', term: '父亲', scope: 'circle' },
      { perspectiveId: 'me', targetId: 'dad', term: '老爸', scope: 'personal' },
    ],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.term, '老爸');
  assert.equal(result.calculatedTerm, '爸爸');
  assert.equal(result.source, 'override');
  assert.equal(result.path.display, '我 → 爸爸');
});

test('本人及常见姻亲关系', () => {
  const people = [person('me', 'female'), person('husband', 'male'), person('fatherInLaw', 'male'), person('daughter', 'female'), person('sonInLaw', 'male')];
  const relations = [spouse('me', 'husband'), parent('fatherInLaw', 'husband'), parent('me', 'daughter'), spouse('daughter', 'sonInLaw')];
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'me' }).status, 'self');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'husband' }).term, '丈夫');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'fatherInLaw' }).term, '公公');
  assert.equal(resolveKinship({ people, relations, perspectiveId: 'me', targetId: 'sonInLaw' }).term, '女婿');
});
