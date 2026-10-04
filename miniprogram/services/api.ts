/*
 * The only data entry point used by pages. The demo adapter is intentionally
 * stateful, so the same screens can be tried without an AppID or CloudBase.
 * In production set demo mode to false and deploy cloudfunctions/api.
 */
import { CLOUD_ENV_ID } from '../config';
import { BirthdayCalendar } from '../utils/birthday-calendar';
export type CircleType = 'family' | 'classmate';
export type Role = 'owner' | 'admin' | 'member';
export type Visibility = 'self' | 'circle';
export interface Birthday {
  calendar: 'solar' | 'lunar';
  month: number;
  day: number;
  year?: number;
  leapMonth?: boolean;
}
export interface JoinProfile {
  country: string;
  province?: string;
  city: string;
  latitude?: number;
  longitude?: number;
  birthday: Birthday;
}

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
  personCount?: number;
}
export interface OwnerTransfer {
  id: string;
  targetMemberId: string;
  targetName: string;
  expiresAt: number;
  isTarget: boolean;
  isOwner: boolean;
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
  birthday?: Birthday;
  profileComplete?: boolean;
  latitude?: number;
  longitude?: number;
  status?: string;
  industry?: string;
  occupation?: string;
  school?: string;
  bio?: string;
  phone?: string;
  /** Demo storage only. Private phone used to match a verified WeChat account. */
  matchPhone?: string;
  wechatId?: string;
  photoFileId?: string;
  photoUrl?: string;
  /** Per-record correction; never projected to another record's account. */
  profileOverrides?: Record<string, {baseRevision: number; value: unknown}>;
  hasPhoto?: boolean;
  visibility?: Record<string, Visibility>;
  isSelf?: boolean;
  isClaimed?: boolean;
  updatedAt?: number;
  lastConfirmedAt?: number;
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
export interface InitialRelation { anchorPersonId: string; kind: 'newParent' | 'newChild' | 'spouse' | 'sibling'; older?: 'unknown' | 'new' | 'anchor' }
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
  createdAt?: number;
  expiresAt: number;
  revokedAt?: number;
  usedAt?: number;
}
export interface InviteSummary { id: string; circleId: string; createdAt: number; expiresAt: number; status: 'active' | 'used' | 'revoked' | 'expired' }

export interface JoinApplication {
  id: string;
  circleId: string;
  inviteId: string;
  applicantName: string;
  name?: string;
  note?: string;
  profile?: JoinProfile;
  profileVersion?: number; // Demo storage only; records the account profile at submission.
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalid';
  createdAt: number;
  circleName?: string;
  circleType?: CircleType;
  inviteStatus?: 'active' | 'expired' | 'revoked' | 'used' | 'missing';
  inviteExpiresAt?: number;
  /** Current account profile changed since this request was submitted. */
  profileChanged?: boolean;
  profileIncomplete?: boolean;
  /** Binds approval to the profile snapshot shown to the administrator. */
  reviewToken?: string;
  canEnter?: boolean;
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

export interface Suggestion { id: string; circleId: string; type: 'person' | 'relation' | 'invite'; personId?: string; message: string; relationChange?: RelationChange; status: 'pending' | 'accepted' | 'rejected' | 'handled'; createdAt: number; createdBy?: string; resolutionNote?: string }
export interface ClaimRequest { id: string; circleId: string; personId: string; personName?: string; applicantName: string; status: 'pending' | 'approved' | 'rejected'; createdAt: number; actorId?: string }

export interface ApiError { code: string; message: string }
export type ApiResult<T = any> = { ok: true; data: T } | { ok: false; error: ApiError };

const MODE_KEY = 'kin-network-demo-mode';
const DB_KEY = 'kin-network-demo-db-v2';
const ACTOR_KEY = 'kin-network-demo-actor';
const DEMO_OWNER = 'demo-owner';
const DEMO_DAD = 'demo-dad';
const DEMO_GUEST = 'demo-guest';
const DEMO_GUEST2 = 'demo-guest-2';
let DEMO_ACTOR = 'demo-owner';
const DEMO_VERIFIED_PHONE = '+8613800138000';
const DEMO_DAD_PHONE = '+8613900139000';
const DEMO_GUEST_PHONE = '+8613700137000';
const DEMO_GUEST2_PHONE = '+8613600136000';
const SHARED_PROFILE_FIELDS = ['name','nickname','gender','birthday','country','province','city','latitude','longitude','status','school','industry','occupation','bio','phone','wechatId','photoFileId','photoUrl'] as const;
type SharedProfileField = typeof SHARED_PROFILE_FIELDS[number];
const LOCATION_PROFILE_FIELDS: SharedProfileField[] = ['country','province','city','latitude','longitude'];
function demoProfileRevision(profile: DemoProfile, field: SharedProfileField): number {
  return profile.fieldRevisions?.[field] ?? 0;
}
function touchDemoProfile(profile: DemoProfile, fields: SharedProfileField[]): void {
  const touched = fields.some(field => LOCATION_PROFILE_FIELDS.includes(field))
    ? [...new Set([...fields, ...LOCATION_PROFILE_FIELDS])] : [...new Set(fields)];
  profile.fieldRevisions ||= {};
  profile.clearedFields ||= [];
  for (const field of touched) {
    profile.fieldRevisions[field] = (profile.fieldRevisions[field] || 0) + 1;
    if (profile[field] === undefined) {
      if (!profile.clearedFields.includes(field)) profile.clearedFields.push(field);
    } else profile.clearedFields = profile.clearedFields.filter(key => key !== field);
  }
}
type DemoProfile = Partial<Pick<Person, SharedProfileField>> & {updatedAt: number;
  cardFallback?: boolean; fieldRevisions?: Partial<Record<SharedProfileField, number>>; clearedFields?: SharedProfileField[]};
class DemoStorageError extends Error {}

function storageGet(key: string): any {
  try { return wx.getStorageSync(key); } catch (_) { return undefined; }
}
function storageSet(key: string, value: any): void {
  try { wx.setStorageSync(key, value); }
  catch (_) { throw new DemoStorageError('本机演示资料存储空间不足，操作没有保存'); }
}
DEMO_ACTOR = [DEMO_DAD, DEMO_GUEST, DEMO_GUEST2].includes(storageGet(ACTOR_KEY)) ? storageGet(ACTOR_KEY) : DEMO_OWNER;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function nextDemoPersonUpdatedAt(person: Person): number { return Math.max(Date.now(), (person.updatedAt || 0) + 1); }
function good<T>(data: T): ApiResult<T> { return { ok: true, data }; }
function bad(code: string, message: string): ApiResult<any> { return { ok: false, error: { code, message } }; }
function uid(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

// A configured cloud environment is the normal production entry point. The
// local demo must be chosen explicitly once a real environment exists.
export function isDemoMode(): boolean { return !CLOUD_ENV_ID || storageGet(MODE_KEY) === true; }
export function setDemoMode(enabled: boolean): boolean {
  if (!enabled && (!CLOUD_ENV_ID || !wx.cloud || !wx.cloud.callFunction)) return false;
  try {
    if (!enabled && wx.cloud.init) wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
    storageSet(MODE_KEY, enabled);
    return true;
  } catch (_) { return false; }
}

/** QA-only local identities. Cloud mode continues to use WeChat OPENID. */
export function getDemoActor(): 'demo-owner' | 'demo-dad' | 'demo-guest' | 'demo-guest-2' {
  DEMO_ACTOR = [DEMO_DAD, DEMO_GUEST, DEMO_GUEST2].includes(storageGet(ACTOR_KEY)) ? storageGet(ACTOR_KEY) : DEMO_OWNER;
  return DEMO_ACTOR as 'demo-owner' | 'demo-dad' | 'demo-guest' | 'demo-guest-2';
}
export function setDemoActor(actor: 'demo-owner' | 'demo-dad' | 'demo-guest' | 'demo-guest-2'): boolean {
  if (!isDemoMode() || ![DEMO_OWNER, DEMO_DAD, DEMO_GUEST, DEMO_GUEST2].includes(actor)) return false;
  try { storageSet(ACTOR_KEY, actor); DEMO_ACTOR = actor; return true; }
  catch (_) { return false; }
}

interface DemoDb {
  demoSeedVersion?: number;
  verifiedPhone?: string;
  verifiedPhoneAt?: number;
  phoneIdentities?: Record<string, {phone: string; verifiedAt: number}>;
  userProfiles?: Record<string, DemoProfile>;
  personRemarks?: Record<string, {circleId: string; personId: string; actorId: string; remark: string}>;
  createRequests: Record<string, { fingerprint: string; id: string }>;
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
  ownerTransfers: Array<{id: string; circleId: string; ownerMemberId: string; targetMemberId: string; expiresAt: number}>;
}

function seedDb(): DemoDb {
  const now = Date.now();
  const circleVisible = { city: 'circle', photoFileId: 'circle', school: 'circle', industry: 'circle', status: 'circle', occupation: 'circle', bio: 'circle', phone: 'self', wechatId: 'self' } as Record<string, Visibility>;
  const db: DemoDb = {
    demoSeedVersion: 4,
    phoneIdentities: {},
    userProfiles: {},
    circles: [
      { id: 'family_demo', type: 'family', name: '陈家亲友录', mode: 'shared', role: 'owner', memberCount: 3 },
      { id: 'class_demo', type: 'classmate', name: '青禾中学 · 高三二班', mode: 'shared', school: '青禾中学', cohort: '2017 届', className: '高三二班', role: 'owner', memberCount: 4 },
      { id: 'phone_demo', type: 'family', name: '外婆家亲友录', mode: 'shared' }
    ],
    persons: [
      { id: 'f_me', circleId: 'family_demo', name: '陈小满', gender: 'female', country: '中国', province: '上海', city: '上海', status: '工作中', industry: '互联网', occupation: '产品设计', bio: '喜欢在不同城市见到家人。', phone: '13800000000', wechatId: 'xiaoman_demo', visibility: clone(circleVisible), claimedBy: DEMO_OWNER, updatedAt: now },
      { id: 'f_dad', circleId: 'family_demo', name: '陈志远', gender: 'male', birthOrder: 2, country: '中国', province: '北京', city: '北京', status: '工作中', industry: '教育', occupation: '教师', visibility: clone(circleVisible), claimedBy: 'demo-dad', updatedAt: now - 86400000 * 8 },
      { id: 'f_mom', circleId: 'family_demo', name: '林慧', gender: 'female', birthOrder: 2, country: '中国', province: '浙江', city: '杭州', status: '工作中', industry: '医疗', occupation: '护士', visibility: clone(circleVisible), claimedBy: 'demo-mom', updatedAt: now - 86400000 * 14 },
      { id: 'f_uncle', circleId: 'family_demo', name: '陈志国', gender: 'male', birthOrder: 1, country: '中国', province: '广东', city: '广州', status: '退休', industry: '制造业', visibility: { city: 'circle', industry: 'circle' }, updatedAt: now - 86400000 * 60 },
      { id: 'f_aunt', circleId: 'family_demo', name: '林芳', gender: 'female', birthOrder: 1, country: '美国', province: '加利福尼亚州', city: '旧金山', status: '工作中', industry: '餐饮', visibility: { city: 'circle', industry: 'circle', status: 'circle' }, claimedBy: 'demo-aunt', updatedAt: now - 86400000 * 25 },
      { id: 'f_grandma', circleId: 'family_demo', name: '周桂兰', gender: 'female', country: '中国', province: '江苏', city: '苏州', visibility: { city: 'circle' }, updatedAt: now - 86400000 * 99 },
      { id: 'f_cousin', circleId: 'family_demo', name: '陈雨晴', gender: 'female', country: '中国', province: '四川', city: '成都', status: '工作中', industry: '设计', visibility: { city: 'circle', industry: 'circle' }, updatedAt: now - 86400000 * 3 },
      { id: 'c_me', circleId: 'class_demo', name: '陈小满', nickname: '满满', gender: 'female', country: '中国', province: '上海', city: '上海', status: '工作中', industry: '互联网', occupation: '产品设计', school: '青禾中学', visibility: clone(circleVisible), claimedBy: DEMO_OWNER, updatedAt: now },
      { id: 'c_zhao', circleId: 'class_demo', name: '赵乐', gender: 'male', country: '中国', province: '四川', city: '成都', status: '工作中', industry: '游戏', occupation: '策划', visibility: clone(circleVisible), claimedBy: 'demo-zhao', updatedAt: now - 86400000 * 2 },
      { id: 'c_wang', circleId: 'class_demo', name: '王宁', gender: 'female', country: '英国', city: '伦敦', latitude: 51.5, longitude: -0.1, status: '读书中', industry: '学术', school: '伦敦大学学院', visibility: clone(circleVisible), claimedBy: 'demo-wang', updatedAt: now - 86400000 * 10 },
      { id: 'c_li', circleId: 'class_demo', name: '李航', gender: 'male', country: '加拿大', city: '多伦多', status: '工作中', industry: '金融', visibility: clone(circleVisible), claimedBy: 'demo-li', updatedAt: now - 86400000 * 15 },
      { id: 'c_sun', circleId: 'class_demo', name: '孙妍', gender: 'female', country: '中国', province: '江苏', city: '南京', status: '工作中', industry: '法律', visibility: { city: 'self', industry: 'circle' }, updatedAt: now - 86400000 * 28 },
      { id: 'phone_demo_me', circleId: 'phone_demo', name: '陈小满', gender: 'female', country: '中国', province: '上海', city: '上海', birthday: {calendar: 'solar', month: 10, day: 8}, profileComplete: true, matchPhone: DEMO_VERIFIED_PHONE, visibility: {}, updatedAt: now - 86400000 * 2 }
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
      { id: 'm_f_self', circleId: 'family_demo', name: '陈小满', role: 'owner', personId: 'f_me', status: 'joined', actorId: DEMO_OWNER },
      { id: 'm_f_dad', circleId: 'family_demo', name: '陈志远', role: 'member', personId: 'f_dad', status: 'joined', actorId: 'demo-dad' },
      { id: 'm_f_mom', circleId: 'family_demo', name: '林慧', role: 'member', personId: 'f_mom', status: 'joined', actorId: 'demo-mom' },
      { id: 'm_f_aunt', circleId: 'family_demo', name: '林芳', role: 'member', personId: 'f_aunt', status: 'joined', actorId: 'demo-aunt' },
      { id: 'm_c_self', circleId: 'class_demo', name: '陈小满', role: 'owner', personId: 'c_me', status: 'joined', actorId: DEMO_OWNER },
      { id: 'm_c_zhao', circleId: 'class_demo', name: '赵乐', role: 'member', personId: 'c_zhao', status: 'joined', actorId: 'demo-zhao' },
      { id: 'm_c_wang', circleId: 'class_demo', name: '王宁', role: 'member', personId: 'c_wang', status: 'joined', actorId: 'demo-wang' },
      { id: 'm_c_li', circleId: 'class_demo', name: '李航', role: 'member', personId: 'c_li', status: 'joined', actorId: 'demo-li' },
      { id: 'm_phone_admin', circleId: 'phone_demo', name: '外婆家的管理员', role: 'owner', status: 'joined', actorId: 'demo-phone-admin' }
    ],
    invites: [],
    createRequests: {},
    applications: [],
    delegations: [],
    suggestions: [],
    claimRequests: [],
    ownerTransfers: [],
    audits: [
      { id: 'audit_family_seed', circleId: 'family_demo', type: 'circle.create', targetId: 'family_demo', at: now - 86400000 * 120 },
      { id: 'audit_class_seed', circleId: 'class_demo', type: 'circle.create', targetId: 'class_demo', at: now - 86400000 * 95 }
    ]
  };
  fillSeedProfiles(db);
  ensureSeedUserProfiles(db);
  return db;
}

const SEED_BIRTHDAYS: Record<string, Birthday> = {
  f_me: { calendar: 'solar', month: 10, day: 8 }, f_dad: { calendar: 'solar', month: 11, day: 3 },
  f_mom: { calendar: 'lunar', month: 8, day: 15 }, f_uncle: { calendar: 'solar', month: 1, day: 18 },
  f_aunt: { calendar: 'solar', month: 4, day: 5 }, f_grandma: { calendar: 'lunar', month: 3, day: 12 },
  f_cousin: { calendar: 'solar', month: 12, day: 21 }, c_me: { calendar: 'solar', month: 10, day: 8 },
  c_zhao: { calendar: 'solar', month: 5, day: 14 }, c_wang: { calendar: 'solar', month: 7, day: 12 },
  c_li: { calendar: 'lunar', month: 9, day: 3 }, c_sun: { calendar: 'solar', month: 2, day: 9 }
};
function profileComplete(person: Person): boolean { return !!(person.country?.trim() && person.city?.trim() && person.birthday); }
function parseBirthday(raw: any): Birthday | null {
  if (!raw || (raw.calendar !== 'solar' && raw.calendar !== 'lunar') || !Number.isInteger(raw.month) || raw.month < 1 || raw.month > 12 || !Number.isInteger(raw.day)) return null;
  if (raw.year !== undefined && (!Number.isInteger(raw.year) || raw.year < 1900 || raw.year > 2100)) return null;
  if (raw.leapMonth !== undefined && typeof raw.leapMonth !== 'boolean') return null;
  if (raw.calendar === 'lunar') {
    if (raw.day < 1 || raw.day > 30) return null;
  } else {
    if (raw.leapMonth) return null;
    const year = raw.year || 2000;
    if (raw.day < 1 || raw.day > new Date(Date.UTC(year, raw.month, 0)).getUTCDate()) return null;
  }
  return { calendar: raw.calendar, month: raw.month, day: raw.day, ...(raw.year === undefined ? {} : {year: raw.year}), ...(raw.leapMonth ? {leapMonth: true} : {}) };
}
function parseProfile(raw: any): JoinProfile | null {
  if (!raw || typeof raw.country !== 'string' || !raw.country.trim() || typeof raw.city !== 'string' || !raw.city.trim()) return null;
  const birthday = parseBirthday(raw.birthday);
  if (!birthday) return null;
  const latitude = raw.latitude == null ? undefined : raw.latitude;
  const longitude = raw.longitude == null ? undefined : raw.longitude;
  if ((latitude === undefined) !== (longitude === undefined)) return null;
  if (latitude !== undefined && (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)) return null;
  return { country: raw.country.trim(), province: typeof raw.province === 'string' ? raw.province.trim() : '', city: raw.city.trim(), ...(latitude === undefined ? {} : {latitude, longitude}), birthday };
}
function demoApplicationReview(db: DemoDb, application: JoinApplication): {name: string; profile: JoinProfile | null; profileChanged: boolean; profileIncomplete: boolean; reviewToken?: string} {
  const account = application.actorId ? db.userProfiles?.[application.actorId] : undefined;
  const submittedName = String(application.name || application.applicantName || '').trim();
  const name = account ? String(account.name || '').trim() : submittedName;
  const profile = account ? parseProfile(account) : null;
  const ready = !!name && !!profile;
  const submittedVersion = (application as JoinApplication & {profileVersion?: number}).profileVersion;
  const identityChanged = name !== submittedName || JSON.stringify(profile) !== JSON.stringify(parseProfile(application.profile));
  const profileChanged = !ready || identityChanged || !!submittedVersion && submittedVersion !== account!.updatedAt;
  return {name, profile, profileChanged, profileIncomplete: !ready || !application.profile, reviewToken: ready ? JSON.stringify([application.id, account!.updatedAt, name, profile]) : undefined};
}
function normalizeMatchPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/[\s()-]/g, '');
  if (/^1[3-9]\d{9}$/.test(value)) return `+86${value}`;
  if (value.startsWith('+86') && !/^\+861[3-9]\d{9}$/.test(value)) return null;
  if (/^\+[1-9]\d{7,14}$/.test(value)) return value;
  return null;
}
function fillSeedProfiles(db: DemoDb): boolean {
  let changed = false;
  for (const person of db.persons) {
    if (SEED_BIRTHDAYS[person.id] && !person.birthday) { person.birthday = SEED_BIRTHDAYS[person.id]; changed = true; }
    if (person.id === 'c_sun' && !person.city) { person.country = '中国'; person.province = '江苏'; person.city = '南京'; changed = true; }
    const complete = profileComplete(person);
    if (person.profileComplete !== complete) { person.profileComplete = complete; changed = true; }
  }
  return changed;
}

function ensureDemoProfile(db: DemoDb, person: Person, actorId: string): DemoProfile {
  const profiles = db.userProfiles ||= {};
  const existing = profiles[actorId];
  if (existing) {
    const locationChanged = ['country', 'province', 'city'].some(field =>
      (existing as any)[field] !== undefined && (existing as any)[field] !== (person as any)[field]);
    for (const field of SHARED_PROFILE_FIELDS) {
      if (existing.clearedFields?.includes(field)) continue;
      if (locationChanged && (field === 'province' || field === 'latitude' || field === 'longitude')) continue;
      if (existing[field] === undefined && person[field] !== undefined) (existing as any)[field] = clone(person[field]);
    }
    return existing;
  }
  const profile: DemoProfile = {updatedAt: Date.now()};
  for (const field of SHARED_PROFILE_FIELDS) if (person[field] !== undefined) (profile as any)[field] = clone(person[field]);
  profiles[actorId] = profile;
  return profile;
}
function ensureDemoEmptyProfile(db: DemoDb, actorId: string): DemoProfile {
  const profiles = db.userProfiles ||= {};
  return profiles[actorId] ||= {updatedAt: Date.now(), cardFallback: true};
}
function ensureSeedUserProfiles(db: DemoDb): void {
  db.userProfiles ||= {};
  for (const person of db.persons) if (person.claimedBy) {
    const member = db.members.find(item => item.circleId === person.circleId && item.actorId === person.claimedBy && item.personId === person.id && item.status === 'joined');
    if (member) ensureDemoProfile(db, person, person.claimedBy);
  }
}
function hydratedDemoPerson(db: DemoDb, person: Person): Person {
  if (!person.claimedBy) return person;
  const profile = db.userProfiles?.[person.claimedBy];
  if (!profile) return person;
  const view = {...person};
  for (const field of SHARED_PROFILE_FIELDS) {
    if (!profile.cardFallback || profile[field] !== undefined || profile.clearedFields?.includes(field)) (view as any)[field] = profile[field];
    const correction = person.profileOverrides?.[field];
    if (correction && correction.baseRevision === demoProfileRevision(profile, field)) {
      (view as any)[field] = correction.value === null ? undefined : correction.value;
    }
  }
  return view;
}
function demoProfileView(profile: DemoProfile) {
  const view: Record<string, unknown> = {};
  for (const field of SHARED_PROFILE_FIELDS) if (field !== 'photoFileId' && field !== 'photoUrl' && profile[field] !== undefined) view[field] = profile[field];
  return {...view, hasPhoto: !!(profile.photoFileId || profile.photoUrl), profileComplete: !!(profile.name?.trim() && profile.country?.trim() && profile.city?.trim() && profile.birthday), updatedAt: profile.updatedAt};
}
function demoOwnPhotoTarget(db: DemoDb): {circleId: string; personId: string} | null {
  const member = db.members.find(item => item.actorId === DEMO_ACTOR && item.status === 'joined' && item.personId && db.persons.some(person => person.id === item.personId && person.claimedBy === DEMO_ACTOR));
  return member?.personId ? {circleId: member.circleId, personId: member.personId} : null;
}

function loadDb(): DemoDb {
  const stored = storageGet(DB_KEY);
  if (stored && stored.circles && stored.persons) {
    let migrated = false;
    // Keep existing local demo data while refreshing only untouched sample names.
    for (const circle of stored.circles as Circle[]) {
      if (circle.id === 'family_demo' && circle.name === '陈家的小圈子') { circle.name = '陈家亲友录'; migrated = true; }
      if (circle.id === 'phone_demo' && circle.name === '外婆家的亲友圈') { circle.name = '外婆家亲友录'; migrated = true; }
    }
    if ((stored.demoSeedVersion || 0) < 3) {
      const sample = seedDb();
      const circle = sample.circles.find(item => item.id === 'phone_demo')!;
      const person = sample.persons.find(item => item.id === 'phone_demo_me')!;
      const member = sample.members.find(item => item.id === 'm_phone_admin')!;
      if (!stored.circles.some((item: Circle) => item.id === circle.id)) stored.circles.push(circle);
      if (!stored.persons.some((item: Person) => item.id === person.id)) stored.persons.push(person);
      if (!stored.members.some((item: Member) => item.id === member.id)) stored.members.push(member);
      stored.demoSeedVersion = 3;
      migrated = true;
    }
    stored.suggestions = stored.suggestions || [];
    stored.claimRequests = stored.claimRequests || [];
    stored.delegations = stored.delegations || [];
    stored.audits = stored.audits || [];
    stored.createRequests = stored.createRequests || {};
    stored.ownerTransfers = stored.ownerTransfers || [];
    if (fillSeedProfiles(stored as DemoDb)) migrated = true;
    if (!stored.userProfiles) { ensureSeedUserProfiles(stored as DemoDb); migrated = true; }
    if (!stored.phoneIdentities) {
      stored.phoneIdentities = {};
      if (stored.verifiedPhone && stored.verifiedPhoneAt) stored.phoneIdentities[DEMO_OWNER] = {phone: stored.verifiedPhone, verifiedAt: stored.verifiedPhoneAt};
      migrated = true;
    }
    if ((stored.demoSeedVersion || 0) < 4) { stored.demoSeedVersion = 4; migrated = true; }
    if (migrated) storageSet(DB_KEY, stored);
    return stored as DemoDb;
  }
  const db = seedDb();
  storageSet(DB_KEY, db);
  return db;
}
function saveDb(db: DemoDb): void { storageSet(DB_KEY, db); }
function demoRequestKey(db: DemoDb, action: 'circle.create' | 'person.create', circleId: string, requestId: any): ApiResult<{key: string}> {
  if (requestId == null || requestId === '') return good({key: ''});
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) return bad('INVALID_INPUT', '创建请求标识无效，请重新打开页面再试');
  return good({key: `${action}:${DEMO_ACTOR}:${circleId}:${requestId}`});
}
function recordAudit(db: DemoDb, circleId: string, type: string, targetId: string, details?: Record<string, unknown>): void {
  const actor = db.members.find(member => member.circleId === circleId && member.actorId === DEMO_ACTOR && member.status === 'joined');
  db.audits.push({ id: uid('audit'), circleId, type, targetId, at: Date.now(), actorName: actor?.name || '当前成员', details });
}
export function resetDemoData(): boolean {
  try { storageSet(DB_KEY, seedDb()); storageSet(ACTOR_KEY, DEMO_OWNER); DEMO_ACTOR = DEMO_OWNER; return true; }
  catch (_) { return false; }
}

function roleFor(db: DemoDb, circleId: string): Role | undefined {
  const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
  return member && member.role;
}
function isAdmin(role?: Role): boolean { return role === 'owner' || role === 'admin'; }
function getCircle(db: DemoDb, id: string): Circle | undefined { return db.circles.find(c => c.id === id); }
function visiblePerson(raw: Person): Person {
  const db = loadDb();
  const p = clone(hydratedDemoPerson(db, raw));
  const self = raw.claimedBy === DEMO_ACTOR;
  const actorMember = db.members.find(m => m.circleId === raw.circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
  const delegation = db.delegations.find(d => d.personId === raw.id && d.adminMemberId === actorMember?.id && d.active);
  const delegatedFields = delegation ? effectiveDelegationFields(delegation.fields) : [];
  p.isSelf = self;
  p.isClaimed = !!raw.claimedBy;
  p.profileComplete = profileComplete(p);
  delete p.claimedBy;
  delete p.matchPhone;
  delete p.profileOverrides;
  if (!self) {
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
  if (!getCircle(db, circleId)) return bad('NOT_FOUND', '这份亲友录不存在');
  if (!roleFor(db, circleId)) return bad('FORBIDDEN', '你还不是这份亲友录的成员');
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
  if (circle?.type !== 'family') return bad('WRONG_CIRCLE_TYPE', '同窗录不能录入亲属关系');
  if (!change || (!change.removeRelationId && !change.relation)) return bad('INVALID_INPUT', '请选择要修改的关系');
  const before = change.removeRelationId ? db.relations.find(r => r.id === change.removeRelationId && r.circleId === circleId) : undefined;
  if (change.removeRelationId && !before) return bad('NOT_FOUND', '要修改的关系不存在');
  const current = db.relations.filter(r => r.circleId === circleId && r.id !== change.removeRelationId);
  const after = change.relation;
  if (after) {
    if (!after.from || !after.to || after.from === after.to) return bad('INVALID_INPUT', '请选择两个不同的人');
    if (!db.persons.some(person => person.id === after.from && person.circleId === circleId) ||
      !db.persons.some(person => person.id === after.to && person.circleId === circleId)) return bad('INVALID_INPUT', '人物不属于当前亲友录');
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

function initialRelationDraft(db: DemoDb, circleId: string, newPersonId: string, raw: unknown): ApiResult<RelationInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('INVALID_INPUT', '请选择与现有人物的关系');
  const choice = raw as Partial<InitialRelation>;
  if (getCircle(db, circleId)?.type !== 'family') return bad('WRONG_CIRCLE_TYPE', '同窗录不能录入亲属关系');
  const anchor = db.persons.find(person => person.circleId === circleId && person.id === choice.anchorPersonId);
  if (!anchor) return bad('INVALID_INPUT', '关联的人物不在这份家人录中');
  if (!['newParent', 'newChild', 'spouse', 'sibling'].includes(String(choice.kind))) return bad('INVALID_INPUT', '请选择关系类型');
  if (choice.kind === 'sibling') {
    if (choice.older !== undefined && !['unknown', 'new', 'anchor'].includes(choice.older)) return bad('INVALID_INPUT', '请选择正确的长幼顺序');
    return good({from: newPersonId, to: anchor.id, type: 'sibling', ...(choice.older === 'new' ? {olderId: newPersonId} : choice.older === 'anchor' ? {olderId: anchor.id} : {})});
  }
  if (choice.older !== undefined) return bad('INVALID_INPUT', '长幼顺序只适用于兄弟姐妹');
  if (choice.kind === 'newParent') return good({from: newPersonId, to: anchor.id, type: 'parent'});
  if (choice.kind === 'newChild') return good({from: anchor.id, to: newPersonId, type: 'parent'});
  return good({from: newPersonId, to: anchor.id, type: 'spouse'});
}

type PhoneLink = {circleId: string; personId: string};
function currentDemoPhoneIdentity(db: DemoDb): {phone: string; verifiedAt: number} | undefined {
  const identity = db.phoneIdentities?.[DEMO_ACTOR];
  return identity && Date.now() - identity.verifiedAt < 90 * 24 * 60 * 60 * 1000 ? identity : undefined;
}
function matchingPhoneError(db: DemoDb, person: Person, actorId: string): ApiResult<any> | undefined {
  if (!person.matchPhone) return undefined;
  const identity = db.phoneIdentities?.[actorId];
  if (!identity || Date.now() - identity.verifiedAt >= 90 * 24 * 60 * 60 * 1000 || identity.phone !== person.matchPhone)
    return bad('PHONE_MISMATCH', '这张资料的核对手机号与申请人已验证手机号不一致，请先更正手机号或选择其他人');
  return undefined;
}
function linkDemoVerifiedPhone(db: DemoDb): {linked: PhoneLink[]; alreadyLinked: PhoneLink[]; skipped: number} {
  const result = {linked: [] as PhoneLink[], alreadyLinked: [] as PhoneLink[], skipped: 0};
  const identity = currentDemoPhoneIdentity(db);
  if (!identity) return result;
  const matching = db.persons.filter(person => person.matchPhone === identity.phone);
  const byCircle = new Map<string, Person[]>();
  matching.forEach(person => byCircle.set(person.circleId, [...(byCircle.get(person.circleId) || []), person]));
  byCircle.forEach((persons, circleId) => {
    if (persons.length !== 1) { result.skipped += persons.length; return; }
    const person = persons[0];
    const circle = getCircle(db, circleId);
    const prior = db.members.find(member => member.circleId === circleId && member.actorId === DEMO_ACTOR && member.status === 'joined');
    const existingSelf = db.persons.find(other => other.circleId === circleId && other.claimedBy === DEMO_ACTOR);
    if (!circle || circle.mode !== 'shared' || !profileComplete(person) || person.claimedBy || existingSelf ||
      prior?.status !== 'joined' || (prior.personId && prior.personId !== person.id)) { result.skipped++; return; }
    // A matched phone cannot enroll someone into another person's record.
    // Keep account-owned profile values separate from administrator-entered cards.
    prior.personId = person.id;
    person.claimedBy = DEMO_ACTOR;
    person.matchPhone = undefined;
    person.updatedAt = nextDemoPersonUpdatedAt(person);
    db.claimRequests.filter(request => request.circleId === circleId && request.actorId === DEMO_ACTOR && request.status === 'pending')
      .forEach(request => { request.status = request.personId === person.id ? 'approved' : 'rejected'; });
    recordAudit(db, circleId, 'person.phoneLinked', person.id);
    result.linked.push({circleId, personId: person.id});
  });
  return result;
}

function mockInvoke(action: string, p: any): ApiResult<any> {
  getDemoActor();
  // Work on a detached copy so a failed storage write cannot appear saved in
  // the current session (some test and device storage adapters return objects by reference).
  const db = clone(loadDb());
  const circleId = p.circleId as string;
  if (action === 'account.verifyPhone') {
    // Local demo has no WeChat proof. This fixed code can only simulate the
    // documented test number; it never accepts a client-chosen phone value.
    if (p.code !== 'demo-verified-phone') return bad('INVALID_PHONE_CODE', '本地演示请使用页面上的模拟验证按钮');
    db.phoneIdentities ||= {};
    const phone = DEMO_ACTOR === DEMO_DAD ? DEMO_DAD_PHONE : DEMO_ACTOR === DEMO_GUEST ? DEMO_GUEST_PHONE : DEMO_ACTOR === DEMO_GUEST2 ? DEMO_GUEST2_PHONE : DEMO_VERIFIED_PHONE;
    db.phoneIdentities[DEMO_ACTOR] = {phone, verifiedAt: Date.now()};
    const linked = linkDemoVerifiedPhone(db);
    saveDb(db);
    return good({hasVerifiedPhone: true, ...linked});
  }
  if (action === 'account.sync') {
    const hasVerifiedPhone = !!currentDemoPhoneIdentity(db);
    if (!hasVerifiedPhone && db.phoneIdentities?.[DEMO_ACTOR]) {
      delete db.phoneIdentities[DEMO_ACTOR];
      saveDb(db);
    }
    const linked = linkDemoVerifiedPhone(db);
    if (linked.linked.length) saveDb(db);
    return good({hasVerifiedPhone, ...linked});
  }
  if (action === 'account.profile.get') {
    const profile = db.userProfiles?.[DEMO_ACTOR];
    return good({profile: profile ? demoProfileView(profile) : null, photoUploadTarget: demoOwnPhotoTarget(db)});
  }
  if (action === 'account.profile.update') {
    if (!p.patch || typeof p.patch !== 'object' || Array.isArray(p.patch)) return bad('INVALID_INPUT', '请求内容格式错误');
    const patch: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(p.patch)) {
      if (!SHARED_PROFILE_FIELDS.includes(key as SharedProfileField) || key === 'photoFileId' || key === 'photoUrl') return bad('INVALID_INPUT', `不能修改字段 ${key}`);
      if (raw === null || raw === '') {
        if (key === 'name') return bad('INVALID_INPUT', '姓名不能为空');
        patch[key] = undefined; continue;
      }
      if (key === 'birthday') {
        const birthday = parseBirthday(raw);
        if (!birthday) return bad('INVALID_INPUT', '生日月日或历法不正确');
        patch[key] = birthday;
      } else if (key === 'gender') {
        if (raw !== 'male' && raw !== 'female' && raw !== 'unknown') return bad('INVALID_INPUT', '性别格式不正确');
        patch[key] = raw;
      } else if (key === 'latitude' || key === 'longitude') {
        const limit = key === 'latitude' ? 90 : 180;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > limit) return bad('INVALID_INPUT', '城市坐标超出范围');
        patch[key] = Math.round(raw * 10) / 10;
      } else {
        const max = key === 'bio' ? 500 : key === 'phone' ? 30 : 120;
        if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > max) return bad('INVALID_INPUT', `${key}内容不正确`);
        patch[key] = raw.trim();
      }
    }
    const latitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'latitude');
    const longitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'longitude');
    if (latitudeTouched !== longitudeTouched || (latitudeTouched && ((patch.latitude === undefined) !== (patch.longitude === undefined)))) return bad('INVALID_INPUT', '城市坐标须同时填写或同时清除');
    const previous = db.userProfiles?.[DEMO_ACTOR];
    const next = {...(previous || {cardFallback: true}), ...patch, updatedAt: Date.now()} as DemoProfile;
    const wasComplete = !!(previous?.name?.trim() && previous.country?.trim() && previous.city?.trim() && previous.birthday);
    if (wasComplete && !(next.name?.trim() && next.country?.trim() && next.city?.trim() && next.birthday)) return bad('PROFILE_INCOMPLETE', '个人资料须保留姓名、国家或地区、城市和生日');
    const locationChanged = ['country','province','city'].some(key => Object.prototype.hasOwnProperty.call(patch, key) && (previous as any)?.[key] !== patch[key]);
    if (!next.city || (locationChanged && !latitudeTouched)) { next.latitude = undefined; next.longitude = undefined; }
    if (latitudeTouched && patch.latitude !== undefined && !next.city) return bad('INVALID_INPUT', '请先填写城市再确认城市中心点');
    touchDemoProfile(next, Object.keys(patch) as SharedProfileField[]);
    if (profileComplete(next as Person)) next.cardFallback = false;
    db.userProfiles ||= {};
    db.userProfiles[DEMO_ACTOR] = next;
    for (const person of db.persons) if (person.claimedBy === DEMO_ACTOR) {
      for (const key of Object.keys(patch)) (person as any)[key] = (next as any)[key];
      if (locationChanged && !latitudeTouched) { person.latitude = undefined; person.longitude = undefined; }
      person.updatedAt = nextDemoPersonUpdatedAt(person);
    }
    saveDb(db);
    return good({profile: demoProfileView(next)});
  }
  if (action === 'circle.list') {
    return good({ circles: db.circles.filter(c => !!roleFor(db, c.id)).map(c => ({ ...c, role: roleFor(db, c.id), memberCount: db.members.filter(m => m.circleId === c.id && m.status === 'joined').length, personCount: db.persons.filter(person => person.circleId === c.id).length })) });
  }
  if (action === 'circle.create') {
    if (!p.name || !String(p.name).trim()) return bad('INVALID', '请填写亲友录名称');
    if (p.type !== 'family' && p.type !== 'classmate') return bad('INVALID', '请选择亲友录类型');
    if (p.type === 'classmate' && (!p.school || !p.cohort || !p.className)) return bad('INVALID', '请填写学校、届别和班级');
    const request = demoRequestKey(db, 'circle.create', '', p.requestId); if (!request.ok) return request;
    const fingerprint = JSON.stringify({ name: String(p.name).trim(), type: p.type, mode: p.mode === 'shared' ? 'shared' : 'private', school: p.school || '', cohort: p.cohort || '', className: p.className || '' });
    const existingRequest = request.data.key && db.createRequests[request.data.key];
    if (existingRequest) {
      if (existingRequest.fingerprint !== fingerprint) return bad('IDEMPOTENCY_CONFLICT', '上次创建的内容与本次不同，请重新打开新建页面');
      const existing = db.circles.find(circle => circle.id === existingRequest.id);
      return existing ? good({circle: {...existing, personCount: db.persons.filter(person => person.circleId === existing.id).length}}) : bad('NOT_FOUND', '上次创建的亲友录已不存在');
    }
    const circle: Circle = { id: uid('circle'), name: String(p.name).trim(), type: p.type, mode: p.mode === 'shared' ? 'shared' : 'private', school: p.school, cohort: p.cohort, className: p.className, role: 'owner', memberCount: 1, personCount: 0 };
    db.circles.push(circle);
    db.members.push({ id: uid('member'), circleId: circle.id, name: '我', role: 'owner', status: 'joined', actorId: DEMO_ACTOR });
    recordAudit(db, circle.id, 'circle.create', circle.id);
    if (request.data.key) db.createRequests[request.data.key] = {fingerprint, id: circle.id};
    saveDb(db);
    return good({ circle });
  }
  if (action === 'invite.preview') {
    const invite = db.invites.find(i => i.token === p.token);
    if (!invite) return bad('NOT_FOUND', '邀请不存在');
    const circle = getCircle(db, invite.circleId);
    if (!circle) return bad('NOT_FOUND', '亲友录不存在');
    const status = invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt <= Date.now() ? 'expired' : 'active';
    return good({ circle: { id: circle.id, name: circle.name, type: circle.type, school: circle.school, cohort: circle.cohort, className: circle.className }, expiresAt: invite.expiresAt, status });
  }
  if (action === 'invite.apply') {
    if (!currentDemoPhoneIdentity(db)) return bad('PHONE_LOGIN_REQUIRED', '请先用微信手机号登录');
    if (p.claimPersonId !== undefined) return bad('INVALID_INPUT', '请先申请加入，审核通过后再申请认领人物卡');
    const invite = db.invites.find(i => i.token === p.token);
    if (!invite) return bad('NOT_FOUND', '邀请不存在');
    if (invite.revokedAt || invite.usedAt || invite.expiresAt <= Date.now()) return bad('INVITE_UNAVAILABLE', '这份邀请已失效，请联系管理员重新邀请');
    if (db.members.some(member => member.circleId === invite.circleId && member.actorId === DEMO_ACTOR && member.status === 'joined')) return bad('ALREADY_MEMBER', '你已经加入这份亲友录');
    const own = db.userProfiles?.[DEMO_ACTOR];
    if (!own?.name?.trim() || !own.country?.trim() || !own.city?.trim() || !own.birthday) return bad('PROFILE_INCOMPLETE', '请先在我的资料填写姓名、城市和生日');
    const profile = parseProfile(own);
    if (!profile) return bad('PROFILE_INCOMPLETE', '请先在我的资料填写姓名、城市和生日');
    if (getCircle(db, invite.circleId)?.type === 'classmate' && !String(p.note || '').trim()) return bad('INVALID_INPUT', '请填写同班核对说明');
    const name = own.name.trim();
    const prior = db.applications.find(a => a.inviteId === invite.id && a.actorId === DEMO_ACTOR);
    if (prior?.status === 'rejected') return bad('APPLICATION_REJECTED', '这次加入申请已被拒绝，请联系管理员获取新邀请');
    if (prior?.status === 'pending') {
      const {actorId: _actorId, ...visible} = prior;
      return good({application: visible});
    }
    if (db.applications.filter(a => a.inviteId === invite.id && a.status === 'pending').length >= 20) return bad('INVITE_FULL', '此邀请申请人数过多，请联系管理员重新邀请');
    const application: JoinApplication = { id: uid('join'), circleId: invite.circleId, inviteId: invite.id, applicantName: name, name, profile, profileVersion: own.updatedAt, note: p.note || '', status: 'pending', createdAt: Date.now(), actorId: DEMO_ACTOR };
    db.applications.push(application);
    saveDb(db);
    const {actorId: _actorId, ...visible} = application;
    return good({ application: visible });
  }
  if (action === 'join.mine') {
    if (p.inviteToken !== undefined && p.applicationId !== undefined) return bad('INVALID_INPUT', '请只选择一种申请查询方式');
    const requestedInvite = p.inviteToken === undefined ? undefined : db.invites.find(i => typeof p.inviteToken === 'string' && i.token === p.inviteToken);
    if (p.inviteToken !== undefined && !requestedInvite) return bad('INVALID_INVITE', '邀请不存在或已失效');
    const mine = db.applications.filter(a => !a.actorId || a.actorId === DEMO_ACTOR)
      .sort((a, b) => b.createdAt - a.createdAt);
    const selected = requestedInvite ? mine.filter(a => a.actorId === DEMO_ACTOR && a.inviteId === requestedInvite.id && a.circleId === requestedInvite.circleId)
      : p.applicationId ? mine.filter(a => a.id === p.applicationId) : mine.slice(0, 20);
    return good({ applications: selected.map(a => {
      const invite = db.invites.find(i => i.id === a.inviteId);
      const inviteStatus = !invite ? 'expired' : invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt <= Date.now() ? 'expired' : 'active';
      const status = a.status === 'pending' && inviteStatus !== 'active' ? 'expired' : a.status;
      const {actorId: _actorId, ...visible} = a;
      return {...visible, status, inviteStatus, canEnter: status === 'approved' && !!roleFor(db, a.circleId), circleName: getCircle(db, a.circleId)?.name || '亲友录', circleType: getCircle(db, a.circleId)?.type};
    }), hasMore: !requestedInvite && !p.applicationId && mine.length > 20 });
  }
  if (action === 'birthday.upcoming') {
    const days = p.days === undefined ? 30 : p.days;
    if (!Number.isInteger(days) || days < 0 || days > 366) return bad('INVALID_INPUT', '生日查询范围须为 0 至 366 天');
    if (circleId && !roleFor(db, circleId)) return bad('FORBIDDEN', '你还不是这份亲友录的成员');
    const circles = db.circles.filter(circle => (circleId ? circle.id === circleId : true) && !!roleFor(db, circle.id));
    const people: Array<{circle: Circle; person: Person}> = [];
    const seenOwners = new Set<string>();
    for (const circle of circles.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      for (const raw of db.persons) {
        if (raw.circleId !== circle.id || raw.claimedBy === DEMO_ACTOR) continue;
        const person = hydratedDemoPerson(db, raw);
        if (!profileComplete(person)) continue;
        if (!circleId && raw.claimedBy) {
          if (seenOwners.has(raw.claimedBy)) continue;
          seenOwners.add(raw.claimedBy);
        }
        people.push({circle, person});
      }
    }
    let calendar: BirthdayCalendar;
    try { calendar = new BirthdayCalendar(Date.now(), days, people.some(({person}) => person.birthday?.calendar === 'lunar')); }
    catch { return bad('LUNAR_CALENDAR_UNAVAILABLE', '当前设备暂不支持农历计算，请稍后再试'); }
    const events = people.reduce<Array<{personId: string; personName: string; circleId: string; circleName: string; date: string; daysUntil: number; birthdayCalendar: 'solar' | 'lunar'; birthdayText: string}>>((rows, {circle, person}) => {
      const occurrence = calendar.next(person.birthday!);
      if (occurrence) rows.push({personId: person.id, personName: person.name, circleId: circle.id, circleName: circle.name, date: occurrence.date, daysUntil: occurrence.daysUntil, birthdayCalendar: person.birthday!.calendar, birthdayText: occurrence.birthdayText});
      return rows;
    }, []).sort((a, b) => a.daysUntil - b.daysUntil || a.circleName.localeCompare(b.circleName, 'zh-CN') || a.personName.localeCompare(b.personName, 'zh-CN'));
    return good({events});
  }
  if (action === 'photo.url' && !circleId && p.personId === undefined) {
    const profile = db.userProfiles?.[DEMO_ACTOR];
    return profile?.photoUrl ? good({url: profile.photoUrl}) : bad('NOT_FOUND', '照片不存在');
  }
  if (action === 'photo.upload' && !circleId && p.personId === undefined) {
    const base64 = String(p.base64 || '');
    const byteLength = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (!base64.startsWith('/9j/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || byteLength > 1024 * 1024) return bad('INVALID_INPUT', '请上传不超过 1 MB 的 JPG 照片');
    const fs = wx.getFileSystemManager?.();
    const directory = wx.env?.USER_DATA_PATH;
    if (!fs?.writeFileSync || !directory) return bad('PHOTO_UNAVAILABLE', '当前设备无法持久保存演示照片');
    const path = `${directory}/demo-photo-account-${DEMO_ACTOR}-${uid('file')}.jpg`;
    try { fs.writeFileSync(path, base64, 'base64'); }
    catch (_) { return bad('PHOTO_SAVE_FAILED', '演示照片保存失败，请清理本机存储后重试'); }
    const profile: DemoProfile = {...db.userProfiles?.[DEMO_ACTOR], photoUrl: path, photoFileId: `demo-photo-account-${DEMO_ACTOR}`, updatedAt: Date.now()};
    touchDemoProfile(profile, ['photoUrl', 'photoFileId']);
    db.userProfiles ||= {};
    db.userProfiles[DEMO_ACTOR] = profile;
    for (const person of db.persons) if (person.claimedBy === DEMO_ACTOR) {
      person.photoUrl = path; person.photoFileId = profile.photoFileId;
      person.updatedAt = nextDemoPersonUpdatedAt(person);
    }
    try { saveDb(db); }
    catch (_) {
      try { fs.unlinkSync?.(path); } catch (_) { /* New file has no stored reference. */ }
      return bad('STORAGE_FULL', '演示资料存储空间不足，照片没有保存');
    }
    return good({profile: demoProfileView(profile)});
  }
  if (!circleId) return bad('INVALID', '缺少亲友录 ID');
  const access = requireMember(db, circleId);
  if (access) return access;

  if (action === 'circle.detail') {
    const transfer = db.ownerTransfers.find(t => t.circleId === circleId && t.expiresAt > Date.now());
    const target = transfer && db.members.find(m => m.id === transfer.targetMemberId && m.status === 'joined');
    const actor = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
    const ownerTransfer = transfer && target && actor && (actor.id === transfer.ownerMemberId || actor.id === transfer.targetMemberId)
      ? {id: transfer.id, targetMemberId: target.id, targetName: target.name || '成员', expiresAt: transfer.expiresAt,
        isTarget: actor.id === target.id, isOwner: actor.id === transfer.ownerMemberId} : null;
    return good({ circle: { ...getCircle(db, circleId), role: roleFor(db, circleId), memberCount: db.members.filter(m => m.circleId === circleId && m.status === 'joined').length, personCount: db.persons.filter(person => person.circleId === circleId).length }, role: roleFor(db, circleId), ownerTransfer });
  }
  if (action === 'circle.transferOwner') {
    if (roleFor(db, circleId) !== 'owner') return bad('FORBIDDEN', '只有创建者可以移交管理权');
    const current = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
    const target = db.members.find(m => m.id === p.memberId && m.circleId === circleId && m.status === 'joined');
    if (!current || !target || target.id === current.id) return bad('INVALID', '请选择这份亲友录中的其他成员');
    if (db.ownerTransfers.some(t => t.circleId === circleId && t.expiresAt > Date.now())) return bad('TRANSFER_PENDING', '已有管理权移交待对方确认，请先取消');
    db.ownerTransfers = db.ownerTransfers.filter(t => t.circleId !== circleId);
    const transfer = {id: uid('owner-transfer'), circleId, ownerMemberId: current.id, targetMemberId: target.id, expiresAt: Date.now() + 72 * 60 * 60 * 1000};
    db.ownerTransfers.push(transfer);
    recordAudit(db, circleId, 'circle.transferRequested', target.id, {status: 'pending'});
    saveDb(db); return good({ ownerTransfer: {id: transfer.id, targetMemberId: target.id, targetName: target.name || '成员', expiresAt: transfer.expiresAt, isTarget: false, isOwner: true} });
  }
  if (action === 'circle.cancelOwnerTransfer' || action === 'circle.acceptOwnerTransfer') {
    const transfer = db.ownerTransfers.find(t => t.circleId === circleId && t.id === p.transferId);
    if (!transfer || transfer.expiresAt <= Date.now()) return bad('TRANSFER_EXPIRED', '这份管理权移交已失效，请重新发起');
    const current = db.members.find(m => m.id === transfer.ownerMemberId && m.status === 'joined' && m.role === 'owner');
    const target = db.members.find(m => m.id === transfer.targetMemberId && m.status === 'joined');
    const actor = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
    if (!current || !target || !actor) return bad('TRANSFER_EXPIRED', '移交成员已变更，请重新发起');
    if (action === 'circle.cancelOwnerTransfer') {
      if (actor.id !== current.id && actor.id !== target.id) return bad('FORBIDDEN', '只有移交双方可以取消');
      db.ownerTransfers = db.ownerTransfers.filter(t => t.id !== transfer.id);
      recordAudit(db, circleId, actor.id === current.id ? 'circle.transferCancelled' : 'circle.transferRejected', target.id);
      saveDb(db); return good({cancelled: true});
    }
    // The local demo has only one signed-in actor. Explicitly simulate the
    // recipient's acceptance from the owner view; cloud mode never uses this.
    if (actor.id !== target.id && !(p.demoAcceptAsTarget === true && actor.id === current.id)) return bad('FORBIDDEN', '只有接收方可以接受管理权移交');
    current.role = 'admin'; target.role = 'owner';
    db.ownerTransfers = db.ownerTransfers.filter(t => t.id !== transfer.id);
    recordAudit(db, circleId, 'circle.transferAccepted', target.id);
    saveDb(db); return good({circle: getCircle(db, circleId), member: {id: target.id, role: target.role}});
  }
  if (action === 'circle.upgrade') {
    if (roleFor(db, circleId) !== 'owner') return bad('FORBIDDEN', '只有创建者可以开启邀请共建');
    if (p.privacyReviewed !== true) return bad('PRIVACY_REVIEW_REQUIRED', '请先确认历史资料适合供新成员查看');
    const circle = getCircle(db, circleId)!;
    circle.mode = 'shared'; saveDb(db); return good({ circle });
  }
  if (action === 'person.list') return good({ persons: db.persons.filter(x => x.circleId === circleId).map(visiblePerson) });
  if (action === 'person.get') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    return person ? good({ person: visiblePerson(person) }) : bad('NOT_FOUND', '人物卡不存在');
  }
  if (action === 'person.remark.list') {
    if (Object.keys(p).some(key => key !== 'circleId')) return bad('INVALID_INPUT', '备注字段不支持');
    const people = new Set(db.persons.filter(person => person.circleId === circleId).map(person => person.id));
    const remarks: Record<string, string> = {};
    for (const row of Object.values(db.personRemarks || {})) {
      if (row.actorId === DEMO_ACTOR && row.circleId === circleId && people.has(row.personId) && row.remark) remarks[row.personId] = row.remark;
    }
    return good({remarks});
  }
  if (action === 'person.remark.get' || action === 'person.remark.update') {
    const updating = action === 'person.remark.update';
    const allowed = updating ? ['circleId', 'personId', 'remark'] : ['circleId', 'personId'];
    if (Object.keys(p).some(key => !allowed.includes(key))) return bad('INVALID_INPUT', '备注字段不支持');
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物不存在');
    const key = JSON.stringify([circleId, person.id, DEMO_ACTOR]);
    const rows = db.personRemarks ||= {};
    if (!updating) {
      const row = rows[key];
      return good({remark: row?.actorId === DEMO_ACTOR && row.circleId === circleId && row.personId === person.id ? row.remark : ''});
    }
    if (typeof p.remark !== 'string' || p.remark.trim().length > 200) return bad('INVALID_INPUT', '备注最多填写 200 字');
    const remark = p.remark.trim();
    if (remark) rows[key] = {circleId, personId: person.id, actorId: DEMO_ACTOR, remark};
    else delete rows[key];
    try { saveDb(db); }
    catch (_) { return bad('STORAGE_FULL', '演示资料存储空间不足，备注没有保存'); }
    return good({remark});
  }
  if (action === 'person.matchPhone') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物不存在');
    if (person.claimedBy) return bad('PERSON_CLAIMED', '这位人物的核对手机号不能修改');
    return good({matchPhone: person.matchPhone || ''});
  }
  if (action === 'photo.url') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    const visible = visiblePerson(person);
    if (!visible.photoUrl) return bad('NOT_FOUND', '照片不存在');
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
    if (!person || (person.claimedBy !== DEMO_ACTOR && !isAdmin(roleFor(db, circleId)))) return bad('FORBIDDEN', '只有本人或管理员可以修改照片');
    const base64 = String(p.base64 || '');
    const byteLength = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (!base64.startsWith('/9j/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || byteLength > 1024 * 1024) return bad('INVALID_INPUT', '请上传不超过 1 MB 的 JPG 照片');
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
    updated.visibility = { ...(updated.visibility || {}), photoFileId: 'circle' };
    updated.updatedAt = nextDemoPersonUpdatedAt(updated);
    if (updated.claimedBy) {
      const profile = nextDb.userProfiles?.[updated.claimedBy];
      if (updated.claimedBy === DEMO_ACTOR) {
        const own = profile || ensureDemoProfile(nextDb, updated, updated.claimedBy);
        own.photoUrl = path;
        own.photoFileId = updated.photoFileId;
        touchDemoProfile(own, ['photoUrl', 'photoFileId']);
        own.updatedAt = updated.updatedAt;
        if (updated.profileOverrides) { delete updated.profileOverrides.photoFileId; delete updated.profileOverrides.photoUrl; }
      } else if (profile) {
        updated.profileOverrides ||= {};
        updated.profileOverrides.photoUrl = {baseRevision: demoProfileRevision(profile, 'photoUrl'), value: path};
        updated.profileOverrides.photoFileId = {baseRevision: demoProfileRevision(profile, 'photoFileId'), value: updated.photoFileId};
      }
    }
    recordAudit(nextDb, circleId, updated.claimedBy === DEMO_ACTOR ? 'person.update' : 'person.maintain', updated.id, {fields: ['photoFileId']});
    try { wx.setStorageSync(DB_KEY, nextDb); }
    catch (_) {
      try { fs.unlinkSync?.(path); } catch (_) { /* The saved file is inaccessible without its DB reference. */ }
      return bad('STORAGE_FULL', '演示资料存储空间不足，照片没有保存');
    }
    return good({ person: visiblePerson(updated) });
  }
  if (action === 'person.create') {
    const claimSelf = p.claimSelf === true;
    if (!claimSelf) { const denied = requireAdmin(db, circleId); if (denied) return denied; }
    if (p.matchPhone !== undefined && claimSelf) return bad('FORBIDDEN', '只有管理员添加家人或同学时可以设置核对手机号');
    const matchPhone = p.matchPhone === undefined || p.matchPhone === '' ? undefined : normalizeMatchPhone(p.matchPhone);
    if (matchPhone === null) return bad('INVALID_INPUT', '核对手机号格式不正确');
    if (!p.name || !String(p.name).trim()) return bad('INVALID', '请填写姓名');
    const request = demoRequestKey(db, 'person.create', circleId, p.requestId); if (!request.ok) return request;
    if (p.deferRelation !== undefined && typeof p.deferRelation !== 'boolean') return bad('INVALID_INPUT', '请明确选择是否稍后补充关系');
    const deferRelation = p.deferRelation === true;
    if (deferRelation && p.initialRelation !== undefined) return bad('INVALID_INPUT', '已选择关系时不能同时选择稍后补充');
    if (p.deferRelation !== undefined && getCircle(db, circleId)?.type !== 'family') return bad('WRONG_CIRCLE_TYPE', '同窗录不需要设置亲属关系');
    if (!p.country || !p.city || !p.birthday) return bad('PROFILE_INCOMPLETE', '创建人物卡前请填完整国家或地区、城市和生日');
    const profile = parseProfile(p);
    if (!profile) return bad('INVALID_INPUT', '城市或生日格式不正确');
    const fingerprint = JSON.stringify({name: String(p.name).trim(), gender: p.gender || 'unknown', birthOrder: p.birthOrder ?? null, profile, claimSelf, matchPhone, ...(p.initialRelation !== undefined ? {initialRelation: p.initialRelation} : {}), ...(deferRelation ? {deferRelation: true} : {})});
    const existingRequest = request.data.key && db.createRequests[request.data.key];
    if (existingRequest) {
      if (existingRequest.fingerprint !== fingerprint) return bad('IDEMPOTENCY_CONFLICT', '上次创建的内容与本次不同，请重新打开新建页面');
      const existing = db.persons.find(person => person.id === existingRequest.id && person.circleId === circleId);
      return existing ? good({person: visiblePerson(hydratedDemoPerson(db, existing))}) : bad('NOT_FOUND', '上次创建的人物卡已不存在');
    }
    if (getCircle(db, circleId)?.type === 'family' && p.initialRelation === undefined && !deferRelation && db.persons.some(person => person.circleId === circleId)) {
      return bad('RELATION_REQUIRED', '请先选择这位家人与已有家人的关系');
    }
    if (matchPhone && db.persons.some(person => person.circleId === circleId && person.matchPhone === matchPhone)) return bad('PHONE_ALREADY_USED', '这个手机号在亲友录内已用于其他人物，请核对');
    if (claimSelf && db.persons.some(x => x.circleId === circleId && x.claimedBy === DEMO_ACTOR)) return bad('ALREADY_HAS_PERSON', '你在这份亲友录里已有本人卡');
    if (claimSelf && db.claimRequests.some(x => x.circleId === circleId && x.actorId === DEMO_ACTOR && x.status === 'pending')) return bad('CLAIM_PENDING', '已有认领申请正在审核，请先等待结果');
    const person: Person = { id: uid('person'), circleId, name: String(p.name).trim(), gender: p.gender || 'unknown', birthOrder: p.birthOrder, ...profile, profileComplete: true, visibility: {}, matchPhone, claimedBy: claimSelf ? DEMO_ACTOR : undefined, updatedAt: Date.now() };
    let initialRelation: Relation | undefined;
    if (p.initialRelation !== undefined) {
      const draft = initialRelationDraft(db, circleId, person.id, p.initialRelation);
      if (!draft.ok) return draft;
      const preview = previewDemoRelation({...db, persons: [...db.persons, person]}, circleId, {relation: draft.data});
      if (!preview.ok) return preview;
      initialRelation = {id: uid('relation'), circleId, ...draft.data};
    }
    db.persons.push(person);
    if (initialRelation) {
      db.relations.push(initialRelation);
      for (const endpointId of [initialRelation.from, initialRelation.to]) {
        const endpoint = db.persons.find(row => row.id === endpointId);
        if (endpoint) endpoint.updatedAt = nextDemoPersonUpdatedAt(endpoint);
      }
    }
    if (claimSelf) {
      const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
      if (member) member.personId = person.id;
      ensureDemoProfile(db, person, DEMO_ACTOR);
    }
    if (request.data.key) db.createRequests[request.data.key] = {fingerprint, id: person.id};
    saveDb(db);
    return good({ person: visiblePerson(hydratedDemoPerson(db, person)), relation: initialRelation });
  }
  if (action === 'person.update') {
    const nextDb = clone(db);
    const person = nextDb.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    const self = person.claimedBy === DEMO_ACTOR;
    const admin = isAdmin(roleFor(nextDb, circleId));
    if (!self && !admin) return bad('FORBIDDEN', '只有本人或管理员可以修改资料');
    if (p.matchPhone !== undefined) {
      if (!admin || !!person.claimedBy) return bad('FORBIDDEN', '只有管理员可以设置未关联资料的核对手机号');
      const matchPhone = p.matchPhone === null || p.matchPhone === '' ? undefined : normalizeMatchPhone(p.matchPhone);
      if (matchPhone === null) return bad('INVALID_INPUT', '核对手机号格式不正确');
      if (matchPhone && nextDb.persons.some(other => other.id !== person.id && other.circleId === circleId && other.matchPhone === matchPhone)) return bad('PHONE_ALREADY_USED', '这个手机号在亲友录内已用于其他人物，请核对');
      person.matchPhone = matchPhone;
    }
    if (p.visibility !== undefined) return bad('INVALID_INPUT', '亲友录内资料已统一可见，无需设置可见范围');
    const allowed = ['name','nickname','gender','birthOrder','country','province','city','latitude','longitude','birthday','status','industry','occupation','school','bio','phone','wechatId','photoFileId','photoUrl'];
    const patch = p.patch || {};
    if (Object.prototype.hasOwnProperty.call(patch, 'matchPhone')) return bad('INVALID_INPUT', '核对手机号只能通过管理员专用字段修改');
    const latitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'latitude');
    const longitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'longitude');
    if (latitudeTouched !== longitudeTouched) return bad('INVALID_INPUT', '城市坐标须同时填写或同时清除');
    const latitude = patch.latitude == null || patch.latitude === '' ? undefined : patch.latitude;
    const longitude = patch.longitude == null || patch.longitude === '' ? undefined : patch.longitude;
    if (latitudeTouched && ((latitude === undefined) !== (longitude === undefined))) return bad('INVALID_INPUT', '城市坐标须同时填写或同时清除');
    if (latitude !== undefined && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) return bad('INVALID_INPUT', '城市坐标超出范围');
    const next = { ...hydratedDemoPerson(nextDb, person) };
    for (const key of Object.keys(patch)) {
      if (allowed.indexOf(key) < 0) continue;
      if (key === 'birthday' && !parseBirthday(patch[key])) return bad('INVALID_INPUT', '生日月日或历法不正确');
      (next as any)[key] = key === 'latitude' ? (latitude === undefined ? undefined : Math.round(latitude * 10) / 10) :
        key === 'longitude' ? (longitude === undefined ? undefined : Math.round(longitude * 10) / 10) : patch[key];
    }
    if (typeof patch.photoUrl === 'string' && patch.photoUrl) next.photoFileId = `demo-photo-${person.id}`;
    else if (Object.prototype.hasOwnProperty.call(patch, 'photoUrl') && !patch.photoUrl) next.photoFileId = undefined;
    if (latitude !== undefined && !next.city) return bad('INVALID_INPUT', '请先填写城市再确认城市中心点');
    const locationNameChanged = ['city','country','province'].some(key => Object.prototype.hasOwnProperty.call(patch, key) && (next as any)[key] !== (person as any)[key]);
    if (!next.city || (locationNameChanged && !latitudeTouched)) { next.latitude = undefined; next.longitude = undefined; }
    if (profileComplete(person) && !profileComplete(next)) return bad('PROFILE_REQUIRED', '已导入的人物卡须保留国家、城市和生日');
    if (next.matchPhone && !profileComplete(next)) return bad('PROFILE_INCOMPLETE', '请先补齐城市和生日，再设置核对手机号');
    Object.assign(person, next);
    person.profileComplete = profileComplete(person);
    person.updatedAt = nextDemoPersonUpdatedAt(person);
    const changedShared = Object.keys(patch).filter(key => SHARED_PROFILE_FIELDS.includes(key as SharedProfileField)) as SharedProfileField[];
    if (locationNameChanged && !latitudeTouched) changedShared.push('latitude', 'longitude');
    if (person.claimedBy && changedShared.length) {
      const profile = nextDb.userProfiles?.[person.claimedBy] ||
        (self ? ensureDemoProfile(nextDb, person, person.claimedBy) : ensureDemoEmptyProfile(nextDb, person.claimedBy));
      if (self) {
        for (const field of changedShared) {
          (profile as any)[field] = (person as any)[field];
          if (person.profileOverrides) delete person.profileOverrides[field];
        }
        if (locationNameChanged && person.profileOverrides) for (const field of LOCATION_PROFILE_FIELDS) delete person.profileOverrides[field];
        touchDemoProfile(profile, changedShared);
        if (profileComplete(profile as Person)) profile.cardFallback = false;
        profile.updatedAt = person.updatedAt;
      } else {
        person.profileOverrides = {...person.profileOverrides};
        for (const field of changedShared) person.profileOverrides[field] =
          {baseRevision: demoProfileRevision(profile, field), value: (person as any)[field] ?? null};
      }
    }
    recordAudit(nextDb, circleId, self ? 'person.update' : 'person.maintain', person.id,
      {fields: [...Object.keys(patch), ...(p.matchPhone !== undefined ? ['matchPhone'] : [])]});
    try { wx.setStorageSync(DB_KEY, nextDb); }
    catch (_) { return bad('STORAGE_FULL', '演示资料存储空间不足，修改没有保存'); }
    return good({ person: visiblePerson(person) });
  }
  if (action === 'person.delete') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    if (person.claimedBy) return bad('PERSON_CLAIMED', '这位成员正在使用资料，不能直接删除');
    if (db.relations.some(r => r.circleId === circleId && (r.from === person.id || r.to === person.id))) return bad('PERSON_LINKED', '这张人物卡还连接着家庭关系，请先调整关系');
    const pendingClaims = db.claimRequests.filter(request => request.circleId === circleId && request.personId === person.id && request.status === 'pending');
    if (pendingClaims.length > 40) return bad('DATA_LIMIT', '待审关联申请过多，请先处理申请后再删除人物');
    for (const request of pendingClaims) request.status = 'rejected';
    db.persons = db.persons.filter(x => x.id !== person.id);
    for (const [key, row] of Object.entries(db.personRemarks || {})) if (row.circleId === circleId && row.personId === person.id) delete db.personRemarks![key];
    recordAudit(db, circleId, 'person.delete', person.id, {cancelledClaimCount: pendingClaims.length});
    saveDb(db);
    return good({ deleted: true });
  }
  if (action === 'person.claim') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person) return bad('NOT_FOUND', '人物卡不存在');
    if (person.claimedBy) return bad('ALREADY_CLAIMED', '这张人物卡已被认领');
    if (db.persons.some(x => x.circleId === circleId && x.claimedBy === DEMO_ACTOR)) return bad('ALREADY_HAS_PERSON', '你在这份亲友录里已有本人卡');
    const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
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
    if (action === 'person.claimApprove' && request.actorId === DEMO_ACTOR) return bad('FORBIDDEN', '不能审核自己的资料关联申请');
    if (action === 'person.claimReject') { request.status = 'rejected'; saveDb(db); return good({ claimRequest: request }); }
    const person = db.persons.find(x => x.id === request.personId && x.circleId === circleId);
    if (!person || person.claimedBy) return bad('ALREADY_CLAIMED', '人物卡已被认领');
    if (!request.actorId) return bad('INVALID_INPUT', '认领申请缺少成员身份');
    const member = db.members.find(m => m.circleId === circleId && m.actorId === request.actorId && m.status === 'joined');
    if (!member) return bad('FORBIDDEN', '申请人已退出这份亲友录，无法关联资料');
    if (db.persons.some(x => x.circleId === circleId && x.claimedBy === request.actorId)) return bad('ALREADY_HAS_PERSON', '申请人在这份亲友录里已有本人卡');
    const phoneError = matchingPhoneError(db, person, request.actorId); if (phoneError) return phoneError;
    person.claimedBy = request.actorId;
    person.matchPhone = undefined;
    person.updatedAt = nextDemoPersonUpdatedAt(person);
    member.personId = person.id;
    ensureDemoEmptyProfile(db, request.actorId);
    request.status = 'approved'; saveDb(db); return good({ claimRequest: request });
  }
  if (action === 'person.unclaim') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person || !person.claimedBy) return bad('INVALID_INPUT', '这张人物卡没有认领人');
    const targetMember = db.members.find(member => member.circleId === circleId && member.actorId === person.claimedBy && member.status === 'joined' && member.personId === person.id);
    const actorRole = roleFor(db, circleId);
    const targetRank = targetMember?.role === 'owner' ? 3 : targetMember?.role === 'admin' ? 2 : 1;
    const actorRank = actorRole === 'owner' ? 3 : actorRole === 'admin' ? 2 : 1;
    if (person.claimedBy === DEMO_ACTOR || !targetMember || actorRank <= targetRank) return bad('FORBIDDEN', '只能解除下级成员与资料的关联');
    targetMember.personId = undefined;
    person.claimedBy = undefined;
    person.profileOverrides = undefined;
    ['phone','matchPhone','wechatId','photoFileId','photoUrl','city','country','province','latitude','longitude','birthday','status','industry','occupation','school','bio'].forEach(key => { delete (person as any)[key]; });
    person.profileComplete = false;
    person.visibility = {};
    person.updatedAt = nextDemoPersonUpdatedAt(person);
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
    for (const personId of new Set([before?.from, before?.to, after?.from, after?.to].filter(Boolean))) {
      const endpoint = db.persons.find(person => person.id === personId);
      if (endpoint) endpoint.updatedAt = nextDemoPersonUpdatedAt(endpoint);
    }
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
    const now = Date.now();
    const invite: Invite = { id: uid('invite'), circleId, token: uid('token'), createdAt: now, expiresAt: now + 72 * 3600000 };
    db.invites.push(invite); recordAudit(db, circleId, 'invite.create', invite.id); saveDb(db); return good({ invite });
  }
  if (action === 'invite.list') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const invites: InviteSummary[] = db.invites.filter(invite => invite.circleId === circleId).map(invite => ({
      id: invite.id, circleId, createdAt: (invite as any).createdAt || invite.expiresAt - 72 * 3600000, expiresAt: invite.expiresAt,
      status: invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt <= Date.now() ? 'expired' : 'active'
    }));
    return good({invites});
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
      const review = demoApplicationReview(db, a);
      return {...visible, ...review, applicantName: review.name, inviteStatus, inviteExpiresAt: invite?.expiresAt};
    })});
  }
  if (action === 'join.approve' || action === 'join.reject') {
    const denied = requireAdmin(db, circleId); if (denied) return denied;
    const application = db.applications.find(a => a.id === p.applicationId && a.circleId === circleId);
    if (!application) return bad('NOT_FOUND', '申请不存在');
    if (application.status !== 'pending') return bad('INVALID', '这份申请已经处理过');
    if (action === 'join.reject') { application.status = 'rejected'; recordAudit(db, circleId, 'join.reject', application.id); saveDb(db); return good({ application }); }
    const guestActorId = application.actorId || `guest_${application.id}`;
    if (db.members.some(member => member.circleId === circleId && member.actorId === guestActorId && member.status === 'joined'))
      return bad('ALREADY_MEMBER', '申请人已经加入这份亲友录，请刷新审核列表');
    const invite = db.invites.find(i => i.id === application.inviteId);
    if (!invite || invite.revokedAt || invite.usedAt || invite.expiresAt <= Date.now()) return bad('INVITE_UNAVAILABLE', '邀请已失效，无法批准');
    const review = demoApplicationReview(db, application);
    const profile = review.profile;
    if (review.profileIncomplete || !review.name || !profile) return bad('PROFILE_INCOMPLETE', '申请人当前资料不完整，请让对方补齐后刷新');
    if ((p.reviewToken !== undefined && p.reviewToken !== review.reviewToken) || (review.profileChanged && p.reviewToken !== review.reviewToken))
      return bad('PROFILE_CHANGED', '申请人的资料已变化，请刷新审核列表后重新核对');
    if (p.targetPersonId !== undefined && (typeof p.targetPersonId !== 'string' || !p.targetPersonId)) return bad('INVALID_INPUT', '人物卡选择无效');
    if (p.deferRelation !== undefined && typeof p.deferRelation !== 'boolean') return bad('INVALID_INPUT', '请明确选择是否稍后补充关系');
    const deferRelation = p.deferRelation === true;
    if (deferRelation && (p.initialRelation !== undefined || p.targetPersonId !== undefined)) return bad('INVALID_INPUT', '关联已有资料或已选择关系时不能同时选择稍后补充');
    if (p.deferRelation !== undefined && getCircle(db, circleId)?.type !== 'family') return bad('WRONG_CIRCLE_TYPE', '同窗录不需要设置亲属关系');
    if (p.initialRelation !== undefined && p.targetPersonId !== undefined) return bad('INVALID_INPUT', '关联已有资料时不能同时为新人建立关系');
    if (p.initialRelation !== undefined && getCircle(db, circleId)?.type !== 'family') return bad('WRONG_CIRCLE_TYPE', '同窗录不能录入亲属关系');
    if (getCircle(db, circleId)?.type === 'family' && p.targetPersonId === undefined && p.initialRelation === undefined && !deferRelation &&
      db.persons.some(person => person.circleId === circleId)) return bad('RELATION_REQUIRED', '请先选择新家人与已有家人的关系');
    const target = p.targetPersonId ? db.persons.find(person => person.id === p.targetPersonId && person.circleId === circleId) : undefined;
    if (p.targetPersonId && (!target || target.claimedBy)) return bad('TARGET_UNAVAILABLE', '选择的人物卡已被认领或不存在，请刷新后重选');
    if (target && (!Number.isSafeInteger(p.targetPersonUpdatedAt) || p.targetPersonUpdatedAt !== target.updatedAt))
      return bad('TARGET_CHANGED', '这位人物的资料或关系已变化，请刷新后重新选择');
    const phoneError = target ? matchingPhoneError(db, target, application.actorId || '') : undefined;
    if (phoneError) return phoneError;
    if (target && db.claimRequests.some(request => request.circleId === circleId && request.personId === target.id && request.status === 'pending'))
      return bad('CLAIM_PENDING', '所选人物卡还有待审认领，请先处理');
    const person: Person = target || { id: uid('person'), circleId, name: review.name, gender: 'unknown', visibility: {}, updatedAt: Date.now() };
    let initialRelation: Relation | undefined;
    if (p.initialRelation !== undefined) {
      const draft = initialRelationDraft(db, circleId, person.id, p.initialRelation);
      if (!draft.ok) return draft;
      const preview = previewDemoRelation({...db, persons: [...db.persons, person]}, circleId, {relation: draft.data});
      if (!preview.ok) return preview;
      initialRelation = {id: uid('relation'), circleId, ...draft.data};
    }
    if (!target) db.persons.push(person);
    if (target) { person.latitude = undefined; person.longitude = undefined; person.province = undefined; person.matchPhone = undefined; }
    Object.assign(person, profile, { name: review.name, claimedBy: guestActorId, profileComplete: true,
      updatedAt: nextDemoPersonUpdatedAt(person) });
    ensureDemoEmptyProfile(db, guestActorId);
    db.members.push({ id: uid('member'), circleId, name: review.name, role: 'member', personId: person.id, status: 'joined', actorId: guestActorId });
    if (initialRelation) {
      db.relations.push(initialRelation);
      for (const endpointId of [initialRelation.from, initialRelation.to]) {
        const endpoint = db.persons.find(row => row.id === endpointId);
        if (endpoint) endpoint.updatedAt = nextDemoPersonUpdatedAt(endpoint);
      }
      recordAudit(db, circleId, 'relation.create', initialRelation.id, {created: initialRelation, source: 'join.approve'});
    }
    application.status = 'approved'; invite.usedAt = Date.now();
    db.applications.filter(a => a.id !== application.id && a.status === 'pending' &&
      (a.inviteId === invite.id || a.circleId === circleId && a.actorId === guestActorId)).forEach(a => { a.status = 'invalid'; });
    recordAudit(db, circleId, 'join.approve', application.id); saveDb(db); return good({ application });
  }
  if (action === 'member.list') return good({ members: db.members.filter(m => m.circleId === circleId && m.status === 'joined').map(({ actorId, ...m }) => {
    const linked = db.persons.find(person => person.id === m.personId && person.circleId === circleId);
    return {...m, name: linked ? hydratedDemoPerson(db, linked).name : m.name, isSelf: actorId === DEMO_ACTOR};
  }) });
  if (action === 'member.setRole') {
    if (roleFor(db, circleId) !== 'owner') return bad('FORBIDDEN', '只有创建者可以任免管理员');
    const target = db.members.find(m => m.id === p.memberId && m.circleId === circleId && m.status === 'joined');
    if (!target || target.role === 'owner' || (p.role !== 'admin' && p.role !== 'member')) return bad('INVALID', '请选择可调整的亲友录成员');
    target.role = p.role;
    if (p.role === 'member') db.delegations.filter(d => d.adminMemberId === target.id && d.active).forEach(d => { d.active = false; d.revokedAt = Date.now(); });
    recordAudit(db, circleId, 'member.setRole', target.id, { role: p.role });
    saveDb(db); return good({ member: { id: target.id, role: target.role } });
  }
  if (action === 'member.leave') {
    const member = db.members.find(m => m.circleId === circleId && m.actorId === DEMO_ACTOR && m.status === 'joined');
    if (!member) return bad('FORBIDDEN', '你还不是这份亲友录的成员');
    if (member.role === 'owner') return bad('OWNER_REQUIRED', '创建者须先移交管理权');
    member.status = 'left';
    db.claimRequests.filter(request => request.circleId === circleId && request.actorId === member.actorId && request.status === 'pending').forEach(request => { request.status = 'rejected'; });
    for (const [key, row] of Object.entries(db.personRemarks || {})) if (row.circleId === circleId && row.actorId === member.actorId) delete db.personRemarks![key];
    const cancelledTransfers = db.ownerTransfers.filter(t => t.circleId === circleId && t.targetMemberId === member.id);
    db.ownerTransfers = db.ownerTransfers.filter(t => t.circleId !== circleId || t.targetMemberId !== member.id);
    cancelledTransfers.forEach(() => recordAudit(db, circleId, 'circle.transferCancelled', member.id, {reason: 'target_membership_ended'}));
    const person = db.persons.find(x => x.id === member.personId && x.circleId === circleId);
    if (person) {
      person.claimedBy = undefined;
      person.profileOverrides = undefined;
      ['phone','matchPhone','wechatId','photoFileId','photoUrl','city','country','province','latitude','longitude','birthday','status','industry','occupation','school','bio'].forEach(k => { delete (person as any)[k]; });
      person.profileComplete = false;
      person.visibility = {};
      person.updatedAt = nextDemoPersonUpdatedAt(person);
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
    db.claimRequests.filter(request => request.circleId === circleId && request.actorId === member.actorId && request.status === 'pending').forEach(request => { request.status = 'rejected'; });
    for (const [key, row] of Object.entries(db.personRemarks || {})) if (row.circleId === circleId && row.actorId === member.actorId) delete db.personRemarks![key];
    const cancelledTransfers = db.ownerTransfers.filter(t => t.circleId === circleId && t.targetMemberId === member.id);
    db.ownerTransfers = db.ownerTransfers.filter(t => t.circleId !== circleId || t.targetMemberId !== member.id);
    cancelledTransfers.forEach(() => recordAudit(db, circleId, 'circle.transferCancelled', member.id, {reason: 'target_membership_ended'}));
    const person = db.persons.find(x => x.id === member.personId && x.circleId === circleId);
    if (person) {
      person.claimedBy = undefined;
      person.profileOverrides = undefined;
      ['phone','matchPhone','wechatId','photoFileId','photoUrl','city','country','province','latitude','longitude','birthday','status','industry','occupation','school','bio'].forEach(k => { delete (person as any)[k]; });
      person.profileComplete = false;
      person.visibility = {};
      person.updatedAt = nextDemoPersonUpdatedAt(person);
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
    const ownSuggestions = db.suggestions.filter(s => s.circleId === circleId && s.createdBy === DEMO_ACTOR);
    if (ownSuggestions.filter(s => s.status === 'pending').length >= 5) return bad('SUGGESTION_PENDING_LIMIT', '你在这份亲友录还有 5 条待处理建议，请等待管理员处理');
    if (ownSuggestions.filter(s => s.createdAt > Date.now() - 24 * 60 * 60 * 1000).length >= 10) return bad('SUGGESTION_DAILY_LIMIT', '每 24 小时在同一份亲友录最多提交 10 条建议，请稍后再试');
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
    if (p.status !== 'accepted' && p.status !== 'rejected' && p.status !== 'handled') return bad('INVALID', '处理结果不正确');
    const resolutionNote = String(p.resolutionNote || '').trim();
    if (!resolutionNote || resolutionNote.length > 500) return bad('INVALID', '请填写 1 至 500 字的处理说明');
    const hasRelationChange = Boolean(suggestion.relationChange?.removeRelationId || suggestion.relationChange?.relation);
    if (p.status === 'accepted' && (suggestion.type !== 'relation' || !hasRelationChange)) {
      return bad('CHANGE_REQUIRED', '请先完成具体变更，不能只把建议标记为已采纳');
    }
    if (p.status === 'handled' && suggestion.type === 'relation' && hasRelationChange) return bad('CHANGE_REQUIRED', '具体关系变更须采纳并应用或拒绝，不能只标为已处理');
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
      for (const personId of new Set([before?.from, before?.to, after?.from, after?.to].filter(Boolean))) {
        const endpoint = db.persons.find(person => person.id === personId);
        if (endpoint) endpoint.updatedAt = nextDemoPersonUpdatedAt(endpoint);
      }
    }
    suggestion.status = p.status;
    suggestion.resolutionNote = resolutionNote;
    recordAudit(db, circleId, 'suggestion.resolve', suggestion.id, {status: p.status, resolutionNote, ...(impact ? {removed, created, affectedPersonIds: impact.affectedPersonIds, reason: suggestion.message} : {})});
    saveDb(db); return good({ suggestion, impact });
  }
  if (action === 'delegation.grant') {
    const person = db.persons.find(x => x.id === p.personId && x.circleId === circleId);
    if (!person || person.claimedBy !== DEMO_ACTOR) return bad('FORBIDDEN', '只有本人可以授权');
    const admin = db.members.find(m => m.id === p.adminMemberId && m.circleId === circleId && isAdmin(m.role) && m.status === 'joined');
    if (!admin) return bad('INVALID', '请选择这份亲友录的管理员');
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
