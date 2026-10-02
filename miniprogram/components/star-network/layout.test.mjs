import assert from 'node:assert/strict';
import test from 'node:test';
import {buildStarLayout} from './layout.ts';

test('the claimed self is the bright center and links follow recorded relationships', () => {
  const persons = [
    {id: 'me', name: '小满'}, {id: 'dad', name: '爸爸'}, {id: 'uncle', name: '伯父'}, {id: 'friend', name: '老同学'}
  ];
  const relations = [
    {id: 'parent', from: 'dad', to: 'me', type: 'parent'},
    {id: 'brothers', from: 'uncle', to: 'dad', type: 'sibling'}
  ];
  const graph = buildStarLayout(persons, relations, 'me', 'me', {uncle: '伯父'});
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  assert.equal(graph.centerId, 'me');
  assert.equal(byId.get('me').ring, 0);
  assert.equal(byId.get('me').isSelf, true);
  assert.equal(byId.get('me').label, '我');
  assert.equal(byId.get('dad').ring, 1);
  assert.equal(byId.get('uncle').ring, 1);
  assert.equal(byId.get('uncle').label, '伯父');
  assert.equal(byId.get('friend').connected, false);
  assert.equal(byId.get('friend').label, '待补关系');
  assert.equal(graph.edges.length, 2);
});

test('a seven-person household fits every planet on the first-screen board', () => {
  const persons = Array.from({length: 7}, (_, i) => ({id: `p${i}`, name: `家人${i}`}));
  const relations = [
    {from: 'p0', to: 'p1', type: 'parent'}, {from: 'p0', to: 'p2', type: 'parent'},
    {from: 'p1', to: 'p3', type: 'sibling'}, {from: 'p2', to: 'p4', type: 'sibling'},
    {from: 'p3', to: 'p5', type: 'parent'}, {from: 'p1', to: 'p6', type: 'parent'}
  ];
  const graph = buildStarLayout(persons, relations, 'p0', 'p0');
  assert.equal(graph.size, 650);
  assert.equal(graph.nodes.length, 7);
  for (const node of graph.nodes) {
    assert.ok(node.x >= 75 && node.x <= 575);
    assert.ok(node.y >= 75 && node.y <= 575);
  }
  assert.ok(graph.nodes.slice(1).every(node => node.ring === 1));
});

test('without a claimed self, center stays neutral and no node is labeled me', () => {
  const graph = buildStarLayout([{id: 'a', name: '阿姨'}, {id: 'b', name: '舅舅'}], [], '', '');
  assert.equal(graph.centerId, 'a');
  assert.equal(graph.nodes.find(node => node.id === 'a').isFocus, true);
  assert.ok(graph.nodes.every(node => !node.isSelf && node.label !== '我'));
});

test('larger family graph expands into rings and reports any people beyond the display budget', () => {
  const persons = Array.from({length: 200}, (_, i) => ({id: `p${i}`, name: `成员${i}`}));
  const relations = persons.slice(1).map((person, i) => ({id: `r${i}`, from: 'p0', to: person.id, type: 'parent'}));
  const graph = buildStarLayout(persons, relations, 'p0', 'p0');
  assert.equal(graph.nodes.length, 160);
  assert.equal(graph.hiddenCount, 40);
  assert.ok(graph.orbits.length > 1);
  assert.ok(graph.size > 730);
  const byRing = new Map();
  for (const node of graph.nodes.filter(node => node.ring)) {
    const nodes = byRing.get(node.ring) || [];
    nodes.push(node);
    byRing.set(node.ring, nodes);
  }
  for (const nodes of byRing.values()) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
        assert.ok(distance >= 165, `nodes too close: ${nodes[i].id}, ${nodes[j].id}`);
      }
    }
  }
});

test('invalid and duplicate edges do not create duplicate links', () => {
  const persons = [{id: 'a', name: '甲'}, {id: 'b', name: '乙'}];
  const relations = [
    {from: 'a', to: 'b', type: 'spouse'},
    {from: 'b', to: 'a', type: 'spouse'},
    {from: 'a', to: 'missing', type: 'parent'},
    {from: 'a', to: 'a', type: 'sibling'}
  ];
  const graph = buildStarLayout(persons, relations, 'a', 'a');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].type, 'spouse');
});
