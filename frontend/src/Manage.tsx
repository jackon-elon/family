import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  Plus,
  Search,
  UserPlus,
  Mail,
  Network,
  Settings2,
  Pencil,
  Trash2,
  Copy,
  Check,
  ShieldCheck,
  ChevronRight,
} from "lucide-react";
import QRCode from "qrcode";
import PersonSelect from "./components/PersonSelect";
import { errorText, rpc, requestId, uploadPhoto, uncertainResult } from "./api";
import { useApp } from "./app-context";
import { useCircle } from "./hooks";
import { Alert, Avatar, Empty, Loading, Modal } from "./components/UI";
import ProfileForm, {
  createFields,
  draftOf,
  patchOf,
} from "./components/ProfileForm";
import type {
  ApplicationView,
  CircleData,
  InviteView,
  PersonView,
  Relation,
} from "./types";
import { matchedReviewPerson, reviewMatchError } from "./shared/onboarding";
import { matchesPerson } from "./shared/person-search";

type RelationChoice = {
  mode: "" | "later" | "linked";
  anchorPersonId: string;
  kind: "newParent" | "newChild" | "spouse" | "sibling";
};
const emptyChoice = (): RelationChoice => ({
  mode: "",
  anchorPersonId: "",
  kind: "newChild",
});
function relationPayload(choice: RelationChoice) {
  if (choice.mode === "later") return { deferRelation: true };
  if (choice.mode !== "linked" || !choice.anchorPersonId)
    throw new Error("请选择与哪位家人的关系，或选择稍后补充。");
  return {
    initialRelation: {
      anchorPersonId: choice.anchorPersonId,
      kind: choice.kind,
    },
  };
}
function RelationChoiceFields({
  people,
  value,
  onChange,
  disabled = false,
  name = "新成员",
}: {
  people: PersonView[];
  value: RelationChoice;
  onChange: (value: RelationChoice) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <fieldset className="relation-choice" disabled={disabled}>
      <h3>与已有家人的关系</h3>
      <label>
        先如何记录
        <select
          required
          value={value.mode}
          onChange={(e) =>
            onChange({
              ...value,
              mode: e.target.value as RelationChoice["mode"],
            })
          }
        >
          <option value="">请选择</option>
          <option value="linked">现在连接家人关系</option>
          <option value="later">稍后补充关系</option>
        </select>
      </label>
      {value.mode === "linked" ? (
        <div className="form-grid">
          <PersonSelect
            people={people}
            label="已有家人"
            value={value.anchorPersonId}
            onChange={(anchorPersonId) =>
              onChange({ ...value, anchorPersonId })
            }
          />
          <label>
            {name}是 TA 的
            <select
              value={value.kind}
              onChange={(e) =>
                onChange({
                  ...value,
                  kind: e.target.value as RelationChoice["kind"],
                })
              }
            >
              <option value="newChild">子女</option>
              <option value="newParent">父母</option>
              <option value="spouse">配偶</option>
              <option value="sibling">兄弟姐妹</option>
            </select>
          </label>
        </div>
      ) : (
        value.mode === "later" && (
          <p className="hint">
            先记下完整资料，亲缘图会放入「关系待补充」。家人尚未注册也可先添加资料、再连接关系。
          </p>
        )
      )}
    </fieldset>
  );
}
interface AuditView {
  id: string;
  actorName: string;
  type: string;
  at: number;
}
export default function Manage() {
  const { circleId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPersonId = searchParams.get("relationFor");
  const returnToAlbum = searchParams.get("source") === "album";
  const { refresh, notify, confirmSensitive } = useApp();
  const { data, error: circleError, loading, load } = useCircle(circleId);
  const [tab, setTab] = useState<
      "people" | "invites" | "applications" | "relations" | "settings"
    >("people"),
    [search, setSearch] = useState(""),
    [relationSearch, setRelationSearch] = useState(""),
    [editing, setEditing] = useState<PersonView | "new" | null>(null),
    [relationEdit, setRelationEdit] = useState<Relation | "new" | null>(null),
    [applications, setApplications] = useState<ApplicationView[]>([]),
    [invites, setInvites] = useState<InviteView[]>([]),
    [events, setEvents] = useState<AuditView[]>([]),
    [extraLoading, setExtraLoading] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [newInvite, setNewInvite] = useState<InviteView | null>(null),
    [qr, setQr] = useState(""),
    [selectedApplication, setSelectedApplication] =
      useState<ApplicationView | null>(null),
    [target, setTarget] = useState(""),
    [now, setNow] = useState(Date.now());
  const lock = useRef(false),
    generation = useRef(0);
  const shortcutPerson =
    data && (data.circle.role === "owner" || data.circle.role === "admin")
      ? data.people.find((person) => person.id === requestedPersonId)
      : undefined;
  const closeRelation = () => {
    setRelationEdit(null);
    if (!requestedPersonId) return;
    if (returnToAlbum) {
      navigate(
        `/album/${encodeURIComponent(circleId!)}${shortcutPerson ? `?person=${encodeURIComponent(shortcutPerson.id)}` : ""}`,
        { replace: true },
      );
    } else {
      const next = new URLSearchParams(searchParams);
      next.delete("relationFor");
      next.delete("source");
      setSearchParams(next, { replace: true });
    }
  };
  useEffect(() => {
    if (shortcutPerson) setTab("relations");
  }, [shortcutPerson?.id]);
  const reloadExtra = useCallback(async () => {
    if (!circleId) return;
    const version = ++generation.current;
    setExtraLoading(true);
    setError("");
    try {
      const [a, i, l] = await Promise.all([
        rpc<{ applications: ApplicationView[] }>("join.list", { circleId }),
        rpc<{ invites: InviteView[] }>("invite.list", { circleId }),
        rpc<{ events: AuditView[] }>("audit.list", { circleId }),
      ]);
      if (version === generation.current) {
        setApplications(a.applications);
        setInvites(i.invites);
        setEvents(l.events);
      }
    } catch (e) {
      if (version === generation.current) setError(errorText(e));
    } finally {
      if (version === generation.current) setExtraLoading(false);
    }
  }, [circleId]);
  useEffect(() => {
    setNewInvite(null);
    setQr("");
    setEditing(null);
    setRelationEdit(null);
    setSelectedApplication(null);
    setApplications([]);
    setInvites([]);
    setEvents([]);
    setError("");
    setTab("people");
    setSearch("");
    setTarget("");
    return () => {
      generation.current++;
    };
  }, [circleId]);
  useEffect(() => {
    if (data && data.circle.role !== "member") reloadExtra();
  }, [data?.circle.id, data?.circle.role, reloadExtra]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const afterChange = async () => {
    await Promise.all([load(), reloadExtra(), refresh()]);
  };
  const mutate = async (fn: () => Promise<unknown>, message: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (!(await confirmSensitive(fn))) return;
      await afterChange();
      notify(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const createInvite = async () => {
    if (lock.current || !data) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNewInvite(null);
    setQr("");
    const version = generation.current;
    try {
      if (data.circle.mode !== "shared")
        await rpc("circle.upgrade", { circleId, privacyReviewed: true });
      const d = await rpc<{ invite: InviteView }>("invite.create", {
        circleId,
      });
      if (version !== generation.current) return;
      setNewInvite(d.invite);
      const url = new URL(`/invite/${d.invite.token}`, window.location.origin)
        .href;
      const image = await QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: "#34463c", light: "#ffffff" },
      });
      if (version !== generation.current) return;
      setQr(image);
      await reloadExtra();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (loading)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <Link to="/me" className="text-button">
          返回我的
        </Link>
        <Alert message={circleError} />
        <button className="button secondary" onClick={load}>
          重新加载
        </button>
      </div>
    );
  if (data.circle.role === "member")
    return (
      <div className="page">
        <Empty title="此页面仅供管理员使用">
          <Link className="button secondary" to={`/album/${circleId}`}>
            返回亲友录
          </Link>
        </Empty>
      </div>
    );
  const visiblePeople = data.people.filter((p) => matchesPerson(p, search));
  const visibleRelations = data.relations.filter(
    (r) =>
      !relationSearch.trim() ||
      data.people.some(
        (p) =>
          (p.id === r.from || p.id === r.to) &&
          [p.name, p.city].some((text) =>
            text?.includes(relationSearch.trim()),
          ),
      ),
  );
  const activeInvite = !!(
    newInvite?.token &&
    newInvite.expiresAt > now &&
    invites.some((i) => i.id === newInvite.id && i.status === "active")
  );
  const inviteLink = activeInvite
    ? new URL(`/invite/${newInvite!.token}`, window.location.origin).href
    : "";
  return (
    <div className="page manage-page">
      <Link to="/me" className="back text-button">
        ← 返回我的
      </Link>
      <header className="page-header">
        <div>
          <p className="eyebrow">管理亲友录</p>
          <h1>{data.circle.name}</h1>
          <p className="muted">
            {data.people.length} 位家人 · 资料、关系与相聚
          </p>
        </div>
        <Link className="button secondary" to={`/album/${circleId}`}>
          查看亲友录 <ChevronRight size={16} />
        </Link>
      </header>
      <Alert message={circleError || error} />
      {requestedPersonId && !shortcutPerson && (
        <Alert message="这位家人的资料已不存在或不属于本家庭，请重新选择家人。" />
      )}
      <div className="manage-tabs">
        <button
          disabled={busy}
          className={tab === "people" ? "active" : ""}
          onClick={() => setTab("people")}
        >
          <UserPlus size={17} />
          成员资料
        </button>
        <button
          disabled={busy}
          className={tab === "relations" ? "active" : ""}
          onClick={() => setTab("relations")}
        >
          <Network size={17} />
          亲属关系
        </button>
        <button
          disabled={busy}
          className={tab === "invites" ? "active" : ""}
          onClick={() => setTab("invites")}
        >
          <Mail size={17} />
          邀请
        </button>
        <button
          disabled={busy}
          className={tab === "applications" ? "active" : ""}
          onClick={() => setTab("applications")}
        >
          <Check size={17} />
          加入申请
          {applications.length > 0 && (
            <span className="count-badge">{applications.length}</span>
          )}
        </button>
        <button
          disabled={busy}
          className={tab === "settings" ? "active" : ""}
          onClick={() => setTab("settings")}
        >
          <Settings2 size={17} />
          管理设置
        </button>
      </div>
      {tab === "people" && (
        <section>
          <div className="section-heading">
            <label className="search-box">
              <Search size={17} />
              <input
                placeholder="搜索成员"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => setEditing("new")}
            >
              <Plus size={17} />
              添加家人
            </button>
          </div>
          <p className="section-hint">
            填写本人登录手机号，家人受邀加入后会对应到这份资料。
          </p>
          <div className="manage-person-list">
            {visiblePeople.map((p) => (
              <div key={p.id} className="manage-person-row">
                <Avatar person={p} />
                <div className="grow">
                  <h3>
                    {p.name}
                    {p.isSelf && <span className="self-tag">我</span>}
                  </h3>
                  <p>
                    {[p.city, p.occupation || p.school]
                      .filter(Boolean)
                      .join(" · ") || "近况待补充"}
                  </p>
                </div>
                <button
                  className="button secondary small-button"
                  disabled={busy}
                  onClick={() => setEditing(p)}
                >
                  <Pencil size={15} />
                  编辑
                </button>
              </div>
            ))}
          </div>
          {!visiblePeople.length && <Empty title="还没有匹配的成员" />}
        </section>
      )}
      {tab === "relations" && (
        <section>
          <div className="section-heading">
            <h2>
              已记录的关系 <span>{data.relations.length}</span>
            </h2>
            <button
              className="button primary"
              disabled={busy || data.people.length < 2}
              onClick={() => setRelationEdit("new")}
            >
              <Plus size={17} />
              添加关系
            </button>
          </div>
          <p className="section-hint">
            只需连接父母与子女、配偶、兄弟姐妹，其他亲属称呼会自动推算。
          </p>
          <label className="search-box">
            <Search size={17} />
            <input
              aria-label="查找亲属关系"
              placeholder="输入家人姓名或城市查关系"
              value={relationSearch}
              onChange={(e) => setRelationSearch(e.target.value)}
            />
          </label>
          <div className="relation-list">
            {visibleRelations.map((r) => {
              const from = data.people.find((p) => p.id === r.from),
                to = data.people.find((p) => p.id === r.to);
              return (
                <div key={r.id}>
                  <span>
                    <b>{from?.name || "家人"}</b> 是 <b>{to?.name || "家人"}</b>{" "}
                    的{" "}
                    <strong>
                      {r.type === "parent"
                        ? from?.gender === "female"
                          ? "母亲"
                          : from?.gender === "male"
                            ? "父亲"
                            : "父母"
                        : r.type === "spouse"
                          ? "配偶"
                          : "兄弟姐妹"}
                    </strong>
                  </span>
                  <div className="actions">
                    <button
                      className="icon-button"
                      aria-label={`修改${from?.name}与${to?.name}的关系`}
                      disabled={busy}
                      onClick={() => setRelationEdit(r)}
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      className="icon-button danger"
                      aria-label={`删除${from?.name}与${to?.name}的关系`}
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            `删除${from?.name}与${to?.name}的这条关系？人物资料会保留。`,
                          )
                        )
                          mutate(
                            () =>
                              rpc("relation.delete", {
                                circleId,
                                relationId: r.id,
                              }),
                            "关系已删除",
                          );
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {!data.relations.length && (
            <Empty title="从一条熟悉的关系开始">
              <p>例如：妈妈是我的母亲。以后随时可以补充。</p>
            </Empty>
          )}
          {!!data.relations.length && !visibleRelations.length && (
            <Empty title="没有找到匹配的关系">
              <p>换个姓名或城市试试；尚未连接的家人可以点击「添加关系」。</p>
            </Empty>
          )}
        </section>
      )}
      {tab === "invites" && (
        <section className="invite-panel">
          <div className="section-heading">
            <div>
              <h2>邀请大家相聚</h2>
              <p className="muted">发一个链接，或让家人扫二维码。</p>
            </div>
            <button
              className="button primary"
              disabled={busy}
              onClick={createInvite}
            >
              <Plus size={17} />
              {busy ? "生成中…" : "生成邀请"}
            </button>
          </div>
          <p className="soft-note">
            邀请 72 小时内有效，仅供一人加入。对方填好资料后，由管理员确认。
          </p>
          {activeInvite && (
            <div className="generated-invite">
              {qr && (
                <img
                  src={qr}
                  width="200"
                  height="200"
                  alt="扫码加入亲友录的二维码"
                />
              )}
              <div>
                <h3>把邀请发给熟悉的人</h3>
                <p>
                  有效期至{" "}
                  {new Date(newInvite!.expiresAt).toLocaleString("zh-CN")}
                </p>
                <input readOnly aria-label="邀请链接" value={inviteLink} />
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inviteLink);
                      notify("邀请链接已复制");
                    } catch {
                      setError("无法自动复制，请长按或选中上面的链接复制。");
                    }
                  }}
                >
                  <Copy size={16} />
                  复制邀请链接
                </button>
              </div>
            </div>
          )}
          {extraLoading ? (
            <Loading />
          ) : (
            <div className="invite-list">
              {invites
                .slice()
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .map((i) => (
                  <div key={i.id}>
                    <div>
                      <b>
                        {(
                          {
                            active: "可使用",
                            used: "已加入",
                            revoked: "已撤销",
                            expired: "已过期",
                          } as Record<string, string>
                        )[i.status] || i.status}
                      </b>
                      <p>
                        有效期至 {new Date(i.expiresAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    {i.status === "active" && (
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() =>
                          mutate(async () => {
                            await rpc("invite.revoke", {
                              circleId,
                              inviteId: i.id,
                            });
                            if (newInvite?.id === i.id) {
                              setNewInvite(null);
                              setQr("");
                            }
                          }, "邀请已撤销")
                        }
                      >
                        撤销邀请
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </section>
      )}
      {tab === "applications" && (
        <section>
          <div className="section-heading">
            <h2>加入申请</h2>
            <button
              className="text-button"
              disabled={busy || extraLoading}
              onClick={reloadExtra}
            >
              刷新
            </button>
          </div>
          {extraLoading ? (
            <Loading />
          ) : applications.length ? (
            <div className="review-list">
              {applications.map((a) => (
                <div key={a.id}>
                  <div>
                    <h3>
                      {a.name}
                      {a.phoneMatch?.status === "unique"
                        ? " · 本人申请加入"
                        : ""}
                    </h3>
                    {a.loginPhone && <p>登录手机号：{a.loginPhone}</p>}
                    <p>
                      {a.profile?.country} · {a.profile?.city}
                      {a.profile?.birthday
                        ? ` · ${a.profile.birthday.calendar === "lunar" ? "农历" : "阳历"}${a.profile.birthday.month}月${a.profile.birthday.day}日`
                        : ""}
                    </p>
                    {a.note && <p className="review-note">{a.note}</p>}
                    {reviewMatchError(a, data.people) && (
                      <p className="danger">
                        {reviewMatchError(a, data.people)}
                      </p>
                    )}
                    {a.inviteStatus !== "active" && (
                      <p className="danger">邀请已失效，请让对方使用新邀请。</p>
                    )}
                  </div>
                  <div className="actions">
                    <button
                      className="button secondary small-button"
                      disabled={busy}
                      onClick={() =>
                        mutate(
                          () =>
                            rpc("join.reject", {
                              circleId,
                              applicationId: a.id,
                            }),
                          "已拒绝申请",
                        )
                      }
                    >
                      不通过
                    </button>
                    <button
                      className="button primary small-button"
                      disabled={
                        busy ||
                        a.profileIncomplete ||
                        a.inviteStatus !== "active" ||
                        !!reviewMatchError(a, data.people)
                      }
                      onClick={() => setSelectedApplication(a)}
                    >
                      确认加入
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="暂无待确认的申请">
              <p>收到邀请的家人提交资料后，会出现在这里。</p>
            </Empty>
          )}
        </section>
      )}
      {tab === "settings" && (
        <section>
          <div className="section-heading">
            <h2>成员与管理员</h2>
          </div>
          <p className="section-hint">
            管理员可以添加成员、修改资料与关系、确认加入申请。
          </p>
          <div className="account-member-list">
            {data.members.map((m) => (
              <div key={m.id}>
                <div className="grow">
                  <b>
                    {m.name}
                    {m.isSelf && "（我）"}
                  </b>
                  <span>{m.role === "member" ? "成员" : "管理员"}</span>
                </div>
                {!m.isSelf && m.role !== "owner" && (
                  <div className="actions">
                    {data.circle.role === "owner" && (
                      <button
                        className="button secondary small-button"
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            () =>
                              rpc("member.setRole", {
                                circleId,
                                memberId: m.id,
                                role: m.role === "admin" ? "member" : "admin",
                              }),
                            m.role === "admin"
                              ? "已取消管理员"
                              : "已设为管理员",
                          )
                        }
                      >
                        {m.role === "admin" ? "取消管理员" : "设为管理员"}
                      </button>
                    )}
                    {(data.circle.role === "owner" || m.role === "member") && (
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              `移出「${m.name}」？取消成员权限，清除联系方式等私人资料，保留姓名与关系。知道家庭名称仍可游客浏览。`,
                            )
                          )
                            mutate(
                              () =>
                                rpc("member.remove", {
                                  circleId,
                                  memberId: m.id,
                                }),
                              "成员已移出",
                            );
                        }}
                      >
                        移出成员
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {data.circle.role === "owner" && (
            <details className="settings-details">
              <summary>移交整本记录的管理</summary>
              <p className="hint">
                由另一位成员成为创建者，接手设置管理员、后续移交等管理。需要对方确认。
              </p>
              {data.ownerTransfer ? (
                <div className="transfer-notice">
                  <p>已邀请 {data.ownerTransfer.targetName} 接手，等待确认。</p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        () =>
                          rpc("circle.cancelOwnerTransfer", {
                            circleId,
                            transferId: data.ownerTransfer!.id,
                          }),
                        "已取消移交",
                      )
                    }
                  >
                    取消移交
                  </button>
                </div>
              ) : (
                <div className="actions transfer-form">
                  <select
                    value={target}
                    disabled={busy}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">选择接手成员</option>
                    {data.members
                      .filter((m) => !m.isSelf)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                  <button
                    className="button secondary"
                    disabled={busy || !target}
                    onClick={() =>
                      mutate(
                        () =>
                          rpc("circle.transferOwner", {
                            circleId,
                            memberId: target,
                          }),
                        "已发出移交邀请",
                      )
                    }
                  >
                    邀请接手
                  </button>
                </div>
              )}
              {data.members.length < 2 && (
                <p className="hint">先邀请另一位成员加入，再移交管理。</p>
              )}
            </details>
          )}
          <details className="settings-details">
            <summary>操作记录</summary>
            <div className="audit-list">
              {events.map((e) => (
                <div key={e.id}>
                  <span>
                    {e.actorName} · {auditText(e.type)}
                  </span>
                  <time>{new Date(e.at).toLocaleString("zh-CN")}</time>
                </div>
              ))}
            </div>
          </details>
        </section>
      )}
      {editing && (
        <PersonEditor
          person={editing === "new" ? undefined : editing}
          data={data}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await afterChange();
            notify("成员资料已保存");
          }}
        />
      )}
      {(relationEdit || shortcutPerson) && (
        <RelationEditor
          key={
            relationEdit && relationEdit !== "new"
              ? relationEdit.id
              : shortcutPerson?.id || "new"
          }
          data={data}
          relation={
            !relationEdit || relationEdit === "new" ? undefined : relationEdit
          }
          initialPersonId={shortcutPerson?.id}
          onClose={closeRelation}
          onSaved={async () => {
            setRelationEdit(null);
            await afterChange();
            notify("亲属关系已保存");
            closeRelation();
          }}
        />
      )}
      {selectedApplication && (
        <ReviewApplication
          application={selectedApplication}
          data={data}
          onClose={() => setSelectedApplication(null)}
          onSaved={async () => {
            setSelectedApplication(null);
            await afterChange();
            notify("已确认加入");
          }}
        />
      )}
    </div>
  );
}
function PersonEditor({
  person,
  data,
  onClose,
  onSaved,
}: {
  person?: PersonView;
  data: CircleData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { confirmSensitive } = useApp();
  const [draft, setDraft] = useState(() => draftOf(person)),
    [photo, setPhoto] = useState(""),
    [photoPreparing, setPhotoPreparing] = useState(false),
    [choice, setChoice] = useState(emptyChoice),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const savedId = useRef(person?.id || ""),
    idempotency = useRef<{
      id: string;
      fingerprint: string;
      payload?: Record<string, unknown>;
    }>({ id: requestId(), fingerprint: "" }),
    lock = useRef(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current || photoPreparing) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const patch = patchOf(draft);
      if (!savedId.current) {
        const payload = idempotency.current.payload || {
          circleId: data.circle.id,
          ...createFields(draft),
          ...(data.people.length ? relationPayload(choice) : {}),
        };
        const fingerprint = JSON.stringify(payload);
        if (
          idempotency.current.fingerprint &&
          idempotency.current.fingerprint !== fingerprint
        )
          idempotency.current.id = requestId();
        idempotency.current.fingerprint = fingerprint;
        idempotency.current.payload = payload;
        const result = await rpc<{ person: PersonView }>("person.create", {
          ...payload,
          requestId: idempotency.current.id,
        });
        savedId.current = result.person.id;
        setUncertain(false);
      }
      await rpc("person.update", {
        circleId: data.circle.id,
        personId: savedId.current,
        patch,
      });
      if (photo) {
        await uploadPhoto(photo, {
          circleId: data.circle.id,
          personId: savedId.current,
        });
        setPhoto("");
      }
      await onSaved();
    } catch (err) {
      const unknown = !savedId.current && uncertainResult(err);
      setUncertain(unknown);
      if (!unknown && !savedId.current) idempotency.current.payload = undefined;
      setError(
        unknown
          ? "暂未收到添加结果。请保持本次内容并重试，系统会确认是否已添加。"
          : errorText(err),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title={person ? `编辑 ${person.name}` : "添加家人"}
      onClose={onClose}
      busy={busy || photoPreparing}
      wide
    >
      <form onSubmit={submit}>
        <ProfileForm
          value={draft}
          onChange={setDraft}
          disabled={busy || photoPreparing || uncertain}
          photoUrl={person?.photoUrl}
          photoBase64={photo}
          onPhoto={setPhoto}
          onPhotoPreparing={setPhotoPreparing}
        />
        {!person && data.people.length > 0 && (
          <RelationChoiceFields
            people={data.people}
            value={choice}
            onChange={setChoice}
            disabled={busy || uncertain || !!savedId.current}
            name={draft.name || "新成员"}
          />
        )}
        <Alert message={error} />
        <div className="modal-actions">
          {person &&
            !person.isClaimed &&
            !data.relations.some(
              (r) => r.from === person.id || r.to === person.id,
            ) && (
              <button
                type="button"
                className="text-button danger delete-person"
                disabled={busy || photoPreparing}
                onClick={async () => {
                  if (!confirm(`确定删除「${person.name}」的资料？`)) return;
                  setBusy(true);
                  try {
                    if (
                      !(await confirmSensitive(() =>
                        rpc("person.delete", {
                          circleId: data.circle.id,
                          personId: person.id,
                        }),
                      ))
                    )
                      return;
                    await onSaved();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                删除资料
              </button>
            )}
          <button
            type="button"
            className="button secondary"
            disabled={busy || photoPreparing}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || photoPreparing}
          >
            {photoPreparing ? "正在处理照片…" : busy ? "保存中…" : "保存资料"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function relationEdge(
  from: string,
  to: string,
  type: Relation["type"] | "child" | "",
) {
  if (!type || !from || !to || from === to)
    throw new Error("请选择两位家人和他们的关系。");
  return type === "child"
    ? { from: to, to: from, type: "parent" }
    : { from, to, type };
}
export function RelationEditor({
  data,
  relation,
  initialPersonId,
  onClose,
  onSaved,
}: {
  data: CircleData;
  relation?: Relation;
  initialPersonId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [from, setFrom] = useState(relation?.from || initialPersonId || ""),
    [to, setTo] = useState(relation?.to || ""),
    [type, setType] = useState<Relation["type"] | "child" | "">(
      relation?.type || "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={
        relation
          ? "修改亲属关系"
          : initialPersonId
            ? "补充亲属关系"
            : "添加亲属关系"
      }
      onClose={onClose}
      busy={busy}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const edge = relationEdge(from, to, type);
            await rpc(
              relation ? "relation.replace" : "relation.create",
              relation
                ? {
                    circleId: data.circle.id,
                    relationId: relation.id,
                    relation: edge,
                  }
                : { circleId: data.circle.id, ...edge },
            );
            await onSaved();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <PersonSelect
            people={data.people}
            label="这位家人"
            value={from}
            onChange={setFrom}
            excludeId={to}
          />
          <label>
            是下面这位家人的
            <select
              required
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
            >
              <option value="">请选择关系</option>
              <option value="parent">父母</option>
              <option value="child">子女</option>
              <option value="spouse">配偶</option>
              <option value="sibling">兄弟姐妹</option>
            </select>
          </label>
          <PersonSelect
            people={data.people}
            label="关系对象"
            value={to}
            onChange={setTo}
            excludeId={from}
          />
        </fieldset>
        {from && to && type && (
          <p className="relation-preview">
            {data.people.find((p) => p.id === from)?.name} 是{" "}
            {data.people.find((p) => p.id === to)?.name} 的{" "}
            {type === "parent"
              ? "父母"
              : type === "child"
                ? "子女"
                : type === "spouse"
                  ? "配偶"
                  : "兄弟姐妹"}
          </p>
        )}
        <p className="hint">
          父亲、母亲根据资料性别区分，长幼根据出生日期计算。系统会检查循环与矛盾关系。
        </p>
        <Alert message={error} />
        <button
          className="button primary full"
          disabled={busy || !type || !from || !to || from === to}
        >
          {busy ? "保存中…" : "保存关系"}
        </button>
      </form>
    </Modal>
  );
}
export function ReviewApplication({
  application,
  data,
  onClose,
  onSaved,
}: {
  application: ApplicationView;
  data: CircleData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const matchedPerson = matchedReviewPerson(application, data.people);
  const phoneMatched = application.phoneMatch?.status === "unique";
  const matchError = reviewMatchError(application, data.people);
  const [choice, setChoice] = useState(emptyChoice),
    [mode, setMode] = useState(phoneMatched ? "existing" : "new"),
    [existing, setExisting] = useState(matchedPerson?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const candidates = data.people.filter((person) => !person.isClaimed);
  const selectedPerson = candidates.find((person) => person.id === existing);
  const birthdayText = (birthday?: PersonView["birthday"]) =>
    birthday
      ? `${birthday.calendar === "lunar" ? "农历" : "阳历"} ${birthday.year ? `${birthday.year}年` : ""}${birthday.leapMonth ? "闰" : ""}${birthday.month}月${birthday.day}日`
      : "生日待补充";
  return (
    <Modal
      title={`确认 ${application.name} 加入`}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            if (matchError) throw new Error(matchError);
            const target = candidates.find((p) => p.id === existing);
            if (mode === "existing" && !target)
              throw new Error("请选择已有的家人资料。");
            await rpc("join.approve", {
              circleId: data.circle.id,
              applicationId: application.id,
              reviewToken: application.reviewToken,
              ...(mode === "existing"
                ? {
                    targetPersonId: target?.id,
                    targetPersonUpdatedAt: target?.updatedAt,
                  }
                : data.people.length
                  ? relationPayload(choice)
                  : {}),
            });
            await onSaved();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="soft-note">
          <p className="eyebrow">申请人资料</p>
          <b>{application.name}</b>
          {application.loginPhone && (
            <p>登录手机号：{application.loginPhone}</p>
          )}
          <p>
            {[application.profile?.country, application.profile?.city]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p>{birthdayText(application.profile?.birthday)}</p>
          {application.note && <p>{application.note}</p>}
        </div>
        <fieldset disabled={busy}>
          {phoneMatched ? (
            <div className="soft-note">
              <b>{matchedPerson?.name || application.name} 本人加入</b>
              <p>
                登录手机号与这份家人资料一致。确认后沿用已有资料与亲属关系，不重复添加人物。
              </p>
            </div>
          ) : (
            <label>
              如何加入
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="new">添加为新成员</option>
                <option value="existing" disabled={!candidates.length}>
                  使用已有的这位家人资料
                  {!candidates.length ? "（暂无可选资料）" : ""}
                </option>
              </select>
            </label>
          )}
          {mode === "existing" ? (
            <>
              {!phoneMatched && (
                <label>
                  选择已有资料
                  <select
                    required
                    value={existing}
                    onChange={(e) => setExisting(e.target.value)}
                  >
                    <option value="">选择人物</option>
                    {candidates.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.city ? ` · ${p.city}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selectedPerson && (
                <div className="soft-note">
                  <p className="eyebrow">已有资料 · 确认是同一人</p>
                  <b>{selectedPerson.name}</b>
                  <p>
                    {[selectedPerson.country, selectedPerson.city]
                      .filter(Boolean)
                      .join(" · ") || "城市待补充"}
                  </p>
                  <p>{birthdayText(selectedPerson.birthday)}</p>
                  <p className="hint">
                    确认后沿用这个人物及亲属关系，个人资料使用申请人的最新信息，不重复添加。
                  </p>
                </div>
              )}
              <p className="alert">
                请核对姓名、登录手机号、城市和生日，确认申请人是这位家人本人。
              </p>
            </>
          ) : (
            data.people.length > 0 && (
              <RelationChoiceFields
                people={data.people}
                value={choice}
                onChange={setChoice}
                name={application.name}
                disabled={busy}
              />
            )
          )}
        </fieldset>
        <Alert message={error || matchError} />
        <button
          className="button primary full"
          disabled={busy || !!matchError || (mode === "existing" && !existing)}
        >
          {busy ? "正在确认…" : "确认加入"}
        </button>
      </form>
    </Modal>
  );
}
function auditText(type: string) {
  const map: Record<string, string> = {
    "circle.create": "创建亲友录",
    "circle.upgrade": "开启邀请",
    "person.create": "添加成员资料",
    "person.update": "修改成员资料",
    "person.delete": "删除成员资料",
    "person.photo": "更新照片",
    "relation.create": "添加亲属关系",
    "relation.replace": "修改亲属关系",
    "relation.delete": "删除亲属关系",
    "invite.create": "生成邀请",
    "invite.revoke": "撤销邀请",
    "join.apply": "申请加入",
    "join.approve": "确认加入",
    "join.reject": "未通过加入申请",
    "member.setRole": "调整管理员",
    "member.remove": "移出成员",
    "member.leave": "退出亲友录",
    "circle.transferRequested": "邀请接手管理",
    "circle.transferAccepted": "接手管理",
    "circle.transferCancelled": "取消移交",
    "circle.transferRejected": "婉拒移交",
  };
  return map[type] || "更新记录";
}
