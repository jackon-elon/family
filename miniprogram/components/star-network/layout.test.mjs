import assert from 'node:assert/strict';
import test from 'node:test';
import {buildStarLayout} from './layout.ts';

const demoPeople = [
  {id: 'me', name: '陈小满'}, {id: 'dad', name: '陈志远'},
  {id: 'mom', name: '林慧'}, {id: 'uncle', name: '陈志国'},
  {id: 'aunt', name: '林芳'}, {id: 'grandma', name: '周桂兰'},
  {id: 'cousin', name: '陈雨晴'}
];
const demoRelations = [
  {id: 'r1', from: 'dad', to: 'me', type: 'parent'},
  {id: 'r2', from: 'mom', to: 'me', type: 'parent'},
  {id: 'r3', from: 'dad', to: 'mom', type: 'spouse'},
  {id: 'r4', from: 'grandma', to: 'dad', type: 'parent'},
  {id: 'r5', from: 'uncle', to: 'dad', type: 'sibling'},
  {id: 'r6', from: 'aunt', to: 'mom', type: 'sibling'},
  {id: 'r7', from: 'uncle', to: 'cousin', type: 'parent'}
];
const byId = graph => new Map(graph.nodes.map(node => [node.id, node]));

test('father and his siblings share a generation; self and cousins share another', () => {
  const graph = buildStarLayout(demoPeople, demoRelations, 'me', 'me', {uncle: '伯父', cousin: '堂姐妹'});
  const n = byId(graph);
  assert.equal(n.get('grandma').generation, -2);
  for (const id of ['uncle', 'dad', 'mom', 'aunt']) {
    assert.equal(n.get(id).generation, -1, id);
    assert.equal(n.get(id).y, n.get('dad').y, id);
  }
  assert.equal(n.get('cousin').generation, 0);
  assert.equal(n.get('cousin').y, n.get('me').y);
  assert.ok(n.get('grandma').y < n.get('dad').y);
  assert.ok(n.get('dad').y < n.get('me').y);
  assert.equal(n.get('me').isSelf, true);
  assert.equal(n.get('me').label, '我');
  assert.equal(n.get('uncle').label, '伯父');
  assert.deepEqual(graph.bands.map(b => b.label), ['祖辈', '父辈', '我的同辈']);
  assert.equal(graph.edges.length, demoRelations.length);
  // The father's sibling and spouse stay near him in the same row.
  assert.equal(Math.abs(n.get('uncle').x - n.get('dad').x), 175);
  assert.equal(Math.abs(n.get('mom').x - n.get('dad').x), 175);
  const viewportLeft = (graph.width - 690) / 2;
  assert.ok(graph.nodes.every(node => node.x - 77 >= viewportLeft && node.x + 77 <= viewportLeft + 690));
});

test('child, sibling, spouse and nephew follow directed parent constraints', () => {
  const persons = ['me', 'wife', 'brother', 'child', 'nephew'].map(id => ({id, name: id}));
  const relations = [
    {from: 'me', to: 'wife', type: 'spouse'},
    {from: 'me', to: 'brother', type: 'sibling'},
    {from: 'me', to: 'child', type: 'parent'},
    {from: 'brother', to: 'nephew', type: 'parent'}
  ];
  const n = byId(buildStarLayout(persons, relations, 'me', 'me'));
  for (const id of ['me', 'wife', 'brother']) assert.equal(n.get(id).generation, 0);
  for (const id of ['child', 'nephew']) assert.equal(n.get(id).generation, 1);
  assert.equal(n.get('child').y, n.get('nephew').y);
  assert.ok(n.get('child').y > n.get('me').y);
});

test('generation and coordinates do not depend on input order', () => {
  const a = buildStarLayout(demoPeople, demoRelations, 'me', 'me');
  const b = buildStarLayout([...demoPeople].reverse(), [...demoRelations].reverse(), 'me', 'me');
  const shape = graph => graph.nodes.map(({id, x, y, generation}) => ({id, x, y, generation}))
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(shape(a), shape(b));
  assert.deepEqual(a.bands, b.bands);
});

test('selecting a person highlights that card without moving generations or hiding others', () => {
  const normal = buildStarLayout(demoPeople, demoRelations, 'me', 'me');
  const selected = buildStarLayout(demoPeople, demoRelations, 'me', 'me', {}, 'uncle');
  const n = byId(selected);
  assert.equal(n.get('uncle').isSelected, true);
  assert.equal(n.get('me').isSelected, false);
  assert.equal(n.get('me').isSelf, true);
  assert.deepEqual(
    selected.nodes.map(({id, x, y, label}) => ({id, x, y, label})),
    normal.nodes.map(({id, x, y, label}) => ({id, x, y, label}))
  );
});

test('generation headings have a clear row above cards and stay inside the board', () => {
  const graph = buildStarLayout([...demoPeople, {id: 'other', name: '远亲'}], demoRelations, 'me', 'me');
  const cardHalfHeight = 87; // .person-node is 174rpx high.
  const headingHeight = 34; // .generation-heading is 34rpx high.
  for (const band of graph.bands) {
    const bandTop = Number(band.style.match(/top:(\d+)rpx/)?.[1]);
    const markerTop = Number(band.markers[0]?.style.match(/top:(\d+)rpx/)?.[1]);
    const headingTop = bandTop + markerTop;
    const cardTop = band.y - cardHalfHeight;
    assert.ok(headingTop >= 0, `${band.label} heading clipped above board`);
    assert.ok(headingTop + headingHeight <= cardTop - 6, `${band.label} heading overlaps a card`);
    const rowNodes = graph.nodes.filter(node => node.y === band.y);
    assert.ok(rowNodes.length > 0);
    assert.ok(rowNodes.every(node => node.y + cardHalfHeight <= graph.height), `${band.label} card clipped below board`);
  }
});

test('unlinked people have a separate unknown row; no claim has no fake self focus', () => {
  const graph = buildStarLayout([...demoPeople, {id: 'friend', name: '老同学'}], demoRelations, 'me', 'me');
  const n = byId(graph);
  assert.equal(n.get('friend').generation, null);
  assert.equal(n.get('friend').label, '关系待补充');
  assert.equal(graph.bands.at(-1).label, '关系待补充');
  assert.ok(n.get('friend').y > n.get('me').y);

  const neutral = buildStarLayout([{id: 'a', name: '阿姨'}, {id: 'b', name: '舅舅'}], [], '', '');
  assert.equal(neutral.centerId, '');
  assert.ok(neutral.nodes.every(node => !node.isSelf && !node.isFocus && node.label !== '我'));
  assert.ok(neutral.nodes.every(node => node.generation === null && node.label === '关系待补充'));
});

test('contradictory generation paths move the affected connected region to verification row', () => {
  const people = ['a', 'b', 'c', 'outsider'].map(id => ({id, name: id}));
  const relations = [
    {from: 'a', to: 'b', type: 'parent'},
    {from: 'b', to: 'c', type: 'parent'},
    {from: 'a', to: 'c', type: 'sibling'}
  ];
  const graph = buildStarLayout(people, relations, 'a', 'a');
  const n = byId(graph);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(n.get(id).generation, null);
    assert.equal(n.get(id).isConflicted, true);
  }
  assert.equal(n.get('outsider').generation, null);
  assert.equal(n.get('outsider').isConflicted, false);
  assert.equal(graph.conflictCount, 3);
  assert.equal(graph.bands.at(-1).label, '关系待补充／核实');
  assert.ok(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test('personal display names do not rearrange the family generation layout', () => {
  const original = buildStarLayout(demoPeople, demoRelations, 'me', 'me');
  const renamed = buildStarLayout(demoPeople.map(person => ({...person, originalName: person.name, name: person.id === 'uncle' ? '我最亲的大伯' : person.name})), demoRelations, 'me', 'me');
  assert.deepEqual(renamed.nodes.map(({id, x, y}) => ({id, x, y})), original.nodes.map(({id, x, y}) => ({id, x, y})));
  assert.equal(renamed.nodes.find(node => node.id === 'uncle').name, '我最亲的大伯');
});

test('wide generations scroll horizontally without node overlap, preserve search dimming and budget', () => {
  const persons = [{id: 'p0', name: '我'}];
  for (let i = 1; i < 200; i++) persons.push({id: `p${i}`, name: `孩子${i}`, isDimmed: i % 2 === 0});
  const relations = persons.slice(1).map(person => ({from: 'p0', to: person.id, type: 'parent'}));
  const graph = buildStarLayout(persons, relations, 'p0', 'p0');
  assert.equal(graph.nodes.length, 160);
  assert.equal(graph.hiddenCount, 40);
  assert.ok(graph.width > 690);
  assert.ok(graph.height < graph.width);
  const children = graph.nodes.filter(node => node.generation === 1).sort((a, b) => a.x - b.x);
  for (let i = 1; i < children.length; i++) {
    assert.equal(children[i].y, children[0].y);
    assert.ok(children[i].x - children[i - 1].x >= 175);
  }
  assert.equal(graph.nodes.find(node => node.id === 'p2').isDimmed, true);
  for (const band of graph.bands) {
    const markerXs = band.markers.map(marker => Number(marker.style.match(/left:(\d+)rpx/)?.[1]));
    assert.ok(markerXs.every(Number.isFinite));
    for (let left = 0; left <= graph.width - 690; left += 100) {
      assert.ok(markerXs.some(x => x >= left && x <= left + 690), `band title invisible at scroll ${left}`);
    }
  }
});

test('invalid and duplicate edges do not create duplicate links', () => {
  const graph = buildStarLayout(
    [{id: 'a', name: '甲'}, {id: 'b', name: '乙'}],
    [
      {from: 'a', to: 'b', type: 'spouse'},
      {from: 'b', to: 'a', type: 'spouse'},
      {from: 'a', to: 'missing', type: 'parent'},
      {from: 'a', to: 'a', type: 'sibling'}
    ], 'a', 'a'
  );
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].generation, 0);
  assert.equal(graph.nodes[1].generation, 0);
});
