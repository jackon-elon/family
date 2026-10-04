import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorText, rpc, withPhotos } from "./api";
import type {
  CircleData,
  CircleView,
  MemberView,
  OwnerTransfer,
  PersonView,
  Relation,
} from "./types";
export function useCircle(circleId: string | undefined) {
  const [data, setData] = useState<CircleData | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (!circleId) return;
    const version = ++generation.current;
    setLoading(true);
    setError("");
    setData(null);
    try {
      const detailPromise = rpc<{
        circle: CircleView;
        ownerTransfer: OwnerTransfer | null;
      }>("circle.detail", { circleId }).then((detail) => {
        if (detail.circle.type !== "family")
          throw new ApiError("这本记录暂不可用，请返回亲友录。", "NOT_FOUND");
        return detail;
      });
      const [detail, persons, relations, remarks, members] = await Promise.all([
        detailPromise,
        rpc<{ persons: PersonView[] }>("person.list", { circleId }),
        detailPromise.then(() =>
          rpc<{ relations: Relation[] }>("relation.list", { circleId }),
        ),
        rpc<{ remarks: Record<string, string> }>("person.remark.list", {
          circleId,
        }),
        rpc<{ members: MemberView[] }>("member.list", { circleId }),
      ]);
      let people = persons.persons;
      try {
        people = await withPhotos(circleId, people);
      } catch (err) {
        if (version === generation.current)
          setError(`资料已加载，照片暂时不可用：${errorText(err)}`);
      }
      if (version === generation.current)
        setData({
          circle: detail.circle,
          ownerTransfer: detail.ownerTransfer,
          people,
          relations: relations.relations,
          remarks: remarks.remarks,
          members: members.members,
        });
    } catch (err) {
      if (version === generation.current) setError(errorText(err));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [circleId]);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return { data, error, loading, load, setData };
}
