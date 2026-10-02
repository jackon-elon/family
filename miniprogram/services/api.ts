/*
 * The only data entry point used by pages. The demo adapter is intentionally
 * stateful, so the same screens can be tried without an AppID or CloudBase.
 * In production set demo mode to false and deploy cloudfunctions/api.
 */
import { CLOUD_ENV_ID } from '../config';
export type CircleType = 'family' | 'classmate';
export type Role = 'owner' | 'admin' | 'member';
export type Visibility = 'self' | 'circle';

export interface Circle {
  id: string;
  type: CircleType;
  name: string;
  mode: 'private' | 'shared';
  school?: string;
  cohort?: string;
  className?: string;
  role?: Role;
  memberCount?: number;
}

export interface Person {
  id: string;
  circleId: string;
  name: string;
  nickname?: string;
  gender?: 'male' | 'female' | 'unknown';
  /** Rank among siblings of the same gender and same parents. */
  birthOrder?: number;
  country?: string;
  province?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  status?: string;
  industry?: string;
  occupation?: string;
  school?: string;
  bio?: string;
  phone?: string;
  wechatId?: string;
  photoFileId?: string;
  photoUrl?: string;
  hasPhoto?: boolean;
  visibility?: Record<string, Visibility>;
  isSelf?: boolean;
  isClaimed?: boolean;
  updatedAt?: number;
  delegations?: Delegation[];
  myDelegatedFields?: string[];
  claimedBy?: string; // Demo storage only; never returned to pages.
}

export interface Relation {
  id: string;
  circleId: string;
  from: string;
  to: string;
  type: 'parent' | 'spouse' | 'sibling';
  olderId?: string;
}

export interface RelationInput { from: string; to: string; type: Relation['type']; olderId?: string }
export interface RelationChange { removeRelationId?: string; relation?: RelationInput }
export interface RelationImpact { removedRelationIds: string[]; createdRelationIds: string[]; affectedPersonIds: string[] }

export interface Member {
  id: string;
  circleId: string;
  name?: string;
  role: Role;
  personId?: string;
  status?: string;
  actorId?: string; // Demo storage only.
  isSelf?: boolean;
}

export interface Invite {
  id: string;
  circleId: string;
  token: string;
  expiresAt: number;
  revokedAt?: number;
  usedAt?: number;
}

export interface JoinApplication {
  id: string;
  circleId: string;
  inviteId: string;
  applicantName: string;
  name?: string;
  note?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalid';
  createdAt: number;
  circleName?: string;
  circleType?: CircleType;
  inviteStatus?: 'active' | 'expired' | 'revoked' | 'used' | 'missing';
  inviteExpiresAt?: number;
  actorId?: string; // Demo storage only; never returned to pages.
}

export interface Delegation {
  id: string;
  circleId: string;
  personId: string;
  adminMemberId: string;
  fields: string[];
  active?: boolean;
  revokedAt?: number;
}
export interface AuditEvent { id: string; circleId: string; type: string; targetId: string; at: number; actorName?: string; details?: Record<string, unknown> }

export interface Suggestion { id: string; circleId: string; type: 'person' | 'relation' | 'invite'; personId?: string; message: string; relationChange?: RelationChange; status: 'pending' | 'accepted' | 'rejected'; createdAt: number; createdBy?: string }
export interface ClaimRequest { id: string; circleId: string; personId: string; personName?: string; applicantName: string; status: 'pending' | 'approved' | 'rejected'; createdAt: number; actorId?: string }

export interface ApiError { code: string; message: string }
export type ApiResult<T = any> = { ok: true; data: T } | { ok: false; error: ApiError };

const MODE_KEY = 'kin-network-demo-mode';
const DB_KEY = 'kin-network-demo-db-v2';
const DEMO_ACTOR = 'demo-owner';
class DemoStorageError extends Error {}

function storageGet(key: string): any {
  try { return wx.getStorageSync(key); } catch (_) { return undefined; }
}
function storageSet(key: string, value: any): void {
  try { wx.setStorageSync(key, value); }
  catch (_) { throw new DemoStorageError('本机演示资料存储空间不足，操作没有保存'); }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function good<T>(data: T): ApiResult<T> { return { ok: true, data }; }
function bad(code: string, message: string): ApiResult<any> { return { ok: false, error: { code, message } }; }
function uid(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export function isDemoMode(): boolean { return !CLOUD_ENV_ID || storageGet(MODE_KEY) !== false; }
export function setDemoMode(enabled: boolean): boolean {
  if (!enabled && (!CLOUD_ENV_ID || !wx.cloud || !wx.cloud.callFunction)) return false;
  try {
    if (!enabled && wx.cloud.init) wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
    storageSet(MODE_KEY, enabled);
    return true;
  } catch (_) { return false; }
}

interface DemoDb {
  circles: Circle[];
  persons: Person[];
  relations: Relation[];
  members: Member[];
  invites: Invite[];
  applications: JoinApplication[];
  delegations: Delegation[];
  suggestions: Suggestion[];
  claimRequests: ClaimRequest[];
  audits: AuditEvent[];
}

function seedDb(): DemoDb {
  const now = Date.now();
  const circleVisible = { city: 'circle', photoFileId: 'circle', school: 'circle', industry: 'circle', status: 'circle', occupation: 'circle', bio: 'circle', phone: 'self', wechatId: 'self' } as Record<string, Visibility>;
  return {
    circles: [
      { id: 'family_demo', type: 'family', name: '陈家的小圈子', mode: 'shared', role: 'owner', memberCount: 3 },
      { id: 'class_demo', type: 'classmate', name: '青禾中学 · 高三二班', mode: 'shared', school: '青禾中学', cohort: '2017 届', className: '高三二班', role: 'owner', memberCount: 4 }
    ],
    persons: [
      { id: 'f_me', circleId: 'family_demo', name: '陈小满', gender: 'female', country: '中国', province: '上海', city: '上海', status: '工作中', industry: '互联网', occupation: '产品设计', bio: '喜欢在不同城市见到家人。', phone: '13800000000', wechatId: 'xiaoman_demo', visibility: clone(circleVisible), claimedBy: DEMO_ACTOR, updatedAt: now },
      { id: 'f_dad', circleId: 'family_demo', name: '陈志远', gender: 'male', birthOrder: 2, country: '中国', province: '北京', city: '北京', status: '工作中', industry: '教育', occupation: '教师', visibility: clone(circleVisible), claimedBy: 'demo-dad', updatedAt: now - 86400000 * 8 },
      { id: 'f_mom', circleId: 'family_demo', name: '林慧', gender: 'female', birthOrder: 2, country: '中国', province: '浙江', city: '杭州', status: '工作中', industry: '医疗', occupation: '护士', visibility: clone(circleVisible), claimedBy: 'demo-mom', updatedAt: now - 86400000 * 14 },
      { id: 'f_uncle', circleId: 'family_demo', name: '陈志国', gender: 'male', birthOrder: 1, country: '中国', province: '广东', city: '广州', status: '退休', industry: '制造业', visibility: { city: 'circle', industry: 'circle' }, updatedAt: now - 86400000 * 60 },
      { id: 'f_aunt', circleId: 'family_demo', name: '林芳', gender: 'female', birthOrder: 1, country: '美国', province: '加利福尼亚州', city: '旧金山', status: '工作中', industry: '餐饮', visibility: { city: 'circle', industry: 'circle', status: 'circle' }, claimedBy: 'demo-aunt', updatedAt: now - 86400000 * 25 },
      { id: 'f_grandma', circleId: 'family_demo', name: '周桂兰', gender: 'female', country: '中国', province: '江苏', city: '苏州', visibility: { city: 'circle' }, updatedAt: now - 86400000 * 99 },
      { id: 'f_cousin', circleId: 'family_demo', name: '陈雨晴', gender: 'female', country: '中国', province: '四川', city: '成都', status: '工作中', industry: '设计', visibility: { city: 'circle', industry: 'circle' }, updatedAt: now - 86400000 * 3 },
      { id: 'c_me', circleId: 'class_demo', name: '陈小满', nickname: '满满', gender: 'female', country: '中国', province: '上海', city: '上海', status: '工作中', industry: '互联网', occupation: '产品设计', school: '青禾中学', visibility: clone(circleVisible), claimedBy: DEMO_ACTOR, updatedAt: now },
      { id: 'c_zhao', circleId: 'class_demo', name: '赵乐', gender: 'male', country: '中国', province: '四川', city: '成都', status: '工作中', industry: '游戏', occupation: '策划', visibility: clone(circleVisible), claimedBy: 'demo-zhao', updatedAt: now - 86400000 * 2 },
      { id: 'c_wang', circleId: 'class_demo', name: '王宁', gender: 'female', country: '英国', city: '伦敦', latitude: 51.5, longitude: -0.1, status: '读书中', industry: '学术', school: '伦敦大学学院', visibility: clone(circleVisible), claimedBy: 'demo-wang', updatedAt: now - 86400000 * 10 },
      { id: 'c_li', circleId: 'class_demo', name: '李航', gender: 'male', country: '加拿大', city: '多伦多', status: '工作中', industry: '金融', visibility: clone(circleVisible), claimedBy: 'demo-li', updatedAt: now - 86400000 * 15 },
      { id: 'c_sun', circleId: 'class_demo', name: '孙妍', gender: 'female', status: '工作中', industry: '法律', visibility: { city: 'self', industry: 'circle' }, updatedAt: now - 86400000 * 28 }
    ],
    relations: [
      { id: 'r1', circleId: 'family_demo', from: 'f_dad', to: 'f_me', type: 'parent' },
      { id: 'r2', circleId: 'family_demo', from: 'f_mom', to: 'f_me', type: 'parent' },
      { id: 'r3', circleId: 'family_demo', from: 'f_dad', to: 'f_mom', type: 'spouse' },
      { id: 'r4', circleId: 'family_demo', from: 'f_grandma', to: 'f_dad', type: 'parent' },
      { id: 'r5', circleId: 'family_demo', from: 'f_uncle', to: 'f_dad', type: 'sibling', olderId: 'f_uncle' },
      { id: 'r6', circleId: 'family_demo', from: 'f_aunt', to: 'f_mom', type: 'sibling', olderId: 'f_aunt' },
      { id: 'r7', circleId: 'family_demo', from: 'f_uncle', to: 'f_cousin', type: 'parent' }
    ],
    members: [
      { id: 'm_f_self', circleId: 'family_demo', name: '陈小满', role: 'owner', personId: 'f_me', status: 'joined', actorId: DEMO_ACTOR },
      { id: 'm_f_dad', circleId: 'family_demo', name: '陈志远', role: 'member', personId: 'f_dad', status: 'joined', actorId: 'demo-dad' },
      { id: 'm_f_mom', circleId: 'family_demo', name: '林慧', role: 'member', personId: 'f_mom', status: 'joined', actorId: 'demo-mom' },
      { id: 'm_f_aunt', circleId: 'family_demo', name: '林芳', role: 'member', personId: 'f_aunt', status: 'joined', actorId: 'demo-aunt' },
      { id: 'm_c_self', circleId: 'class_demo', name: '陈小满', role: 'owner', personId: 'c_me', status: 'joined', actorId: DEMO_ACTOR },
      { id: 'm_c_zhao', circleId: 'class_demo', name: '赵乐', role: 'member', personId: 'c_zhao', status: 'joined', actorId: 'demo-zhao' },
      { id: 'm_c_wang', circleId: 'class_demo', name: '王宁', role: 'member', personId: 'c_wang', status: 'joined', actorId: 'demo-wang' },
      { id: 'm_c_li', circleId: 'class_demo', name: '李航', role: 'member', personId: 'c_li', status: 'joined', actorId: 'demo-li' }
    ],
    invites: [],
    applications: [],
    delegations: [],
    suggestions: [],
    claimRequests: [],
    audits: [
      { id: 'audit_family_seed', circleId: 'family_demo', type: 'circle.create', targetId: 'family_demo', at: now - 86400000 * 120 },
      { id: 'audit_class_seed', circleId: 'class_demo', type: 'circle.create', targetId: 'class_demo', at: now - 86400000 * 95 }
    ]
  };
}

function loadDb(): DemoDb {
  const stored = storageGet(DB_KEY);
  if (stored && stored.circles && stored.persons) {
    stored.suggestions = stored.suggestions || [];
    stored.claimRequests = stored.claimRequests || [];
    stored.delegations = stored.delegations || [];
    stored.audits = stored.audits || [];
    return stored as DemoDb;
  }
  const db = seedDb();
  storageSet(DB_KEY, db);
  return db;
}
function saveDb(db: DemoDb): void { storageSet(DB_KEY, db); }
function recordAudit(db: DemoDb, circleId: string, type: string, targetId: string, details?: Record<string, unknown>): void {
  const actor = db.members.find(member => member.circleId === circleId && member.actorId === DEMO_ACTOR && member.status === 'joined');
  db.audits.push({ id: uid('audit'), circleId, type, targetId, at: Date.now(), actorName: actor?.name || '当前成员', details });
}
export function resetDemoData(): boolean {
  try { storageSet(DB_KEY, seedDb()); return true; }
  catch (_) { return false; }
}

function roleFor(db: DemoDb, circleId: string): Role | undefined {
  const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
  return member && member.role;
}
function isAdmin(role?: Role): boolean { return role === 'owner' || role === 'admin'; }
function getCircle(db: DemoDb, id: string): Circle | undefined { return db.circles.find(c => c.id === id); }
function visiblePerson(raw: Person): Person {
  const p = clone(raw);
  const self = raw.claimedBy === DEMO_ACTOR;
  const db = loadDb();
  const actorMember = db.members.find(m => m.circleId === raw.circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
  const delegation = db.delegations.find(d => d.personId === raw.id && d.adminMemberId === actorMember?.id && d.active);
  const delegatedFields = delegation ? effectiveDelegationFields(delegation.fields) : [];
  p.isSelf = self;
  p.isClaimed = !!raw.claimedBy;
  delete p.claimedBy;
  if (!self) {
    const restricted: Record<string, string> = { city: 'city', country: 'city', province: 'city', latitude: 'city', longitude: 'city', photoFileId: 'photoFileId', photoUrl: 'photoFileId', school: 'school', industry: 'industry', occupation: 'occupation', status: 'status', bio: 'bio', phone: 'phone', wechatId: 'wechatId' };
    Object.keys(restricted).forEach(field => {
      const visibilityKey = restricted[field];
      if ((!raw.claimedBy || !raw.visibility || raw.visibility[visibilityKey] !== 'circle') && delegatedFields.indexOf(visibilityKey) < 0) delete (p as any)[field];
    });
    delete p.visibility;
    delete p.delegations;
    if (delegatedFields.length) p.myDelegatedFields = delegatedFields;
  } else {
    p.delegations = db.delegations.filter(d => d.personId === raw.id && d.active);
  }
  p.hasPhoto = !!(p.photoFileId || p.photoUrl);
  delete p.photoFileId;
  return p;
}
function effectiveDelegationFields(fields: string[]): string[] {
  return fields.indexOf('city') >= 0 ? [...new Set(fields.concat(['country', 'province', 'latitude', 'longitude']))] : fields;
}
function requireMember(db: DemoDb, circleId: string): ApiResult<any> | null {
  if (!getCircle(db, circleId)) return bad('NOT_FOUND', '这个圈子不存在');
  if (!roleFor(db, circleId)) return bad('FORBIDDEN', '你还不是这个圈子的成员');
  return null;
}
function requireAdmin(db: DemoDb, circleId: string): ApiResult<any> | null {
  const access = requireMember(db, circleId);
  if (access) return access;
  if (!isAdmin(roleFor(db, circleId))) return bad('FORBIDDEN', '只有管理员可以执行此操作');
  return null;
}

function samePair(a: RelationInput, b: RelationInput): boolean {
  return (a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);
}

/** Mirror the cloud service's graph safeguards in local demo mode. */
function previewDemoRelation(db: DemoDb, circleId: string, change: RelationChange): ApiResult<{before?: Relation; after?: RelationInput; impact: RelationImpact}> {
  const circle = getCircle(db, circleId);
  if (circle?.type !== 'family') return bad('WRONG_CIRCLE_TYPE', '同学圈不能录入亲属关系');
  if (!change || (!change.removeRelationId && !change.relation)) return bad('INVALID_INPUT', '请选择要修改的关系');
  const before = change.removeRelationId ? db.relations.find(r => r.id === change.removeRelationId && r.circleId === circleId) : undefined;
  if (change.removeRelationId && !before) return bad('NOT_FOUND', '要修改的关系不存在');
  const current = db.relations.filter(r => r.circleId === circleId && r.id !== change.removeRelationId);
  const after = change.relation;
  if (after) {
    if (!after.from || !after.to || after.from === after.to) return bad('INVALID_INPUT', '请选择两个不同的人');
    if (!db.persons.some(person => person.id === after.from && person.circleId === circleId) ||
      !db.persons.some(person => person.id === after.to && person.circleId === circleId)) return bad('INVALID_INPUT', '人物不属于当前圈子');
    if (['parent', 'spouse', 'sibling'].indexOf(after.type) < 0) return bad('INVALID_INPUT', '请选择关系类型');
    if (after.olderId && (after.type !== 'sibling' || (after.olderId !== after.from && after.olderId !== after.to))) {
      return bad('INVALID_INPUT', '较年长者须是这条兄弟姐妹关系中的一人');
    }
    if (current.some(relation => samePair(relation, after))) return bad('RELATION_CONFLICT', '这两位人物之间已有关系，请先更正原关系');
    const candidate = [...current, {id: '_preview', circleId, ...after}];
    const parentLinks = new Map<string, string[]>();
    for (const relation of candidate) {
      if (relation.type !== 'parent') continue;
      const children = parentLinks.get(relation.from) || [];
      children.push(relation.to); parentLinks.set(relation.from, children);
    }
    const seen = new Set<string>(); const active = new Set<string>();
    const cycle = (id: string): boolean => {
      if (active.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id); active.add(id);
      for (const child of parentLinks.get(id) || []) if (cycle(child)) return true;
      active.delete(id); return false;
    };
    for (const id of parentLinks.keys()) if (cycle(id)) return bad('RELATION_CYCLE', '亲子关系形成循环，请核对方向');
    const people = db.persons.filter(person => person.circleId === circleId).map(person => person.id);
    const union = new Map(people.map(id => [id, id]));
    const find = (id: string): string => { let root = id; while (union.get(root) !== root) root = union.get(root)!; return root; };
    for (const relation of candidate) if (relation.type !== 'parent') {
      const a = find(relation.from); const b = find(relation.to); if (a !== b) union.set(a, b);
    }
    const links = new Map<string, Array<{to: string; delta: number}>>();
    for (const relation of candidate) if (relation.type === 'parent') {
      const a = find(relation.from); const b = find(relation.to);
      if (a === b) return bad('GENERATION_CONFLICT', '亲子与同辈关系矛盾，请核对');
      links.set(a, [...(links.get(a) || []), {to: b, delta: 1}]);
      links.set(b, [...(links.get(b) || []), {to: a, delta: -1}]);
    }
    const level = new Map<string, number>();
    for (const start of people.map(find)) {
      if (level.has(start)) continue;
      level.set(start, 0); const queue = [start];
      for (let i = 0; i < queue.length; i++) {
        const from = queue[i];
        for (const edge of links.get(from) || []) {
          const next = level.get(from)! + edge.delta;
          if (!level.has(edge.to)) { level.set(edge.to, next); queue.push(edge.to); }
          else if (level.get(edge.to) !== next) return bad('GENERATION_CONFLICT', '新关系使人物辈分互相矛盾，请核对');
        }
      }
    }
  }
  const endpoints = [before?.from, before?.to, after?.from, after?.to].filter((id): id is string => !!id);
  const touched = new Set(endpoints);
  const all = [...current, ...(before ? [before] : []), ...(after ? [{id: '_preview', circleId, ...after}] : [])];
  let grew = true;
  while (grew) {
    grew = false;
    for (const relation of all) if (touched.has(relation.from) !== touched.has(relation.to)) {
      touched.add(relation.from); touched.add(relation.to); grew = true;
    }
  }
  return good({before, after, impact: {
    removedRelationIds: before ? [before.id] : [], createdRelationIds: [], affectedPersonIds: [...touched]
  }});
}

function mockInvoke(action: string, p: any): ApiResult<any> {
  // Work on a detached copy so a failed storage write cannot appear saved in
  // the current session (some test and device storage adapters return objects by reference).
  const db = clone(loadDb());
  const circleId = p.circleId as string;
  if (action === 'circle.list') {
    return good({ circles: db.circles.filter(c => !!roleFor(db, c.id)).map(c => ({ ...c, role: roleFor(db, c.id), memberCount: db.members.filter(m => m.circleId === c.id && m.status === 'joined').length })) });
  }
  if (action === 'circle.create') {
    if (!p.name || !String(p.name).trim()) return bad('INVALID', '请填写圈子名称');
    if (p.type !== 'family' && p.type !== 'classmate') return bad('INVALID', '请选择圈子类型');
    if (p.type === 'classmate' && (!p.school || !p.cohort || !p.className)) return bad('INVALID', '请填写学校、届别和班级');
    const circle: Circle = { id: uid('circle'), name: String(p.name).trim(), type: p.type, mode: p.mode === 'shared' ? 'shared' : 'private', school: p.school, cohort: p.cohort, className: p.className, role: 'owner', memberCount: 1 };
    db.circles.push(circle);
    db.members.push({ id: uid('member'), circleId: circle.id, name: '我', role: 'owner', status: 'joined', actorId: DEMO_ACTOR });
    recordAudit(db, circle.id, 'circle.create', circle.id);
    saveDb(db);
    return good({ circle });
  }
  if (action === 'invite.preview') {
    const invite = db.invites.find(i => i.token === p.token);
    if (!invite) return bad('NOT_FOUND', '邀请不存在');
    const circle = getCircle(db, invite.circleId);
    if (!circle) return bad('NOT_FOUND', '圈子不存在');
    const status = invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt < Date.now() ? 'expired' : 'active';
    return good({ circle: { id: circle.id, name: circle.name, type: circle.type, school: circle.school, cohort: circle.cohort, className: circle.className }, expiresAt: invite.expiresAt, status });
  }
  if (action === 'invite.apply') {
    const invite = db.invites.find(i => i.token === p.token);
    if (!invite) return bad('NOT_FOUND', '邀请不存在');
    if (invite.revokedAt || invite.usedAt || invite.expiresAt < Date.now()) return bad('INVITE_UNAVAILABLE', '这份邀请已失效，请联系管理员重新邀请');
    if (!p.name || !String(p.name).trim()) return bad('INVALID', '请填写你的姓名');
    if (p.claimPersonId !== undefined) return bad('INVALID_INPUT', '请先申请加入，审核通过后再申请认领人物卡');
    if (getCircle(db, invite.circleId)?.type === 'classmate' && !String(p.note || '').trim()) return bad('INVALID_INPUT', '请填写同班核对说明');
    const application: JoinApplication = { id: uid('join'), circleId: invite.circleId, inviteId: invite.id, applicantName: String(p.name).trim(), name: String(p.name).trim(), note: p.note || '', status: 'pending', createdAt: Date.now(), actorId: DEMO_ACTOR };
    db.applications.push(application);
    saveDb(db);
    const {actorId: _actorId, ...visible} = application;
    return good({ application: visible });
  }
  if (action === 'join.mine') {
    const mine = db.applications.filter(a => !a.actorId || a.actorId === DEMO_ACTOR)
      .sort((a, b) => b.createdAt - a.createdAt);
    const selected = p.applicationId ? mine.filter(a => a.id === p.applicationId) : mine.slice(0, 20);
    return good({ applications: selected.map(a => {
      const invite = db.invites.find(i => i.id === a.inviteId);
      const inviteStatus = !invite ? 'expired' : invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt <= Date.now() ? 'expired' : 'active';
      const status = a.status === 'pending' && inviteStatus !== 'active' ? 'expired' : a.status;
      const {actorId: _actorId, ...visible} = a;
      return {...visible, status, inviteStatus, circleName: getCircle(db, a.circleId)?.name || '亲友圈', circleType: getCircle(db, a.circleId)?.type};
    }), hasMore: !p.applicationId && mine.length > 20 });
  }
  if (!circleId) return bad('INVALID', '缺少圈子 ID');
  const access = requireMember(db, circleId);
  if (access) return access;

  if (action === 'circle.detail') {
    return good({ circle: { ...getCircle(db, circleId), role: roleFor(db, circleId), memberCount: db.members.filter(m => m.circleId === circleId && m.status === 'joined').length }, role: roleFor(db, circleId) });
  }
  if (action === 'circle.transferOwner') {
    if (roleFor(db, circleId) !== 'owner') return bad('FORBIDDEN', '只有圈主可以移交圈主');
    const current = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
    const target = db.members.find(m => m.id === p.memberId && m.circleId === circleId && m.status === 'joined');
    if (!current || !target || target.id === current.id) return bad('INVALID', '请选择本圈其他已加入成员');
    current.role = 'admin'; target.role = 'owner';
    recordAudit(db, circleId, 'circle.transferOwner', target.id);
    saveDb(db); return good({ circle: getCircle(db, circleId), member: { id: target.id, role: target.role } });
  }
  if (action === 'circle.upgrade') {
    if (roleFor(db, circleId) !== 'owner') return bad('FORBIDDEN', '只有圈主可以开启邀请共建');
    if (p.privacyReviewed !== true) return bad('PRIVACY_REVIEW_REQUIRED', '请先确认历史资料的可见范围');
    const circle = getCircle(db, circleId)!;
    circle.mode = 'shared'; saveDb(db); return good({ circle });
  }
  if (action === 'person.list') return good({ persons: db.persons.filter(x => x.circleId === circleId).map(visiblePerson) });
  if (action === 'person.get') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    return person ? good({ person: visiblePerson(person) }) : bad('NOT_FOUND', '人物卡不存在');
  }
  if (action === 'photo.url') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    const visible = visiblePerson(person);
    if (!visible.photoUrl) return bad('FORBIDDEN', '照片未公开');
    return good({ url: visible.photoUrl });
  }
  if (action === 'photo.urls') {
    if (!Array.isArray(p.personIds) || !p.personIds.length || p.personIds.length > 20 || p.personIds.some((id: unknown) => typeof id !== 'string')) return bad('INVALID_INPUT', '请选择 1 至 20 张人物照片');
    const urls: Record<string, string> = {};
    for (const personId of new Set(p.personIds as string[])) {
      const person = db.persons.find(x => x.id === personId && x.circleId === circleId);
      if (!person) continue;
      const url = visiblePerson(person).photoUrl;
      if (url) urls[personId] = url;
    }
    return good({ urls });
  }
  if (action === 'photo.upload') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person || person.claimedBy !== DEMO_ACTOR) return bad('FORBIDDEN', '只能上传本人照片');
    const base64 = String(p.base64 || '');
    const byteLength = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (!base64.startsWith('/9j/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || byteLength > 1024 * 1024) return bad('INVALID_INPUT', '请上传不超过 1 MB 的 JPG 照片');
    if (p.visibility !== undefined && p.visibility !== 'self' && p.visibility !== 'circle') return bad('INVALID_INPUT', '照片可见范围不正确');
    const fs = wx.getFileSystemManager?.();
    const directory = wx.env?.USER_DATA_PATH;
    if (!fs?.writeFileSync || !directory) return bad('PHOTO_UNAVAILABLE', '当前设备无法持久保存演示照片');
    const path = `${directory}/demo-photo-${person.id}-${uid('file')}.jpg`;
    try { fs.writeFileSync(path, base64, 'base64'); }
    catch (_) { return bad('PHOTO_SAVE_FAILED', '演示照片保存失败，请清理本机存储后重试'); }
    const nextDb = clone(db);
    const updated = nextDb.persons.find(x => x.id === person.id)!;
    updated.photoUrl = path;
    updated.photoFileId = `demo-photo-${person.id}`;
    updated.visibility = { ...(updated.visibility || {}), photoFileId: p.visibility || 'self' };
    updated.updatedAt = Date.now();
    try { wx.setStorageSync(DB_KEY, nextDb); }
    catch (_) {
      try { fs.unlinkSync?.(path); } catch (_) { /* The saved file is inaccessible without its DB reference. */ }
      return bad('STORAGE_FULL', '演示资料存储空间不足，照片没有保存');
    }
    return good({ person: visiblePerson(updated) });
  }
  if (action === 'person.create') {
    if (!p.claimSelf) { const denied = requireAdmin(db, circleId); if (denied) return denied; }
    if (!p.name || !String(p.name).trim()) return bad('INVALID', '请填写姓名');
    if (p.claimSelf && db.persons.some(x => x.circleId === circleId && x.claimedBy === DEMO_ACTOR)) return bad('ALREADY_HAS_PERSON', '你在本圈已有本人卡');
    if (p.claimSelf && db.claimRequests.some(x => x.circleId === circleId && x.actorId === DEMO_ACTOR && x.status === 'pending')) return bad('CLAIM_PENDING', '已有认领申请正在审核，请先等待结果');
    const person: Person = { id: uid('person'), circleId, name: String(p.name).trim(), gender: p.gender || 'unknown', birthOrder: p.birthOrder, visibility: {}, claimedBy: p.claimSelf ? DEMO_ACTOR : undefined, updatedAt: Date.now() };
    db.persons.push(person); saveDb(db);
    if (p.claimSelf) { const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR); if (member) member.personId = person.id; saveDb(db); }
    return good({ person: visiblePerson(person) });
  }
  if (action === 'person.update') {
    const nextDb = clone(db);
    const person = nextDb.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    const self = person.claimedBy === DEMO_ACTOR;
    const adminUnclaimed = isAdmin(roleFor(nextDb, circleId)) && !person.claimedBy;
    const actorMember = nextDb.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR);
    const delegated = nextDb.delegations.find(d => d.personId === person.id && d.adminMemberId === (actorMember && actorMember.id) && d.active);
    if (!self && !adminUnclaimed && !delegated) return bad('FORBIDDEN', '只能编辑本人资料或已授权的资料');
    if (p.visibility && !self) return bad('FORBIDDEN', '只有本人可以修改可见范围');
    const allowed = ['name','nickname','gender','birthOrder','country','province','city','latitude','longitude','status','industry','occupation','school','bio','phone','wechatId','photoFileId','photoUrl'];
    const patch = p.patch || {};
    const latitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'latitude');
    const longitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'longitude');
    if (latitudeTouched !== longitudeTouched) return bad('INVALID_INPUT', '城市坐标须同时填写或同时清除');
    const latitude = patch.latitude == null || patch.latitude === '' ? undefined : patch.latitude;
    const longitude = patch.longitude == null || patch.longitude === '' ? undefined : patch.longitude;
    if (latitudeTouched && ((latitude === undefined) !== (longitude === undefined))) return bad('INVALID_INPUT', '城市坐标须同时填写或同时清除');
    if (latitude !== undefined && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) return bad('INVALID_INPUT', '城市坐标超出范围');
    const next = { ...person };
    for (const key of Object.keys(patch)) {
      if (allowed.indexOf(key) < 0) continue;
      if (adminUnclaimed && ['name','nickname','gender','birthOrder'].indexOf(key) < 0) return bad('FORBIDDEN', '未认领人物只可填写最少资料');
      if (delegated && !self && !adminUnclaimed && effectiveDelegationFields(delegated.fields).indexOf(key === 'photoUrl' ? 'photoFileId' : key) < 0) return bad('FORBIDDEN', '此字段不在代维护授权范围内');
      (next as any)[key] = key === 'latitude' ? (latitude === undefined ? undefined : Math.round(latitude * 10) / 10) :
        key === 'longitude' ? (longitude === undefined ? undefined : Math.round(longitude * 10) / 10) : patch[key];
    }
    if (typeof patch.photoUrl === 'string' && patch.photoUrl) next.photoFileId = `demo-photo-${person.id}`;
    else if (Object.prototype.hasOwnProperty.call(patch, 'photoUrl') && !patch.photoUrl) next.photoFileId = undefined;
    if (latitude !== undefined && !next.city) return bad('INVALID_INPUT', '请先填写城市再确认城市中心点');
    const locationNameChanged = ['city','country','province'].some(key => Object.prototype.hasOwnProperty.call(patch, key) && (next as any)[key] !== (person as any)[key]);
    if (!next.city || (locationNameChanged && !latitudeTouched)) { next.latitude = undefined; next.longitude = undefined; }
    Object.assign(person, next);
    if (p.visibility) {
      person.visibility = { ...(person.visibility || {}), ...p.visibility };
    }
    person.updatedAt = Date.now();
    try { wx.setStorageSync(DB_KEY, nextDb); }
    catch (_) { return bad('STORAGE_FULL', '演示资料存储空间不足，修改没有保存'); }
    return good({ person: visiblePerson(person) });
  }
  if (action === 'person.delete') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    if (person.claimedBy) return bad('PERSON_CLAIMED', '请先移除或解绑认领该人物的成员');
    if (db.relations.some(r => r.circleId === circleId && (r.from === person.id || r.to === person.id))) return bad('PERSON_LINKED', '这张人物卡还连接着家庭关系，请先调整关系');
    db.persons = db.persons.filter(x => x.id !== person.id); saveDb(db);
    return good({ deleted: true });
  }
  if (action === 'person.claim') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    if (person.claimedBy) return bad('ALREADY_CLAIMED', '这张人物卡已被认领');
    if (db.persons.some(x => x.circleId === circleId && x.claimedBy === DEMO_ACTOR)) return bad('ALREADY_HAS_PERSON', '你在本圈已有本人卡');
    const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR);
    const pending = db.claimRequests.find(x => x.circleId === circleId && x.actorId === DEMO_ACTOR && x.status === 'pending');
    if (pending) return pending.personId === person.id ? good({claimRequest: pending}) : bad('CLAIM_PENDING', '已有认领申请正在审核，请先等待结果');
    const claimRequest: ClaimRequest = { id: uid('claim'), circleId, personId: person.id, applicantName: member?.name || '成员', actorId: DEMO_ACTOR, status: 'pending', createdAt: Date.now() };
    db.claimRequests.push(claimRequest); saveDb(db);
    return good({ claimRequest });
  }
  if (action === 'person.claimMine') {
    return good({ claimRequests: db.claimRequests.filter(x => x.circleId === circleId && x.actorId === DEMO_ACTOR)
      .map(({actorId: _actorId, ...request}) => ({...request, personName: db.persons.find(person => person.id === request.personId)?.name || '人物卡'})) });
  }
  if (action === 'person.claimList') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    return good({ claimRequests: db.claimRequests.filter(x => x.circleId === circleId).map(({ actorId: _actorId, ...x }) => x) });
  }
  if (action === 'person.claimApprove' || action === 'person.claimReject') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const request = db.claimRequests.find(x => x.id === p.claimRequestId && x.circleId === circleId);
    if (!request || request.status !== 'pending') return bad('INVALID', '认领申请已处理或不存在');
    if (action === 'person.claimReject') { request.status = 'rejected'; saveDb(db); return good({ claimRequest: request }); }
    const person = db.persons.find(x => x.id === request.personId && x.circleId === circleId);
    if (!person || person.claimedBy) return bad('ALREADY_CLAIMED', '人物卡已被认领');
    if (db.persons.some(x => x.circleId === circleId && x.claimedBy === request.actorId)) return bad('ALREADY_HAS_PERSON', '申请人在本圈已有本人卡');
    person.claimedBy = request.actorId;
    const member = db.members.find(m => m.circleId === circleId && m.actorId === request.actorId);
    if (member) member.personId = person.id;
    request.status = 'approved'; saveDb(db); return good({ claimRequest: request });
  }
  if (action === 'person.unclaim') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person || !person.claimedBy) return bad('INVALID_INPUT', '这张人物卡没有认领人');
    const oldActor = person.claimedBy;
    const member = db.members.find(m => m.circleId === circleId && m.actorId === oldActor && m.personId === person.id);
    if (member) member.personId = undefined;
    person.claimedBy = undefined;
    ['phone','wechatId','photoFileId','photoUrl','city','country','province','latitude','longitude','status','industry','occupation','school','bio'].forEach(key => { delete (person as any)[key]; });
    person.visibility = {};
    person.updatedAt = Date.now();
    db.delegations.filter(d => d.personId === person.id && d.active).forEach(d => { d.active = false; d.revokedAt = Date.now(); });
    recordAudit(db, circleId, 'person.unclaim', person.id, {privateFieldsCleared: true});
    saveDb(db);
    return good({ person: visiblePerson(person) });
  }
  if (action === 'relation.list') return good({ relations: db.relations.filter(r => r.circleId === circleId) });
  if (action === 'relation.preview' || action === 'relation.create' || action === 'relation.replace' || action === 'relation.delete') {
    if (action !== 'relation.preview') { const denied = requireAdmin(db, circleId); if (denied) return denied; }
    const change: RelationChange = action === 'relation.preview' ? p.relationChange : action === 'relation.create'
      ? {relation: {from: p.from, to: p.to, type: p.type, olderId: p.olderId}}
      : action === 'relation.replace' ? {removeRelationId: p.relationId, relation: p.relation}
      : {removeRelationId: p.relationId};
    const preview = previewDemoRelation(db, circleId, change);
    if (!preview.ok || action === 'relation.preview') return preview;
    const {before, after, impact} = preview.data;
    if (before) db.relations = db.relations.filter(r => r.id !== before.id);
    let created: Relation | undefined;
    if (after) { created = {id: uid('relation'), circleId, ...after}; db.relations.push(created); impact.createdRelationIds.push(created.id); }
    const kind = action === 'relation.replace' ? 'relation.replace' : action === 'relation.create' ? 'relation.create' : 'relation.delete';
    recordAudit(db, circleId, kind, created?.id || before!.id, {removed: before, created});
    saveDb(db);
    if (action === 'relation.create') return good({relation: created});
    if (action === 'relation.replace') return good({relation: created, impact});
    return good({relationId: before!.id, impact});
  }
  if (action === 'invite.create') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    if (getCircle(db, circleId)?.mode !== 'shared') return bad('PRIVATE_CIRCLE', '请先检查资料并开启邀请共建');
    const invite: Invite = { id: uid('invite'), circleId, token: uid('token'), expiresAt: Date.now() + 72 * 3600000 };
    db.invites.push(invite); recordAudit(db, circleId, 'invite.create', invite.id); saveDb(db); return good({ invite });
  }
  if (action === 'invite.revoke') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const invite = db.invites.find(i => i.id === p.inviteId && i.circleId === circleId);
    if (!invite) return bad('NOT_FOUND', '邀请不存在');
    invite.revokedAt = Date.now(); recordAudit(db, circleId, 'invite.revoke', invite.id); saveDb(db); return good({ invite });
  }
  if (action === 'join.list') {
    if (!isAdmin(roleFor(db, circleId))) return bad('FORBIDDEN', '只有管理员可以查看申请');
    return good({applications: db.applications.filter(a => a.circleId === circleId && a.status === 'pending').map(a => {
      const invite = db.invites.find(i => i.id === a.inviteId);
      const inviteStatus = !invite ? 'missing' : invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt <= Date.now() ? 'expired' : 'active';
      const {actorId: _actorId, ...visible} = a;
      return {...visible, inviteStatus, inviteExpiresAt: invite?.expiresAt};
    })});
  }
  if (action === 'join.approve' || action === 'join.reject') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const application = db.applications.find(a => a.id === p.applicationId && a.circleId === circleId);
    if (!application) return bad('NOT_FOUND', '申请不存在');
    if (application.status !== 'pending') return bad('INVALID', '这份申请已经处理过');
    if (action === 'join.reject') { application.status = 'rejected'; recordAudit(db, circleId, 'join.reject', application.id); saveDb(db); return good({ application }); }
    const invite = db.invites.find(i => i.id === application.inviteId);
    if (!invite || invite.revokedAt || invite.usedAt || invite.expiresAt < Date.now()) return bad('INVITE_UNAVAILABLE', '邀请已失效，无法批准');
    db.members.push({ id: uid('member'), circleId, name: application.applicantName, role: 'member', status: 'joined', actorId: `guest_${application.id}` });
    application.status = 'approved'; invite.usedAt = Date.now();
    db.applications.filter(a => a.inviteId === invite.id && a.id !== application.id && a.status === 'pending').forEach(a => { a.status = 'invalid'; });
    recordAudit(db, circleId, 'join.approve', application.id); saveDb(db); return good({ application });
  }
  if (action === 'member.list') return good({ members: db.members.filter(m => m.circleId === circleId && m.status === 'joined').map(({ actorId, ...m }) => ({ ...m, isSelf: actorId === DEMO_ACTOR })) });
  if (action === 'member.setRole') {
    if (roleFor(db, circleId) !== 'owner') return bad('FORBIDDEN', '只有圈主可以任免管理员');
    const target = db.members.find(m => m.id === p.memberId && m.circleId === circleId && m.status === 'joined');
    if (!target || target.role === 'owner' || (p.role !== 'admin' && p.role !== 'member')) return bad('INVALID', '请选择可调整的本圈成员');
    target.role = p.role;
    if (p.role === 'member') db.delegations.filter(d => d.adminMemberId === target.id && d.active).forEach(d => { d.active = false; d.revokedAt = Date.now(); });
    recordAudit(db, circleId, 'member.setRole', target.id, { role: p.role });
    saveDb(db); return good({ member: { id: target.id, role: target.role } });
  }
  if (action === 'member.leave') {
    const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
    if (!member) return bad('FORBIDDEN', '你还不是这个圈子的成员');
    if (member.role === 'owner') return bad('OWNER_REQUIRED', '圈主须先移交圈主');
    member.status = 'left';
    const person = db.persons.find(x => x.id === member.personId && x.circleId === circleId);
    if (person) {
      person.claimedBy = undefined;
      ['phone','wechatId','photoFileId','photoUrl','city','country','province','latitude','longitude','status','industry','occupation','school','bio'].forEach(k => { delete (person as any)[k]; });
      person.visibility = {};
    }
    member.personId = undefined;
    db.delegations.filter(d => d.circleId === circleId && d.active && (d.personId === person?.id || d.adminMemberId === member.id)).forEach(d => { d.active = false; d.revokedAt = Date.now(); });
    recordAudit(db, circleId, 'member.leave', member.id);
    saveDb(db); return good({ member: { id: member.id, status: member.status } });
  }
  if (action === 'member.remove') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const member = db.members.find(m => m.id === p.memberId && m.circleId === circleId && m.status === 'joined');
    if (!member) return bad('NOT_FOUND', '成员不存在');
    if (member.role === 'owner' || (member.role === 'admin' && roleFor(db, circleId) !== 'owner') || member.actorId === DEMO_ACTOR) return bad('FORBIDDEN', '不能移除同级或更高权限成员');
    member.status = 'removed';
    const person = db.persons.find(x => x.id === member.personId && x.circleId === circleId);
    if (person) {
      person.claimedBy = undefined;
      ['phone','wechatId','photoFileId','photoUrl','city','country','province','latitude','longitude','status','industry','occupation','school','bio'].forEach(k => { delete (person as any)[k]; });
      person.visibility = {};
    }
    member.personId = undefined;
    db.delegations.filter(d => d.circleId === circleId && d.active && (d.personId === person?.id || d.adminMemberId === member.id)).forEach(d => { d.active = false; d.revokedAt = Date.now(); });
    recordAudit(db, circleId, 'member.remove', member.id); saveDb(db); return good({ member: { id: member.id, status: member.status } });
  }
  if (action === 'audit.list') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    return good({ events: db.audits.filter(e => e.circleId === circleId).sort((a, b) => b.at - a.at).slice(0, 100) });
  }
  if (action === 'suggestion.create') {
    if (!p.message || !String(p.message).trim()) return bad('INVALID', '请写下建议内容');
    if (['person','relation','invite'].indexOf(p.type) < 0) return bad('INVALID', '建议类型不正确');
    const relationChange: RelationChange | undefined = p.type === 'relation' ? p.relationChange : undefined;
    if (p.type === 'relation') {
      const preview = previewDemoRelation(db, circleId, relationChange!);
      if (!preview.ok) return preview;
    }
    const suggestion: Suggestion = { id: uid('suggestion'), circleId, type: p.type, personId: p.personId, message: String(p.message).trim(), relationChange, status: 'pending', createdAt: Date.now(), createdBy: DEMO_ACTOR };
    db.suggestions.push(suggestion); recordAudit(db, circleId, 'suggestion.create', suggestion.id); saveDb(db); return good({ suggestion });
  }
  if (action === 'suggestion.list') {
    const list = db.suggestions.filter(s => s.circleId === circleId && (isAdmin(roleFor(db, circleId)) || s.createdBy === DEMO_ACTOR));
    return good({ suggestions: list.map(({ createdBy: _createdBy, ...s }) => s) });
  }
  if (action === 'suggestion.resolve') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const suggestion = db.suggestions.find(s => s.circleId === circleId && s.id === p.suggestionId);
    if (!suggestion || suggestion.status !== 'pending') return bad('INVALID', '建议已处理或不存在');
    if (p.status !== 'accepted' && p.status !== 'rejected') return bad('INVALID', '处理结果不正确');
    if (p.status === 'accepted' && (suggestion.type !== 'relation' || !suggestion.relationChange)) {
      return bad('CHANGE_REQUIRED', '请先完成具体变更，不能只把建议标记为已采纳');
    }
    let impact: RelationImpact | undefined;
    let removed: Relation | undefined;
    let created: Relation | undefined;
    if (p.status === 'accepted' && suggestion.type === 'relation') {
      const preview = previewDemoRelation(db, circleId, suggestion.relationChange!);
      if (!preview.ok) return preview;
      const {before, after} = preview.data;
      impact = preview.data.impact;
      removed = before;
      if (removed) db.relations = db.relations.filter(relation => relation.id !== removed!.id);
      if (after) { created = {id: uid('relation'), circleId, ...after}; db.relations.push(created); impact.createdRelationIds.push(created.id); }
    }
    suggestion.status = p.status;
    recordAudit(db, circleId, 'suggestion.resolve', suggestion.id, {status: p.status, ...(impact ? {removed, created, affectedPersonIds: impact.affectedPersonIds, reason: suggestion.message} : {})});
    saveDb(db); return good({ suggestion, impact });
  }
  if (action === 'delegation.grant') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person || person.claimedBy !== DEMO_ACTOR) return bad('FORBIDDEN', '只有本人可以授权');
    const admin = db.members.find(m => m.id === p.adminMemberId && m.circleId === circleId && isAdmin(m.role) && m.status === 'joined');
    if (!admin) return bad('INVALID', '请选择本圈管理员');
    const allowed = ['name','nickname','gender','birthOrder','country','province','city','status','industry','occupation','school','bio','phone','wechatId','photoFileId'];
    const fields = (p.fields || []).filter((x: string) => allowed.indexOf(x) >= 0);
    if (!fields.length) return bad('INVALID', '请选择可代维护的字段');
    const delegation: Delegation = { id: uid('delegation'), circleId, personId: person.id, adminMemberId: admin.id, fields, active: true };
    db.delegations.push(delegation); saveDb(db); return good({ delegation });
  }
  if (action === 'delegation.revoke') {
    const delegation = db.delegations.find(d => d.id === p.delegationId && d.circleId === circleId);
    if (!delegation) return bad('NOT_FOUND', '授权不存在');
    const person = db.persons.find(x => x.id === delegation.personId);
    if (!person || person.claimedBy !== DEMO_ACTOR) return bad('FORBIDDEN', '只有本人可以撤销授权');
    delegation.active = false; saveDb(db); return good({ delegation });
  }
  return bad('UNKNOWN_ACTION', `演示模式暂不支持 ${action}`);
}

export async function invoke<T = any>(request: { action: string; payload?: any }): Promise<ApiResult<T>> {
  const payload = request.payload || {};
  if (isDemoMode()) {
    try { return mockInvoke(request.action, payload) as ApiResult<T>; }
    catch (error: any) {
      return bad(error instanceof DemoStorageError ? 'STORAGE_FULL' : 'DEMO_ERROR', error instanceof DemoStorageError ? error.message : '演示操作未完成，请重试');
    }
  }
  try {
    const result = await wx.cloud.callFunction({ name: 'api', data: { action: request.action, payload } });
    const envelope = result && result.result;
    if (envelope && typeof envelope.ok === 'boolean') return envelope as ApiResult<T>;
    return bad('BAD_RESPONSE', '云端返回了无法识别的数据');
  } catch (error: any) {
    return bad('NETWORK', error && error.message ? error.message : '网络暂时不可用，请稍后重试');
  }
}

/** Resolve visible photos in small batches so large circles can render before every URL arrives. */
export async function resolvePhotoUrls(circleId: string, persons: Person[], onProgress?: (persons: Person[], checkOnly?: boolean) => boolean | void): Promise<Person[]> {
  const list = persons.slice();
  const pending = list.map((p, i) => p.hasPhoto && !p.photoUrl ? i : -1).filter(i => i >= 0);
  // Prioritize the current member. The remaining photos are fetched after the
  // first render rather than silently leaving later graph cards without photos.
  const indexes = pending.sort((a, b) => Number(!!list[b].isSelf) - Number(!!list[a].isSelf));
  const load = async (batch: number[]) => {
    if (!batch.length) return;
    const result = await invoke<{ urls: Record<string, string> }>({ action: 'photo.urls', payload: { circleId, personIds: batch.map(i => list[i].id) } });
    if (result.ok) {
      batch.forEach(i => {
        const url = result.data.urls[list[i].id];
        if (url) list[i] = { ...list[i], photoUrl: url };
      });
      return;
    }
    // An older deployed function may not have the batch action yet.
    if (result.error.code !== 'UNKNOWN_ACTION') return;
    for (let start = 0; start < batch.length; start += 6) {
      await Promise.all(batch.slice(start, start + 6).map(async i => {
        const single = await invoke<{ url: string }>({ action: 'photo.url', payload: { circleId, personId: list[i].id } });
        if (single.ok && single.data.url) list[i] = { ...list[i], photoUrl: single.data.url };
      }));
    }
  };
  const first = indexes.slice(0, 20);
  await load(first);
  if (!onProgress) {
    for (let start = first.length; start < indexes.length; start += 20) await load(indexes.slice(start, start + 20));
  } else if (indexes.length > first.length) {
    setTimeout(() => {
      void (async () => {
        for (let start = first.length; start < indexes.length; start += 20) {
          if (onProgress(list, true) === false) return;
          await load(indexes.slice(start, start + 20));
          if (onProgress(list.slice()) === false) return;
        }
      })().catch(() => { /* A later visit can request fresh short-lived links. */ });
    }, 0);
  }
  return list;
}

export function showApiError(result: ApiResult<any>): void {
  if (!result.ok) wx.showToast({ title: result.error.message, icon: 'none', duration: 2500 });
}
