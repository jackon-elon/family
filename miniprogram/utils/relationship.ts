import { Person, Relation } from '../services/api';
import { resolveKinship, Relation as KinshipRelation } from '../vendor/kinship';
import { birthDateForBirthday } from './birth-date';

export interface RelationshipView {
  label: string;
  path: string;
  missing?: string;
  alternatives?: string;
  status: 'self' | 'resolved' | 'pending' | 'unrelated';
}

/** Map the backend relation shape to the shared kinship engine. */
export function relationshipFor(people: Person[], relations: Relation[], perspectiveId: string, targetId: string): RelationshipView {
  const engineRelations: KinshipRelation[] = relations.map(r => {
    if (r.type === 'parent') return { type: 'parent_child', parentId: r.from, childId: r.to };
    if (r.type === 'spouse') return { type: 'spouse', personAId: r.from, personBId: r.to };
    return { type: 'sibling', personAId: r.from, personBId: r.to, olderPersonId: r.olderId, rankOfA: people.find(p => p.id === r.from)?.birthOrder, rankOfB: people.find(p => p.id === r.to)?.birthOrder };
  });
  const result = resolveKinship({
    people: people.map(p => ({ id: p.id, name: p.name, gender: p.gender || 'unknown', birthDate: birthDateForBirthday(p.birthday) })),
    relations: engineRelations,
    perspectiveId,
    targetId
  });
  const label = result.term || result.category || (result.status === 'unrelated' ? '关系待补充' : result.status === 'self' ? '我自己' : result.status === 'invalid' ? '关系待核对' : '称呼待补充');
  const path = result.path?.display || (result.status === 'self' ? '我' : result.status === 'unrelated' ? '暂无已记录的连接路径' : '关系路径待补充');
  const status = result.status === 'resolved' || result.status === 'self' || result.status === 'unrelated' ? result.status : 'pending';
  return { label, path, missing: result.missing.length ? result.missing.join('、') : result.status === 'invalid' ? result.reason : undefined, alternatives: result.alternatives?.join(' / '), status };
}
