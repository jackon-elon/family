import type {
  Person as StoredPerson,
  Relation as StoredRelation,
} from "../../../backend/src/model";
export type Person = Pick<
  StoredPerson,
  "id" | "name" | "gender" | "birthday" | "birthOrder"
>;
export type Relation = Pick<StoredRelation, "from" | "to" | "type" | "olderId">;
import {
  resolveKinship,
  resolveKinships,
  type KinshipResult,
  type Relation as KinshipRelation,
} from "../../../packages/kinship/src/index";
import { birthDateForBirthday } from "./birth-date";

export interface RelationshipView {
  label: string;
  path: string;
  missing?: string;
  alternatives?: string;
  status: "self" | "resolved" | "pending" | "unrelated";
}

/** Map the backend relation shape to the shared kinship engine. */
function engineInput(
  people: Person[],
  relations: Relation[],
  perspectiveId: string,
) {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const engineRelations: KinshipRelation[] = relations.map((r) => {
    if (r.type === "parent")
      return { type: "parent_child", parentId: r.from, childId: r.to };
    if (r.type === "spouse")
      return { type: "spouse", personAId: r.from, personBId: r.to };
    return {
      type: "sibling",
      personAId: r.from,
      personBId: r.to,
      olderPersonId: r.olderId,
      rankOfA: peopleById.get(r.from)?.birthOrder,
      rankOfB: peopleById.get(r.to)?.birthOrder,
    };
  });
  return {
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      gender: p.gender || "unknown",
      birthDate: birthDateForBirthday(p.birthday),
    })),
    relations: engineRelations,
    perspectiveId,
  };
}

export function relationshipFor(
  people: Person[],
  relations: Relation[],
  perspectiveId: string,
  targetId: string,
): RelationshipView {
  return relationshipView(
    resolveKinship({
      ...engineInput(people, relations, perspectiveId),
      targetId,
    }),
  );
}

export function relationshipsFor(
  people: Person[],
  relations: Relation[],
  perspectiveId: string,
): Record<string, RelationshipView> {
  return Object.fromEntries(
    Object.entries(
      resolveKinships(engineInput(people, relations, perspectiveId)),
    ).map(([id, result]) => [id, relationshipView(result)]),
  );
}

function relationshipView(result: KinshipResult): RelationshipView {
  const label =
    result.term ||
    result.category ||
    (result.status === "unrelated"
      ? "关系待补充"
      : result.status === "self"
        ? "我自己"
        : result.status === "invalid"
          ? "关系待核对"
          : result.status === "ambiguous"
            ? "关系待核对"
            : result.path?.steps.map((step) => step.label).join("的") ||
              "亲属");
  const path =
    result.path?.display ||
    (result.status === "self"
      ? "我"
      : result.status === "unrelated"
        ? "暂无已记录的连接路径"
        : "关系路径待补充");
  const status =
    result.status === "resolved" ||
    result.status === "self" ||
    result.status === "unrelated"
      ? result.status
      : "pending";
  return {
    label,
    path,
    missing: result.missing.length
      ? `还缺少：${result.missing.join("、")}`
      : result.status === "invalid"
        ? result.reason
        : result.status === "ambiguous"
          ? "记录中存在多种关系路径，需要核对后确定称呼。"
          : result.status === "pending" && !result.term && !result.category
            ? "已记录关系，暂未匹配到称呼，先显示关系路径。"
            : undefined,
    alternatives: result.alternatives?.join(" / "),
    status,
  };
}
