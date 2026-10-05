import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKinship, resolveKinships } from '../src/index.ts';

test('batch results exactly match individual paths, overrides and ambiguous relationships', () => {
  const people = Array.from({length: 100}, (_, i) => ({ id: String(i), gender: i % 2 ? 'female' : 'male', birthDate: `${1940 + Math.floor(i / 10) * 5}-01-01` }));
  const relations = Array.from({length: 89}, (_, i) => ({ type:'parent_child', parentId:String(Math.floor(i / 3)), childId:String(i + 1) }));
  relations.push({type:'spouse', personAId:'10', personBId:'11'});
  relations.push({type:'sibling', personAId:'10', personBId:'11'});
  for (const perspectiveId of ['0','10','50','99']) {
    const input = { people, relations, perspectiveId, overrides:[{perspectiveId,targetId:'1',term:'家里叫法',scope:'personal'}] };
    const batch = resolveKinships(input);
    assert.equal(Object.keys(batch).length, 100);
    for (const person of people) assert.deepEqual(batch[person.id], resolveKinship({...input,targetId:person.id}));
  }
});

test('batch computation is scoped to one snapshot and retains invalid-data checks', () => {
  const people = [{id:'a',gender:'male'},{id:'b',gender:'female'}];
  const original = {people,relations:[{type:'parent_child',parentId:'a',childId:'b'}],perspectiveId:'b'};
  assert.equal(resolveKinships(original).a.term,'爸爸');
  assert.equal(resolveKinships({...original,relations:[]}).a.status,'unrelated');
  const invalid = {...original,relations:[...original.relations,{type:'parent_child',parentId:'b',childId:'a'}]};
  for (const result of Object.values(resolveKinships(invalid))) assert.equal(result.status,'invalid');
  const absent = {...original,perspectiveId:'missing'};
  assert.deepEqual(resolveKinships(absent).a, resolveKinship({...absent,targetId:'a'}));
});
