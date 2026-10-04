/**
 * 第一版家庭圈称呼计算。纯函数、不读取云端数据，也不承担权限判断。
 * 调用方必须先按 circleId 完成成员授权与数据过滤。
 */

export type Gender = 'male' | 'female' | 'unknown';
export type KinshipStatus = 'resolved' | 'pending' | 'self' | 'unrelated' | 'ambiguous' | 'invalid';

export interface Person {
  id: string;
  name?: string;
  gender?: Gender;
  /** 标准公历出生日期 YYYY-MM-DD；农历应由调用方先按出生年转换。 */
  birthDate?: string;
  /** 兼容旧资料。只有年份且年份相同时，不能推断先后。 */
  birthYear?: number;
}

export type ParentChildRelation = {
  type: 'parent_child';
  parentId: string;
  childId: string;
  kind?: 'biological' | 'adoptive' | 'step' | 'unspecified';
};

export type SpouseRelation = {
  type: 'spouse';
  personAId: string;
  personBId: string;
  status?: 'current' | 'former';
};

export type SiblingRelation = {
  type: 'sibling';
  personAId: string;
  personBId: string;
  /** 只可填 A 或 B；用来区分哥哥/弟弟、伯父/叔叔。 */
  olderPersonId?: string;
  /** 同性别兄弟姐妹中的排行，供“大姨/二姨”等叫法使用。 */
  rankOfA?: number;
  rankOfB?: number;
  kind?: 'full' | 'half' | 'adoptive' | 'step' | 'unspecified';
};

export type Relation = ParentChildRelation | SpouseRelation | SiblingRelation;

export interface KinshipOverride {
  perspectiveId: string;
  targetId: string;
  term: string;
  scope: 'personal' | 'circle';
  note?: string;
}

export interface KinshipInput {
  people: Person[];
  relations: Relation[];
  perspectiveId: string;
  targetId: string;
  overrides?: KinshipOverride[];
}

export interface KinshipPathStep {
  fromId: string;
  toId: string;
  relation: 'parent' | 'child' | 'sibling' | 'spouse';
  label: string;
  inferred: boolean;
  /** 当前节点相对于上个节点的长幼，只对兄弟姐妹有值。 */
  ageOrder?: 'older' | 'younger';
  rank?: number;
  relationKind?: string;
}

export interface KinshipPath {
  personIds: string[];
  steps: KinshipPathStep[];
  /** 例：我 → 妈妈 → 妈妈的姐姐。 */
  display: string;
}

export interface KinshipResult {
  /** 自动规则的状态；个人叫法不会伪造底层关系。 */
  status: KinshipStatus;
  /** 首选展示叫法；有自定义叫法时为自定义值。 */
  term?: string;
  /** 自动计算出的首选叫法；有自定义叫法时仍保留。 */
  calculatedTerm?: string;
  /** 确定的关系类别，并非可直接使用的称呼，例如长幼未明时的「堂姐妹」。 */
  category?: string;
  /** 同一称谓的常用别称，或多路径产生的候选叫法。 */
  alternatives?: string[];
  path?: KinshipPath;
  /** 最短路径可能不止一条。 */
  paths: KinshipPath[];
  missing: string[];
  reason?: string;
  source: 'rule' | 'override' | 'none';
  /** 最短路径过多时为 true，此时不会武断给出自动称呼。 */
  truncated: boolean;
  override?: KinshipOverride;
}

type Arc = {
  fromId: string;
  toId: string;
  relation: KinshipPathStep['relation'];
  relationKind?: string;
  spouseStatus?: 'current' | 'former';
  ageOrder?: 'older' | 'younger';
  rank?: number;
  inferred: boolean;
};

type Graph = Map<string, Arc[]>;
type PathSearch = { paths: KinshipPath[]; truncated: boolean };
type RuleAssessment = { term?: string; category?: string; alternatives?: string[]; missing: string[]; reason?: string };

const MAX_PATHS = 32;
const RELATION_PRIORITY: Record<Arc['relation'], number> = {
  parent: 0,
  sibling: 1,
  child: 2,
  spouse: 3,
};

function gender(person: Person | undefined): Gender {
  return person?.gender ?? 'unknown';
}

function positiveRank(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validBirthDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1800 || year > 2200) return false;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function olderFromBirthday(from: Person, to: Person): 'older' | 'younger' | undefined {
  if (from.birthDate && to.birthDate) {
    if (from.birthDate === to.birthDate) return undefined;
    return to.birthDate < from.birthDate ? 'older' : 'younger';
  }
  const fromYear = from.birthDate ? Number(from.birthDate.slice(0, 4)) : from.birthYear;
  const toYear = to.birthDate ? Number(to.birthDate.slice(0, 4)) : to.birthYear;
  if (fromYear === undefined || toYear === undefined || fromYear === toYear) {
    return undefined;
  }
  return toYear < fromYear ? 'older' : 'younger';
}

function olderFromSiblingRank(from: Person, to: Person, fromRank?: number, toRank?: number): 'older' | 'younger' | undefined {
  if (gender(from) === 'unknown' || gender(from) !== gender(to) || !fromRank || !toRank || fromRank === toRank) {
    return undefined;
  }
  return toRank < fromRank ? 'older' : 'younger';
}

function validate(input: KinshipInput): string | undefined {
  if (!input || !Array.isArray(input.people) || !Array.isArray(input.relations)) {
    return '人物或关系数据格式不正确';
  }
  const ids = new Set<string>();
  const byId = new Map<string, Person>();
  for (const person of input.people) {
    if (!person || typeof person.id !== 'string' || !person.id.trim() || ids.has(person.id)) {
      return '人物 ID 为空或重复';
    }
    if (person.gender !== undefined && !['male', 'female', 'unknown'].includes(person.gender)) {
      return `人物 ${person.id} 的性别值不正确`;
    }
    if (person.birthYear !== undefined && (!Number.isInteger(person.birthYear) || person.birthYear < 1800 || person.birthYear > 2200)) {
      return `人物 ${person.id} 的出生年份不正确`;
    }
    if (person.birthDate !== undefined && (typeof person.birthDate !== 'string' || !validBirthDate(person.birthDate))) {
      return `人物 ${person.id} 的出生日期不正确`;
    }
    if (person.birthDate && person.birthYear !== undefined && Number(person.birthDate.slice(0, 4)) !== person.birthYear) {
      return `人物 ${person.id} 的出生日期与年份冲突`;
    }
    ids.add(person.id);
    byId.set(person.id, person);
  }
  if (!ids.has(input.perspectiveId) || !ids.has(input.targetId)) {
    return '视角人物或目标人物不存在';
  }
  const childrenByParent = new Map<string, string[]>();
  for (const relation of input.relations) {
    if (!relation || typeof relation !== 'object') return '关系数据格式不正确';
    let a: string;
    let b: string;
    if (relation.type === 'parent_child') {
      a = relation.parentId;
      b = relation.childId;
      if (relation.kind !== undefined && !['biological', 'adoptive', 'step', 'unspecified'].includes(relation.kind)) {
        return '亲子关系类型不正确';
      }
      const children = childrenByParent.get(a) ?? [];
      children.push(b);
      childrenByParent.set(a, children);
    } else if (relation.type === 'spouse') {
      a = relation.personAId;
      b = relation.personBId;
      if (relation.status !== undefined && !['current', 'former'].includes(relation.status)) {
        return '配偶关系状态不正确';
      }
    } else if (relation.type === 'sibling') {
      a = relation.personAId;
      b = relation.personBId;
      if (relation.olderPersonId !== undefined && relation.olderPersonId !== a && relation.olderPersonId !== b) {
        return '长幼标记不属于这对兄弟姐妹';
      }
      if (relation.rankOfA !== undefined && !positiveRank(relation.rankOfA)) return '兄弟姐妹排行必须为正整数';
      if (relation.rankOfB !== undefined && !positiveRank(relation.rankOfB)) return '兄弟姐妹排行必须为正整数';
      if (relation.kind !== undefined && !['full', 'half', 'adoptive', 'step', 'unspecified'].includes(relation.kind)) {
        return '兄弟姐妹关系类型不正确';
      }
      if (ids.has(a) && ids.has(b)) {
        const rankOrder = olderFromSiblingRank(byId.get(a)!, byId.get(b)!, relation.rankOfA, relation.rankOfB);
        const birthOrder = olderFromBirthday(byId.get(a)!, byId.get(b)!);
        const explicitOrder = relation.olderPersonId === b ? 'older' : relation.olderPersonId === a ? 'younger' : undefined;
        if (gender(byId.get(a)) === gender(byId.get(b)) && gender(byId.get(a)) !== 'unknown' &&
          relation.rankOfA !== undefined && relation.rankOfA === relation.rankOfB) {
          return '同性别兄弟姐妹的排行不能相同';
        }
        if ((rankOrder && birthOrder && rankOrder !== birthOrder) ||
          (explicitOrder && rankOrder && explicitOrder !== rankOrder) ||
          (explicitOrder && birthOrder && explicitOrder !== birthOrder)) {
          return '兄弟姐妹的长幼、排行与出生日期冲突';
        }
      }
    } else {
      return '未知的关系类型';
    }
    if (!ids.has(a) || !ids.has(b) || a === b) return '关系指向不存在的人物或指向自身';
  }

  // 亲子关系应为有向无环图，否则任何推导都可能给出误导性称呼。
  const colors = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    colors.set(id, 1);
    for (const child of childrenByParent.get(id) ?? []) {
      if (colors.get(child) === 1) return true;
      if (colors.get(child) !== 2 && visit(child)) return true;
    }
    colors.set(id, 2);
    return false;
  };
  for (const id of ids) {
    if (!colors.has(id) && visit(id)) return '亲子关系存在循环，请先更正';
  }
  return undefined;
}

function buildGraph(people: Person[], relations: Relation[]): Graph {
  const graph: Graph = new Map(people.map((p) => [p.id, []]));
  const byId = new Map(people.map((p) => [p.id, p]));
  const add = (arc: Arc): void => {
    const list = graph.get(arc.fromId)!;
    if (!list.some((existing) =>
      existing.toId === arc.toId && existing.relation === arc.relation &&
      existing.relationKind === arc.relationKind && existing.spouseStatus === arc.spouseStatus
    )) list.push(arc);
  };
  const childrenByParent = new Map<string, Array<{ id: string; kind: ParentChildRelation['kind'] }>>();
  const explicitSiblings = new Set<string>();

  for (const relation of relations) {
    if (relation.type === 'parent_child') {
      const kind = relation.kind ?? 'unspecified';
      add({ fromId: relation.childId, toId: relation.parentId, relation: 'parent', relationKind: kind, inferred: false });
      add({ fromId: relation.parentId, toId: relation.childId, relation: 'child', relationKind: kind, inferred: false });
      const children = childrenByParent.get(relation.parentId) ?? [];
      children.push({ id: relation.childId, kind });
      childrenByParent.set(relation.parentId, children);
    } else if (relation.type === 'spouse') {
      const status = relation.status ?? 'current';
      add({ fromId: relation.personAId, toId: relation.personBId, relation: 'spouse', spouseStatus: status, inferred: false });
      add({ fromId: relation.personBId, toId: relation.personAId, relation: 'spouse', spouseStatus: status, inferred: false });
    } else {
      const a = relation.personAId;
      const b = relation.personBId;
      explicitSiblings.add([a, b].sort().join('\u0000'));
      const ageAtoB = relation.olderPersonId === b ? 'older' : relation.olderPersonId === a ? 'younger' :
        olderFromSiblingRank(byId.get(a)!, byId.get(b)!, relation.rankOfA, relation.rankOfB) ??
        olderFromBirthday(byId.get(a)!, byId.get(b)!);
      const ageBtoA = ageAtoB === 'older' ? 'younger' : ageAtoB === 'younger' ? 'older' : undefined;
      const kind = relation.kind ?? 'unspecified';
      add({ fromId: a, toId: b, relation: 'sibling', relationKind: kind, ageOrder: ageAtoB, rank: relation.rankOfB, inferred: false });
      add({ fromId: b, toId: a, relation: 'sibling', relationKind: kind, ageOrder: ageBtoA, rank: relation.rankOfA, inferred: false });
    }
  }

  // 两人共享明确的非继亲父母时可推断兄弟姐妹；只用于基础叫法，不推断排行。
  const inferredPairs = new Set<string>();
  for (const children of childrenByParent.values()) {
    const eligible = children.filter((c) => c.kind === 'biological' || c.kind === 'unspecified');
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i].id;
        const b = eligible[j].id;
        if (a === b) continue;
        const key = [a, b].sort().join('\u0000');
        if (explicitSiblings.has(key) || inferredPairs.has(key)) continue;
        inferredPairs.add(key);
        const ageAtoB = olderFromBirthday(byId.get(a)!, byId.get(b)!);
        const ageBtoA = ageAtoB === 'older' ? 'younger' : ageAtoB === 'younger' ? 'older' : undefined;
        add({ fromId: a, toId: b, relation: 'sibling', relationKind: 'unspecified', ageOrder: ageAtoB, inferred: true });
        add({ fromId: b, toId: a, relation: 'sibling', relationKind: 'unspecified', ageOrder: ageBtoA, inferred: true });
      }
    }
  }
  for (const list of graph.values()) {
    list.sort((a, b) => RELATION_PRIORITY[a.relation] - RELATION_PRIORITY[b.relation] || a.toId.localeCompare(b.toId));
  }
  return graph;
}

function labelForArc(arc: Arc, byId: Map<string, Person>): string {
  const targetGender = gender(byId.get(arc.toId));
  if (arc.relation === 'parent') {
    if (arc.relationKind === 'step') return targetGender === 'male' ? '继父' : targetGender === 'female' ? '继母' : '继父母';
    if (arc.relationKind === 'adoptive') return targetGender === 'male' ? '养父' : targetGender === 'female' ? '养母' : '养父母';
    return targetGender === 'male' ? '爸爸' : targetGender === 'female' ? '妈妈' : '父母';
  }
  if (arc.relation === 'child') return targetGender === 'male' ? '儿子' : targetGender === 'female' ? '女儿' : '子女';
  if (arc.relation === 'spouse') {
    if (arc.spouseStatus === 'former') return targetGender === 'male' ? '前夫' : targetGender === 'female' ? '前妻' : '前配偶';
    return targetGender === 'male' ? '丈夫' : targetGender === 'female' ? '妻子' : '配偶';
  }
  if (targetGender === 'male') return arc.ageOrder === 'older' ? '哥哥' : arc.ageOrder === 'younger' ? '弟弟' : '兄弟';
  if (targetGender === 'female') return arc.ageOrder === 'older' ? '姐姐' : arc.ageOrder === 'younger' ? '妹妹' : '姐妹';
  return '兄弟姐妹';
}

function toPath(arcs: Arc[], perspectiveId: string, byId: Map<string, Person>): KinshipPath {
  const steps: KinshipPathStep[] = arcs.map((arc) => ({
    fromId: arc.fromId,
    toId: arc.toId,
    relation: arc.relation,
    label: labelForArc(arc, byId),
    inferred: arc.inferred,
    ...(arc.ageOrder ? { ageOrder: arc.ageOrder } : {}),
    ...(arc.rank ? { rank: arc.rank } : {}),
    ...(arc.relationKind ? { relationKind: arc.relationKind } : {}),
  }));
  let chain = '';
  let display = '我';
  for (const step of steps) {
    chain = chain ? `${chain}的${step.label}` : step.label;
    display += ` → ${chain}`;
  }
  return { personIds: [perspectiveId, ...arcs.map((arc) => arc.toId)], steps, display };
}

function findShortestPaths(graph: Graph, perspectiveId: string, targetId: string, byId: Map<string, Person>): PathSearch {
  if (perspectiveId === targetId) return { paths: [{ personIds: [perspectiveId], steps: [], display: '我' }], truncated: false };
  const distance = new Map<string, number>([[perspectiveId, 0]]);
  const parents = new Map<string, Arc[]>();
  const queue = [perspectiveId];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const nextDistance = distance.get(current)! + 1;
    const targetDistance = distance.get(targetId);
    if (targetDistance !== undefined && nextDistance > targetDistance) break;
    for (const arc of graph.get(current) ?? []) {
      const known = distance.get(arc.toId);
      if (known === undefined) {
        distance.set(arc.toId, nextDistance);
        parents.set(arc.toId, [arc]);
        queue.push(arc.toId);
      } else if (known === nextDistance) {
        parents.get(arc.toId)!.push(arc);
      }
    }
  }
  if (!distance.has(targetId)) return { paths: [], truncated: false };

  const paths: KinshipPath[] = [];
  let truncated = false;
  const reverse: Arc[] = [];
  const collect = (atId: string): void => {
    if (paths.length >= MAX_PATHS) {
      truncated = true;
      return;
    }
    if (atId === perspectiveId) {
      paths.push(toPath([...reverse].reverse(), perspectiveId, byId));
      return;
    }
    for (const arc of parents.get(atId) ?? []) {
      reverse.push(arc);
      collect(arc.fromId);
      reverse.pop();
      if (truncated) return;
    }
  };
  collect(targetId);
  return { paths, truncated };
}

/** 返回最短的可读关系路径；数据无效或两人不连通时返回空数组。 */
export function getRelationshipPaths(input: KinshipInput): KinshipPath[] {
  if (validate(input)) return [];
  const byId = new Map(input.people.map((p) => [p.id, p]));
  return findShortestPaths(buildGraph(input.people, input.relations), input.perspectiveId, input.targetId, byId).paths;
}

function requireGender(person: Person | undefined, role: string, missing: string[]): Gender {
  const value = gender(person);
  if (value === 'unknown') missing.push(`${role}的性别`);
  return value;
}

function siblingAge(step: KinshipPathStep, role: string, missing: string[]): 'older' | 'younger' | undefined {
  if (!step.ageOrder) missing.push(`${role}与其兄弟姐妹的长幼`);
  return step.ageOrder;
}

function ageBetween(perspective: Person, target: Person, missing: string[]): 'older' | 'younger' | undefined {
  const age = olderFromBirthday(perspective, target);
  if (!age) missing.push('双方的长幼（可补充完整出生日期；同日出生需家人确认）');
  return age;
}

function rankPrefix(rank: number): string | undefined {
  const words = ['', '大', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return words[rank];
}

function assessPath(path: KinshipPath, byId: Map<string, Person>): RuleAssessment {
  const steps = path.steps;
  const missing: string[] = [];
  const person = (index: number): Person => byId.get(path.personIds[index])!;
  const g = (index: number, role: string): Gender => requireGender(person(index), role, missing);
  const kinds = steps.map((step) => step.relation);
  const pattern = kinds.join('>');

  if (steps.some((step) => step.relationKind === 'step' || step.relationKind === 'adoptive' || step.relationKind === 'half')) {
    return { missing: ['特殊家庭关系的称呼需家人确认'], reason: '已展示关系路径，暂不自动推断继亲、收养或同父异母/同母异父的称呼' };
  }
  if (steps.some((step) => step.relation === 'spouse' && step.label.startsWith('前'))) {
    return { missing: ['前配偶关系的称呼需家人确认'], reason: '前配偶关系不按当前配偶自动推断' };
  }

  if (pattern === 'parent') {
    const parent = g(1, '父母');
    return { term: parent === 'male' ? '爸爸' : parent === 'female' ? '妈妈' : undefined, missing };
  }
  if (pattern === 'child') {
    const child = g(1, '子女');
    return { term: child === 'male' ? '儿子' : child === 'female' ? '女儿' : undefined, missing };
  }
  if (pattern === 'spouse') {
    const spouse = g(1, '配偶');
    return { term: spouse === 'male' ? '丈夫' : spouse === 'female' ? '妻子' : undefined, missing };
  }
  if (pattern === 'sibling') {
    const sibling = g(1, '兄弟姐妹');
    const age = siblingAge(steps[0], '本人', missing);
    if (sibling === 'male') return { term: age === 'older' ? '哥哥' : age === 'younger' ? '弟弟' : undefined, missing };
    if (sibling === 'female') return { term: age === 'older' ? '姐姐' : age === 'younger' ? '妹妹' : undefined, missing };
    return { missing };
  }
  if (pattern === 'parent>parent') {
    const first = g(1, '第一位父母');
    const second = g(2, '祖辈');
    if (first === 'male') return { term: second === 'male' ? '爷爷' : second === 'female' ? '奶奶' : undefined, missing };
    if (first === 'female') return { term: second === 'male' ? '外公' : second === 'female' ? '外婆' : undefined, missing };
    return { missing };
  }
  if (pattern === 'child>child') {
    const first = g(1, '子女');
    const second = g(2, '孙辈');
    if (first === 'male') return { term: second === 'male' ? '孙子' : second === 'female' ? '孙女' : undefined, missing };
    if (first === 'female') return { term: second === 'male' ? '外孙' : second === 'female' ? '外孙女' : undefined, missing };
    return { missing };
  }
  if (pattern === 'parent>sibling') {
    const parent = g(1, '父母');
    const sibling = g(2, '父母的兄弟姐妹');
    if (parent === 'male' && sibling === 'male') {
      const age = siblingAge(steps[1], '父亲', missing);
      return { term: age === 'older' ? '伯父' : age === 'younger' ? '叔叔' : undefined, alternatives: age === 'older' ? ['伯伯'] : undefined, missing };
    }
    if (parent === 'male' && sibling === 'female') return { term: '姑姑', alternatives: ['姑妈'], missing };
    if (parent === 'female' && sibling === 'male') return { term: '舅舅', missing };
    if (parent === 'female' && sibling === 'female') {
      const prefix = steps[1].rank ? rankPrefix(steps[1].rank) : undefined;
      return { term: prefix ? `${prefix}姨` : '姨妈', alternatives: prefix ? ['姨妈', '姨母'] : ['姨母'], missing };
    }
    return { missing };
  }
  if (pattern === 'parent>sibling>spouse') {
    const parent = g(1, '父母');
    const sibling = g(2, '父母的兄弟姐妹');
    const spouse = g(3, '亲属的配偶');
    if (parent === 'male' && sibling === 'male') {
      const age = siblingAge(steps[1], '父亲', missing);
      if (spouse === 'female') return { term: age === 'older' ? '伯母' : age === 'younger' ? '婶婶' : undefined, missing };
    }
    if (parent === 'male' && sibling === 'female' && spouse === 'male') return { term: '姑父', missing };
    if (parent === 'female' && sibling === 'male' && spouse === 'female') return { term: '舅妈', missing };
    if (parent === 'female' && sibling === 'female' && spouse === 'male') return { term: '姨父', missing };
    return { missing, reason: missing.length ? undefined : '当前家庭结构没有统一的第一版自动称谓' };
  }
  if (pattern === 'sibling>child') {
    const sibling = g(1, '兄弟姐妹');
    const child = g(2, '兄弟姐妹的子女');
    if (sibling === 'male') return { term: child === 'male' ? '侄子' : child === 'female' ? '侄女' : undefined, missing };
    if (sibling === 'female') return { term: child === 'male' ? '外甥' : child === 'female' ? '外甥女' : undefined, missing };
    return { missing };
  }
  if (pattern === 'parent>sibling>child') {
    const parent = g(1, '父母');
    const sibling = g(2, '父母的兄弟姐妹');
    const cousin = g(3, '堂表兄弟姐妹');
    const age = ageBetween(person(0), person(3), missing);
    if (parent === 'unknown' || sibling === 'unknown' || cousin === 'unknown') return { missing };
    const family = parent === 'male' && sibling === 'male' ? '堂' : '表';
    if (!age) return { category: `${family}${cousin === 'male' ? '兄弟' : '姐妹'}`, missing };
    return { term: `${family}${cousin === 'male' ? (age === 'older' ? '哥' : '弟') : (age === 'older' ? '姐' : '妹')}`, missing };
  }
  if (pattern === 'child>spouse') {
    const child = g(1, '子女');
    const spouse = g(2, '子女的配偶');
    if (child === 'male' && spouse === 'female') return { term: '儿媳', missing };
    if (child === 'female' && spouse === 'male') return { term: '女婿', missing };
    return { missing, reason: missing.length ? undefined : '当前家庭结构没有统一的第一版自动称谓' };
  }
  if (pattern === 'spouse>parent') {
    const spouse = g(1, '配偶');
    const parent = g(2, '配偶的父母');
    if (spouse === 'male') return { term: parent === 'male' ? '公公' : parent === 'female' ? '婆婆' : undefined, missing };
    if (spouse === 'female') return { term: parent === 'male' ? '岳父' : parent === 'female' ? '岳母' : undefined, missing };
    return { missing };
  }
  if (pattern === 'sibling>spouse') {
    const sibling = g(1, '兄弟姐妹');
    const spouse = g(2, '兄弟姐妹的配偶');
    const age = siblingAge(steps[0], '本人', missing);
    if (sibling === 'male' && spouse === 'female') return { term: age === 'older' ? '嫂子' : age === 'younger' ? '弟媳' : undefined, missing };
    if (sibling === 'female' && spouse === 'male') return { term: age === 'older' ? '姐夫' : age === 'younger' ? '妹夫' : undefined, missing };
    return { missing, reason: missing.length ? undefined : '当前家庭结构没有统一的第一版自动称谓' };
  }
  return { missing: [], reason: '该关系路径暂未纳入第一版自动称谓规则' };
}

function preferredOverride(input: KinshipInput): KinshipOverride | undefined {
  const matching = (input.overrides ?? []).filter((item) =>
    item.perspectiveId === input.perspectiveId && item.targetId === input.targetId &&
    typeof item.term === 'string' && item.term.trim()
  );
  return matching.find((item) => item.scope === 'personal') ?? matching.find((item) => item.scope === 'circle');
}

/**
 * 从任意人物视角推导目标人物称呼。只对明确且在规则表中的关系给出自动称呼；
 * 信息不全、特殊家庭结构、多条冲突路径均返回路径与待确认状态。
 */
export function resolveKinship(input: KinshipInput): KinshipResult {
  const error = validate(input);
  if (error) return { status: 'invalid', paths: [], missing: [], reason: error, source: 'none', truncated: false };
  const byId = new Map(input.people.map((p) => [p.id, p]));
  const found = findShortestPaths(buildGraph(input.people, input.relations), input.perspectiveId, input.targetId, byId);
  const override = preferredOverride(input);
  const base: KinshipResult = {
    status: 'unrelated', paths: found.paths, path: found.paths[0], missing: [], source: 'none', truncated: found.truncated,
  };
  if (input.perspectiveId === input.targetId) {
    base.status = 'self';
    base.term = '本人';
    base.calculatedTerm = '本人';
    base.source = 'rule';
  } else if (found.paths.length === 0) {
    base.reason = '两人尚无已录入的连接关系';
  } else if (found.truncated) {
    base.status = 'ambiguous';
    base.reason = '存在过多条最短关系路径，请先核对关系记录';
  } else {
    const assessments = found.paths.map((path) => assessPath(path, byId));
    base.missing = [...new Set(assessments.reduce<string[]>((all, item) => all.concat(item.missing), []))];
    const terms = [...new Set(assessments.map((item) => item.term).filter((term): term is string => !!term))];
    const unresolved = assessments.some((item) => !item.term);
    if (terms.length === 1 && !unresolved) {
      base.status = 'resolved';
      base.term = terms[0];
      base.calculatedTerm = terms[0];
      base.alternatives = [...new Set(assessments.reduce<string[]>((all, item) => all.concat(item.alternatives ?? []), []))];
      base.source = 'rule';
    } else if (terms.length > 0) {
      base.status = 'ambiguous';
      base.alternatives = terms;
      base.reason = '不同关系路径得到不同或无法确认的称呼，请核对关系';
    } else {
      base.status = 'pending';
      const categories = [...new Set(assessments.map((item) => item.category).filter((item): item is string => !!item))];
      if (categories.length === 1 && assessments.every((item) => item.category === categories[0])) {
        base.category = categories[0];
      }
      base.reason = assessments.map((item) => item.reason).find(Boolean) ??
        (base.missing.length ? '补充关键资料后可计算称呼' : '称呼待补充');
    }
  }
  if (override) {
    base.override = override;
    base.term = override.term.trim();
    base.source = 'override';
  }
  return base;
}
