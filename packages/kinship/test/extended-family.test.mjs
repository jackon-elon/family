import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKinship } from '../src/index.ts';

function chain(kinds, genders, years = []) {
  const people = genders.map((gender, i) => ({id: String(i), gender, ...(years[i] ? {birthDate: `${years[i]}-05-06`} : {})}));
  const relations = kinds.map((kind, i) => kind === 'parent'
    ? {type: 'parent_child', parentId: String(i + 1), childId: String(i)}
    : kind === 'child' ? {type: 'parent_child', parentId: String(i), childId: String(i + 1)}
    : {type: kind, personAId: String(i), personBId: String(i + 1)});
  return { people, relations, perspectiveId: '0', targetId: String(genders.length - 1) };
}

test('four generations distinguish each recorded paternal and maternal branch', () => {
  for (const [a, b, maleTerm, femaleTerm] of [
    ['male', 'male', '曾祖父', '曾祖母'],
    ['male', 'female', '曾外祖父', '曾外祖母'],
    ['female', 'male', '外曾祖父', '外曾祖母'],
    ['female', 'female', '外曾外祖父', '外曾外祖母'],
  ]) for (const [gender, expected] of [['male', maleTerm], ['female', femaleTerm]]) {
    const input = chain(['parent', 'parent', 'parent'], ['female', a, b, gender]);
    assert.equal(resolveKinship(input).term, expected);
    assert.equal(resolveKinship(input).status, 'resolved');
  }
  for (const [a, b, expected] of [['male', 'male', '曾孙'], ['male', 'female', '曾外孙'], ['female', 'male', '外曾孙'], ['female', 'female', '外曾外孙']]) {
    assert.equal(resolveKinship(chain(['child', 'child', 'child'], ['male', a, b, 'male'])).term, expected);
    assert.equal(resolveKinship(chain(['child', 'child', 'child'], ['male', a, b, 'female'])).term, expected + '女');
  }
});

test('cousin children have short exact terms without requiring cousins birth dates', () => {
  for (const [a, b, prefix] of [['male', 'male', '堂'], ['male', 'female', '表'], ['female', 'male', '表'], ['female', 'female', '表']]) {
    for (const [cousin, child, suffix] of [['male', 'male', '侄子'], ['male', 'female', '侄女'], ['female', 'male', '外甥'], ['female', 'female', '外甥女']]) {
      const result = resolveKinship(chain(['parent', 'sibling', 'child', 'child'], ['female', a, b, cousin, child]));
      assert.equal(result.term, prefix + suffix);
      assert.equal(result.status, 'resolved');
      assert.deepEqual(result.missing, []);
    }
  }
});

test('parents cousins use parent age for uncle titles and preserve the maternal branch', () => {
  const kinds = ['parent', 'parent', 'sibling', 'child'];
  const rows = [
    ['male','male','male','male',1958,'堂伯父'],
    ['male','male','male','male',1962,'堂叔叔'],
    ['male','male','male','female',1962,'堂姑姑'],
    ['female','male','male','male',1962,'堂舅舅'],
    ['female','male','male','female',1962,'堂姨妈'],
    ['male','female','male','male',1958,'表伯父'],
    ['male','male','female','male',1962,'表叔叔'],
    ['female','female','male','female',1962,'表姨妈'],
  ];
  for (const [a,b,c,d,year,expected] of rows) {
    assert.equal(resolveKinship(chain(kinds, ['male',a,b,c,d], [1990,1960,1930,1932,year])).term, expected);
  }
  const unknown = resolveKinship(chain(kinds, ['male','male','male','male','male']));
  assert.equal(unknown.term, undefined);
  assert.equal(unknown.category, '堂伯叔');
});

test('new rules never guess unknown gender or override special relationships', () => {
  const missing = resolveKinship(chain(['parent','sibling','child','child'], ['male','male','unknown','male','female']));
  assert.equal(missing.term, undefined);
  assert.ok(missing.missing.some(x => x.includes('性别')));
  const adopted = chain(['parent','parent','parent'], ['male','male','male','male']);
  adopted.relations[0].kind = 'adoptive';
  assert.equal(resolveKinship(adopted).term, undefined);
  const inlaw = chain(['spouse','sibling'], ['male','female','male'], [1990,1991,1988]);
  assert.equal(resolveKinship(inlaw).term, '大舅子');
  const sameDay = chain(['spouse','sibling'], ['male','female','male'], [1990,1991,1991]);
  assert.equal(resolveKinship(sameDay).category, '妻子的兄弟');
});
