declare function require(name: string): any;
declare const Buffer: any;
const crypto = require('node:crypto');

import type { Application, AuditEvent, Circle, ClaimRequest, Delegation, Invite, Member, Person, PersonField, Relation, RelationChange, Role, Suggestion, Visibility } from './model';
import type { Repository, UnitOfWork } from './repository';

export interface Request { action: string; payload?: unknown }
export type Response = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const profileFields: PersonField[] = ['name', 'nickname', 'gender', 'birthOrder', 'country', 'province', 'city', 'latitude', 'longitude', 'status', 'school', 'industry', 'occupation', 'bio', 'phone', 'wechatId', 'photoFileId'];
const privateFields: PersonField[] = ['country', 'province', 'city', 'latitude', 'longitude', 'status', 'school', 'industry', 'occupation', 'bio', 'phone', 'wechatId', 'photoFileId'];
const visibilityFields: PersonField[] = ['city', 'status', 'school', 'industry', 'occupation', 'bio', 'phone', 'wechatId', 'photoFileId'];
const bareFields: PersonField[] = ['name', 'nickname', 'gender', 'birthOrder'];
const delegableFields: PersonField[] = profileFields.filter(field => field !== 'latitude' && field !== 'longitude');
const relationTypes = ['parent', 'spouse', 'sibling'];
const inviteLifetime = 72 * 60 * 60 * 1000;

function fail(code: string, message: string): never { throw new ApiError(code, message); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_INPUT', '请求内容格式错误');
  return value as Record<string, unknown>;
}
function str(value: unknown, name: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('INVALID_INPUT', `${name}格式错误`);
  return value.trim();
}
function optionalStr(value: unknown, name: string, max = 120): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return str(value, name, max);
}
function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail('INVALID_INPUT', `${name}不支持`);
  return value as T;
}
function id(): string { return crypto.randomUUID(); }
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function memberId(circleId: string, userId: string): string { return `${circleId}_${hash(userId).slice(0, 40)}`; }
function claimRequestId(circleId: string, personId: string, userId: string): string { return `${circleId}_${hash(`${personId}|${userId}`).slice(0, 40)}`; }
function applicationId(inviteId: string, userId: string): string { return `${inviteId}_${hash(userId).slice(0, 40)}`; }
function relationId(circleId: string, type: Relation['type'], from: string, to: string): string {
  const endpoints = type === 'parent' ? [from, to] : [from, to].sort();
  return `${circleId}_${hash(`${type}|${endpoints[0]}|${endpoints[1]}`).slice(0, 40)}`;
}
function relationSummary(relation: Relation) {
  const {id, from, to, type, olderId} = relation;
  return {id, from, to, type, olderId};
}
function relationFingerprint(relation: Relation): string {
  return hash(JSON.stringify([relation.id, relation.from, relation.to, relation.type, relation.olderId, relation.createdBy, relation.createdAt]));
}
function validateFamilyGraph(relations: Relation[]): void {
  const pairTypes = new Map<string, string>();
  const children = new Map<string, string[]>();
  const adjacency = new Map<string, Array<{id: string; distance: number}>>();
  const add = (from: string, to: string, distance: number) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push({id: to, distance});
  };
  for (const relation of relations) {
    const pair = [relation.from, relation.to].sort().join('|');
    const existing = pairTypes.get(pair);
    if (existing) fail('RELATION_CONFLICT', '同两人之间已有不能并存的关系');
    pairTypes.set(pair, relation.type);
    const distance = relation.type === 'parent' ? 1 : 0;
    add(relation.from, relation.to, distance);
    add(relation.to, relation.from, -distance);
    if (relation.type === 'parent') {
      if (!children.has(relation.from)) children.set(relation.from, []);
      children.get(relation.from)!.push(relation.to);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const checkCycle = (personId: string): void => {
    if (visiting.has(personId)) fail('RELATION_CYCLE', '亲子关系不能形成循环');
    if (visited.has(personId)) return;
    visiting.add(personId);
    for (const child of children.get(personId) ?? []) checkCycle(child);
    visiting.delete(personId);
    visited.add(personId);
  };
  for (const personId of children.keys()) checkCycle(personId);
  const generation = new Map<string, number>();
  for (const start of adjacency.keys()) {
    if (generation.has(start)) continue;
    generation.set(start, 0);
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      const value = generation.get(current)!;
      for (const next of adjacency.get(current) ?? []) {
        const expected = value + next.distance;
        const actual = generation.get(next.id);
        if (actual === undefined) { generation.set(next.id, expected); queue.push(next.id); }
        else if (actual !== expected) fail('GENERATION_CONFLICT', '这条关系与现有辈分关系矛盾');
      }
    }
  }
}
function affectedComponentIds(relations: Relation[], added: Relation | undefined, endpoints: string[]): string[] {
  const adjacency = new Map<string, Set<string>>();
  for (const relation of added ? [...relations, added] : relations) {
    if (!adjacency.has(relation.from)) adjacency.set(relation.from, new Set());
    if (!adjacency.has(relation.to)) adjacency.set(relation.to, new Set());
    adjacency.get(relation.from)!.add(relation.to);
    adjacency.get(relation.to)!.add(relation.from);
  }
  const seen = new Set(endpoints);
  const queue = [...endpoints];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const next of adjacency.get(queue[cursor]) ?? []) if (!seen.has(next)) {
      seen.add(next); queue.push(next);
    }
  }
  return [...seen];
}
function effectiveDelegationFields(fields: PersonField[]): PersonField[] {
  return fields.includes('city') ? [...new Set([...fields, 'country', 'province', 'latitude', 'longitude'] as PersonField[])] : fields;
}
function rank(role: Role): number { return role === 'owner' ? 3 : role === 'admin' ? 2 : 1; }
function safePublicCircle(circle: Circle) { const { id, name, type, school, cohort, className } = circle; return { id, name, type, school, cohort, className }; }
function safeCircle(circle: Circle) { const {ownerId: _ownerId, ...view} = circle; return view; }

export class ApiService {
  constructor(
    private readonly repo: Repository,
    private readonly now: () => number = Date.now,
    private readonly signPhoto?: (fileId: string) => Promise<string>
  ) {}

  async invoke(request: Request, actorId?: string): Promise<Response> {
    try {
      const action = str(request?.action, 'action', 80);
      if (action !== 'invite.preview' && !actorId) fail('UNAUTHENTICATED', '请先登录微信');
      const p = object(request.payload ?? {});
      const data = await this.repo.atomic(tx => this.dispatch(tx, action, p, actorId ?? ''));
      return { ok: true, data };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { code: error.code, message: error.message } };
      // Do not return database errors, secrets or stack traces to clients.
      return { ok: false, error: { code: 'SERVER_ERROR', message: '服务暂时不可用，请稍后重试' } };
    }
  }

  private async dispatch(tx: UnitOfWork, action: string, p: Record<string, unknown>, actorId: string): Promise<unknown> {
    switch (action) {
      case 'circle.create': return this.createCircle(tx, p, actorId);
      case 'circle.list': return this.listCircles(tx, actorId);
      case 'circle.detail': return this.detailCircle(tx, p, actorId);
      case 'circle.upgrade': return this.upgradeCircle(tx, p, actorId);
      case 'circle.transferOwner': return this.transferOwner(tx, p, actorId);
      case 'person.list': return this.listPeople(tx, p, actorId);
      case 'person.get': return this.getPerson(tx, p, actorId);
      case 'person.create': return this.createPerson(tx, p, actorId);
      case 'person.update': return this.updatePerson(tx, p, actorId);
      case 'person.delete': return this.deletePerson(tx, p, actorId);
      case 'person.claim': return this.claimPerson(tx, p, actorId);
      case 'person.claimList': return this.listClaims(tx, p, actorId);
      case 'person.claimMine': return this.myClaims(tx, p, actorId);
      case 'person.claimApprove': return this.resolveClaim(tx, p, actorId, true);
      case 'person.claimReject': return this.resolveClaim(tx, p, actorId, false);
      case 'person.unclaim': return this.unclaimPerson(tx, p, actorId);
      case 'photo.uploadPath': return this.photoUploadPath(tx, p, actorId);
      case 'photo.url': return this.photoUrl(tx, p, actorId);
      case 'relation.list': return this.listRelations(tx, p, actorId);
      case 'relation.create': return this.createRelation(tx, p, actorId);
      case 'relation.delete': return this.deleteRelation(tx, p, actorId);
      case 'relation.replace': return this.replaceRelation(tx, p, actorId);
      case 'relation.preview': return this.previewRelation(tx, p, actorId);
      case 'invite.create': return this.createInvite(tx, p, actorId);
      case 'invite.preview': return this.previewInvite(tx, p);
      case 'invite.apply': return this.applyInvite(tx, p, actorId);
      case 'invite.list': return this.listInvites(tx, p, actorId);
      case 'invite.revoke': return this.revokeInvite(tx, p, actorId);
      case 'join.list': return this.listApplications(tx, p, actorId);
      case 'join.mine': return this.myApplications(tx, actorId);
      case 'join.approve': return this.resolveApplication(tx, p, actorId, true);
      case 'join.reject': return this.resolveApplication(tx, p, actorId, false);
      case 'member.list': return this.listMembers(tx, p, actorId);
      case 'member.remove': return this.endMember(tx, p, actorId, 'removed');
      case 'member.leave': return this.endMember(tx, p, actorId, 'left');
      case 'member.setRole': return this.setRole(tx, p, actorId);
      case 'delegation.grant': return this.grantDelegation(tx, p, actorId);
      case 'delegation.revoke': return this.revokeDelegation(tx, p, actorId);
      case 'suggestion.create': return this.createSuggestion(tx, p, actorId);
      case 'suggestion.list': return this.listSuggestions(tx, p, actorId);
      case 'suggestion.resolve': return this.resolveSuggestion(tx, p, actorId);
      case 'audit.list': return this.listAudit(tx, p, actorId);
      default: fail('UNKNOWN_ACTION', '暂不支持此操作');
    }
  }

  private async circle(tx: UnitOfWork, circleId: unknown): Promise<Circle> {
    const circle = await tx.get('circles', str(circleId, 'circleId'));
    if (!circle) fail('NOT_FOUND', '圈子不存在');
    return circle;
  }
  private async member(tx: UnitOfWork, circleId: string, actorId: string): Promise<Member> {
    const member = await tx.get('members', memberId(circleId, actorId));
    if (!member || member.status !== 'active') fail('FORBIDDEN', '你不是这个圈子的成员');
    return member;
  }
  private async access(tx: UnitOfWork, circleId: unknown, actorId: string, min: Role = 'member'): Promise<{circle: Circle; member: Member}> {
    const circle = await this.circle(tx, circleId);
    const member = await this.member(tx, circle.id, actorId);
    if (rank(member.role) < rank(min)) fail('FORBIDDEN', '没有此操作权限');
    return {circle, member};
  }
  private async person(tx: UnitOfWork, circleId: string, personId: unknown): Promise<Person> {
    const person = await tx.get('persons', str(personId, 'personId'));
    if (!person || person.circleId !== circleId) fail('NOT_FOUND', '人物不存在');
    return person;
  }
  private async audit(tx: UnitOfWork, circleId: string, actorId: string, type: string, targetId: string, details?: Record<string, unknown>): Promise<void> {
    const event: AuditEvent = { id: id(), circleId, actorId, type, targetId, at: this.now(), details };
    await tx.put('audit', event);
  }

  private async createCircle(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const type = oneOf(p.type, ['family', 'classmate'] as const, '圈子类型');
    const mode = oneOf(p.mode ?? 'private', ['private', 'shared'] as const, '维护模式');
    const now = this.now();
    const circle: Circle = { id: id(), type, name: str(p.name, '圈名', 60), mode, ownerId: actorId, createdAt: now, updatedAt: now };
    if (type === 'classmate') {
      circle.school = str(p.school, '学校', 80);
      circle.cohort = str(p.cohort, '届别', 40);
      circle.className = str(p.className, '班级', 40);
    }
    const member: Member = {id: memberId(circle.id, actorId), circleId: circle.id, userId: actorId, name: '圈主', role: 'owner', status: 'active', joinedAt: now};
    await tx.put('circles', circle);
    await tx.put('members', member);
    await this.audit(tx, circle.id, actorId, 'circle.create', circle.id);
    return {circle: {...safeCircle(circle), role: 'owner', memberCount: 1}};
  }

  private async listCircles(tx: UnitOfWork, actorId: string) {
    const memberships = await tx.find('members', {userId: actorId, status: 'active'});
    const circles = [];
    for (const member of memberships) {
      const circle = await tx.get('circles', member.circleId);
      if (!circle) continue;
      const count = (await tx.find('members', {circleId: circle.id, status: 'active'})).length;
      circles.push({...safeCircle(circle), role: member.role, memberCount: count});
    }
    return {circles};
  }

  private async detailCircle(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    const memberCount = (await tx.find('members', {circleId: circle.id, status: 'active'})).length;
    return {circle: {...safeCircle(circle), role: member.role, memberCount}, role: member.role};
  }

  private async upgradeCircle(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'owner');
    if (p.privacyReviewed !== true) fail('PRIVACY_REVIEW_REQUIRED', '请先确认历史资料的可见范围');
    circle.mode = 'shared'; circle.updatedAt = this.now();
    await tx.put('circles', circle);
    await this.audit(tx, circle.id, actorId, 'circle.upgrade', circle.id);
    return {circle: safeCircle(circle)};
  }

  private async transferOwner(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId, 'owner');
    const target = await tx.get('members', str(p.memberId, 'memberId'));
    if (!target || target.circleId !== circle.id || target.status !== 'active' || target.id === member.id) fail('INVALID_INPUT', '请选择本圈其他已加入成员');
    member.role = 'admin'; target.role = 'owner'; circle.ownerId = target.userId; circle.updatedAt = this.now();
    await tx.put('members', member); await tx.put('members', target); await tx.put('circles', circle);
    await this.audit(tx, circle.id, actorId, 'circle.transferOwner', target.id);
    return {circle: safeCircle(circle), member: this.safeMember(target, actorId)};
  }

  private visiblePerson(person: Person, actorId: string) {
    const own = person.claimedBy === actorId;
    const result: Record<string, unknown> = {
      id: person.id, circleId: person.circleId, name: person.name,
      nickname: person.nickname, gender: person.gender, birthOrder: person.birthOrder,
      isSelf: own, isClaimed: Boolean(person.claimedBy),
      createdAt: person.createdAt, updatedAt: person.updatedAt,
      lastConfirmedAt: person.lastConfirmedAt
    };
    for (const field of privateFields) {
      if (person[field] === undefined) continue;
      const visibilityKey = field === 'country' || field === 'province' || field === 'latitude' || field === 'longitude' ? 'city' : field;
      if (own || (person.claimedBy && person.visibility[visibilityKey] === 'circle')) result[field] = person[field];
    }
    if (own) result.visibility = person.visibility;
    return result;
  }

  private async listPeople(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    const persons = (await tx.find('persons', {circleId: circle.id})).map(person => this.visiblePerson(person, actorId));
    return {persons};
  }

  private async getPerson(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    const person = await this.person(tx, circle.id, p.personId);
    const view = this.visiblePerson(person, actorId);
    if (person.claimedBy === actorId) {
      view.delegations = (await tx.find('delegations', {circleId: circle.id, personId: person.id})).filter(d => !d.revokedAt).map(d => ({id: d.id, adminMemberId: memberId(circle.id, d.adminUserId), fields: d.fields, createdAt: d.createdAt}));
    } else if (rank(member.role) >= 2) {
      const delegation = await tx.get('delegations', `${person.id}_${hash(actorId).slice(0, 40)}`);
      if (delegation && !delegation.revokedAt) {
        const fields = effectiveDelegationFields(delegation.fields);
        view.myDelegatedFields = fields;
        for (const field of fields) if (privateFields.includes(field) && person[field] !== undefined) view[field] = person[field];
      }
    }
    return {person: view};
  }

  private async createPerson(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    if (rank(member.role) < 2 && p.claimSelf !== true) fail('FORBIDDEN', '普通成员只能建立本人的人物卡');
    const now = this.now();
    const person: Person = {id: id(), circleId: circle.id, name: str(p.name, '姓名', 60), visibility: {}, relationCount: 0, createdAt: now, updatedAt: now};
    person.nickname = optionalStr(p.nickname, '昵称', 60);
    if (p.gender !== undefined) person.gender = oneOf(p.gender, ['male', 'female', 'unknown'] as const, '性别');
    if (p.birthOrder !== undefined) {
      if (!Number.isInteger(p.birthOrder) || Number(p.birthOrder) < 1 || Number(p.birthOrder) > 20) fail('INVALID_INPUT', '排行应为 1 至 20');
      person.birthOrder = Number(p.birthOrder);
    }
    if (p.claimSelf === true) {
      if (member.personId) fail('ALREADY_CLAIMED', '你已经认领一张人物卡');
      const pendingClaims = await tx.find('claimRequests', {circleId: circle.id, userId: actorId, status: 'pending'});
      if (pendingClaims.length) fail('CLAIM_PENDING', '认领申请仍在审核中，请先等待审核结果');
      person.claimedBy = actorId;
      member.personId = person.id;
      await tx.put('members', member);
    }
    await tx.put('persons', person);
    await this.audit(tx, circle.id, actorId, 'person.create', person.id);
    return {person: this.visiblePerson(person, actorId)};
  }

  private parsePatch(raw: unknown): Partial<Person> {
    const input = object(raw);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!profileFields.includes(key as PersonField)) fail('INVALID_INPUT', `不能修改字段 ${key}`);
      if (value === null || value === '') { patch[key] = undefined; continue; }
      if (key === 'gender') patch[key] = oneOf(value, ['male', 'female', 'unknown'] as const, '性别');
      else if (key === 'birthOrder') {
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) fail('INVALID_INPUT', '排行应为 1 至 20');
        patch[key] = Number(value);
      } else if (key === 'latitude' || key === 'longitude') {
        const limit = key === 'latitude' ? 90 : 180;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < -limit || value > limit) fail('INVALID_INPUT', `${key}须为有效坐标`);
        // Keep only a city-scale representative point, not a precise pin.
        patch[key] = Math.round(value * 10) / 10;
      } else patch[key] = str(value, key, key === 'bio' ? 500 : key === 'phone' ? 30 : key === 'photoFileId' ? 512 : 120);
    }
    return patch as Partial<Person>;
  }

  private async updatePerson(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    const person = await this.person(tx, circle.id, p.personId);
    const patch = this.parsePatch(p.patch);
    const latitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'latitude');
    const longitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'longitude');
    if (latitudeTouched !== longitudeTouched ||
      (latitudeTouched && ((patch.latitude === undefined) !== (patch.longitude === undefined)))) {
      fail('INVALID_INPUT', '城市坐标须同时填写或同时清除');
    }
    const allowedPhoto = /^cloud:\/\/[^/]+\/photos\/([^/]+)\/([0-9a-f-]{36}\.jpg)$/;
    const photoMatch = patch.photoFileId === undefined ? undefined : allowedPhoto.exec(patch.photoFileId);
    if (patch.photoFileId !== undefined && (!photoMatch || photoMatch[1] !== actorId)) {
      fail('INVALID_INPUT', '照片文件不在你的上传目录');
    }
    const own = person.claimedBy === actorId;
    if (!own) {
      if (rank(member.role) < 2) fail('FORBIDDEN', '只能编辑自己的资料');
      if (!person.claimedBy) {
        if (Object.keys(patch).some(key => !bareFields.includes(key as PersonField))) fail('FORBIDDEN', '未认领人物只可填写最少资料');
      } else {
        const delegation = await tx.get('delegations', `${person.id}_${hash(actorId).slice(0, 40)}`);
        if (!delegation || delegation.revokedAt || delegation.ownerUserId !== person.claimedBy) fail('FORBIDDEN', '没有代维护授权');
        const allowed = effectiveDelegationFields(delegation.fields);
        if (Object.keys(patch).some(key => !allowed.includes(key as PersonField))) fail('FORBIDDEN', '超出代维护授权范围');
      }
      if (p.visibility !== undefined) fail('FORBIDDEN', '代维护不能修改资料可见范围');
    }
    if (own && p.visibility !== undefined) {
      const settings = object(p.visibility);
      for (const [key, value] of Object.entries(settings)) {
        if (!visibilityFields.includes(key as PersonField)) fail('INVALID_INPUT', `字段 ${key} 不可设置可见范围`);
        person.visibility[key as PersonField] = oneOf(value, ['self', 'circle'] as const, '可见范围');
      }
    }
    const locationNameChanged = (Object.prototype.hasOwnProperty.call(patch, 'city') && patch.city !== person.city) ||
      (Object.prototype.hasOwnProperty.call(patch, 'country') && patch.country !== person.country) ||
      (Object.prototype.hasOwnProperty.call(patch, 'province') && patch.province !== person.province);
    Object.assign(person, patch);
    if (latitudeTouched && patch.latitude !== undefined && !person.city) {
      fail('INVALID_INPUT', '请先填写城市再确认城市中心点');
    }
    if (!person.city || (locationNameChanged && !latitudeTouched)) {
      person.latitude = undefined;
      person.longitude = undefined;
    }
    if ((person.latitude === undefined) !== (person.longitude === undefined) ||
      (person.latitude !== undefined && !person.city)) fail('INVALID_INPUT', '请先填写城市再确认城市中心点');
    person.updatedAt = this.now();
    if (own) person.lastConfirmedAt = this.now();
    await tx.put('persons', person);
    await this.audit(tx, circle.id, actorId, own ? 'person.update' : 'person.maintain', person.id, {fields: Object.keys(patch)});
    return {person: this.visiblePerson(person, actorId)};
  }

  private async photoUploadPath(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    const person = await this.person(tx, circle.id, p.personId);
    if (person.claimedBy !== actorId) {
      if (!person.claimedBy || rank(member.role) < 2) fail('FORBIDDEN', '不能上传此人物的照片');
      const delegation = await tx.get('delegations', `${person.id}_${hash(actorId).slice(0, 40)}`);
      if (!delegation || delegation.revokedAt || !delegation.fields.includes('photoFileId')) fail('FORBIDDEN', '没有照片代维护授权');
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorId)) fail('INVALID_IDENTITY', '微信身份格式不支持照片上传');
    return {cloudPath: `photos/${actorId}/${id()}.jpg`};
  }

  private async photoUrl(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const view = (await this.getPerson(tx, p, actorId)).person as Record<string, unknown>;
    const fileId = view.photoFileId;
    if (typeof fileId !== 'string') fail('FORBIDDEN', '照片未开放查看');
    if (!this.signPhoto) fail('NOT_CONFIGURED', '当前未配置云存储');
    const url = await this.signPhoto(fileId);
    return {url};
  }

  private async deletePerson(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const person = await this.person(tx, circle.id, p.personId);
    if (person.claimedBy) fail('CLAIMED_PERSON', '请先移除或解绑认领成员');
    if ((person.relationCount ?? 0) > 0) fail('RELATION_CONNECTED', `该人物关联 ${person.relationCount} 条关系，请先处理关系`);
    await tx.delete('persons', person.id);
    await this.audit(tx, circle.id, actorId, 'person.delete', person.id);
    return {personId: person.id};
  }

  private async claimPerson(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    const person = await this.person(tx, circle.id, p.personId);
    if (member.personId) fail('ALREADY_CLAIMED', '你已认领一张人物卡');
    if (person.claimedBy) fail('ALREADY_CLAIMED', '这张人物卡已被认领');
    // Even administrators need approval for a card created by somebody else.
    // The creator can link their own freshly created card via claimSelf.
    const request: ClaimRequest = {
      id: claimRequestId(circle.id, person.id, actorId), circleId: circle.id,
      personId: person.id, userId: actorId, status: 'pending', createdAt: this.now()
    };
    const existing = await tx.get('claimRequests', request.id);
    if (existing?.status === 'pending') return {claimRequest: this.safeClaim(existing)};
    const pendingClaims = await tx.find('claimRequests', {circleId: circle.id, userId: actorId, status: 'pending'});
    if (pendingClaims.length) fail('CLAIM_PENDING', '已有其他人物卡认领申请正在审核');
    // Creation of a pending claim and creation of a claimed self card both
    // write the member document, preventing a cross-action race in CloudBase.
    await tx.put('members', member);
    await tx.put('claimRequests', request);
    await this.audit(tx, circle.id, actorId, 'person.claimRequest', person.id);
    return {claimRequest: this.safeClaim(request)};
  }

  private safeClaim(request: ClaimRequest) {
    const {id, circleId, personId, status, createdAt, reviewedAt} = request;
    return {id, circleId, personId, status, createdAt, reviewedAt};
  }

  private async listClaims(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const requests = await tx.find('claimRequests', {circleId: circle.id, status: 'pending'});
    const claimRequests = await Promise.all(requests.map(async r => {
      const member = await tx.get('members', memberId(circle.id, r.userId));
      return {...this.safeClaim(r), memberId: memberId(circle.id, r.userId), applicantName: member?.name || '申请人'};
    }));
    return {claimRequests};
  }

  private async myClaims(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    const requests = await tx.find('claimRequests', {circleId: circle.id, userId: actorId});
    const claimRequests = await Promise.all(requests.map(async request => {
      const person = await tx.get('persons', request.personId);
      return {...this.safeClaim(request), personName: person?.circleId === circle.id ? person.name : '人物卡已删除'};
    }));
    return {claimRequests: claimRequests.sort((a, b) => b.createdAt - a.createdAt)};
  }

  private async resolveClaim(tx: UnitOfWork, p: Record<string, unknown>, actorId: string, approve: boolean) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const request = await tx.get('claimRequests', str(p.claimRequestId, 'claimRequestId'));
    if (!request || request.circleId !== circle.id) fail('NOT_FOUND', '认领申请不存在');
    if (request.status !== 'pending') fail('ALREADY_REVIEWED', '认领申请已处理');
    if (approve) {
      const person = await this.person(tx, circle.id, request.personId);
      const member = await this.member(tx, circle.id, request.userId);
      if (person.claimedBy || member.personId) fail('ALREADY_CLAIMED', '人物卡或成员已被认领');
      person.claimedBy = request.userId; person.lastConfirmedAt = this.now(); person.updatedAt = this.now();
      member.personId = person.id;
      await tx.put('persons', person); await tx.put('members', member);
    }
    request.status = approve ? 'approved' : 'rejected';
    request.reviewedAt = this.now(); request.reviewedBy = actorId;
    await tx.put('claimRequests', request);
    await this.audit(tx, circle.id, actorId, approve ? 'person.claimApprove' : 'person.claimReject', request.personId);
    return {claimRequest: this.safeClaim(request)};
  }

  private async unclaimPerson(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const person = await this.person(tx, circle.id, p.personId);
    if (!person.claimedBy) fail('INVALID_INPUT', '人物卡尚未认领');
    const reasonCode = p.reasonCode === undefined ? undefined : oneOf(p.reasonCode, ['wrong_person', 'member_request', 'duplicate_card', 'other'] as const, '解绑原因');
    const oldOwner = person.claimedBy;
    const oldMemberId = memberId(circle.id, oldOwner);
    const clearedFields = privateFields.filter(field => person[field] !== undefined);
    const member = await tx.get('members', memberId(circle.id, oldOwner));
    if (member?.status === 'active' && member.personId === person.id) {
      member.personId = undefined;
      await tx.put('members', member);
    }
    person.claimedBy = undefined;
    for (const field of privateFields) (person as unknown as Record<string, unknown>)[field] = undefined;
    person.visibility = {};
    person.updatedAt = this.now();
    await tx.put('persons', person);
    const delegations = await tx.find('delegations', {circleId: circle.id, personId: person.id});
    let revokedDelegationCount = 0;
    for (const delegation of delegations) if (!delegation.revokedAt) {delegation.revokedAt = this.now(); await tx.put('delegations', delegation); revokedDelegationCount++;}
    await this.audit(tx, circle.id, actorId, 'person.unclaim', person.id, {oldMemberId, clearedFields, revokedDelegationCount, reasonCode});
    return {person: this.visiblePerson(person, actorId)};
  }

  private async listRelations(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    if (circle.type !== 'family') fail('WRONG_CIRCLE_TYPE', '同学圈没有亲属关系');
    const relations = await tx.find('relations', {circleId: circle.id});
    return {relations: relations.map(({id, circleId, from, to, type, olderId, createdAt}) => ({id, circleId, from, to, type, olderId, createdAt}))};
  }

  private async createRelation(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    if (circle.type !== 'family') fail('WRONG_CIRCLE_TYPE', '同学圈不能录入亲属关系');
    const change = await this.parseRelationChange(tx, circle, {relation: p});
    const result = await this.applyRelationChange(tx, circle, change, actorId);
    await this.audit(tx, circle.id, actorId, 'relation.create', result.after!.id, {created: result.after, reason: optionalStr(p.reason, '原因', 300)});
    return {relation: result.after, impact: result.impact};
  }

  private async deleteRelation(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const change = await this.parseRelationChange(tx, circle, {removeRelationId: p.relationId});
    const result = await this.applyRelationChange(tx, circle, change, actorId);
    await this.audit(tx, circle.id, actorId, 'relation.delete', result.before!.id, {removed: result.before, reason: optionalStr(p.reason, '原因', 300)});
    return {relationId: result.before!.id, impact: result.impact};
  }

  private async replaceRelation(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    if (circle.type !== 'family') fail('WRONG_CIRCLE_TYPE', '同学圈没有亲属关系');
    const change = await this.parseRelationChange(tx, circle, {removeRelationId: p.relationId, relation: p.relation});
    if (!change.relation) fail('INVALID_INPUT', '请填写替换后的关系');
    const result = await this.applyRelationChange(tx, circle, change, actorId);
    await this.audit(tx, circle.id, actorId, 'relation.replace', result.after!.id, {removed: result.before, created: result.after, reason: optionalStr(p.reason, '原因', 300)});
    return {relation: result.after, impact: result.impact};
  }

  private async previewRelation(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    if (circle.type !== 'family') fail('WRONG_CIRCLE_TYPE', '同学圈没有亲属关系');
    const change = await this.parseRelationChange(tx, circle, p.relationChange);
    const plan = await this.planRelationChange(tx, circle, change, actorId);
    return {impact: plan.impact, before: plan.before && relationSummary(plan.before), after: plan.after && relationSummary(plan.after)};
  }

  private async parseRelationChange(tx: UnitOfWork, circle: Circle, raw: unknown): Promise<RelationChange> {
    const input = object(raw);
    const removeRelationId = input.removeRelationId === undefined ? undefined : str(input.removeRelationId, 'removeRelationId');
    let relation: RelationChange['relation'];
    if (input.relation !== undefined) {
      const proposed = object(input.relation);
      const from = (await this.person(tx, circle.id, proposed.from)).id;
      const to = (await this.person(tx, circle.id, proposed.to)).id;
      if (from === to) fail('INVALID_INPUT', '不能把人物关联到自己');
      const type = oneOf(proposed.type, relationTypes, '关系类型') as Relation['type'];
      let olderId: string | undefined;
      if (proposed.olderId !== undefined) {
        if (type !== 'sibling') fail('INVALID_INPUT', '只有兄弟姐妹关系可记录长幼');
        olderId = str(proposed.olderId, 'olderId');
        if (olderId !== from && olderId !== to) fail('INVALID_INPUT', '长者必须是关系中的一人');
      }
      relation = {from, to, type, olderId};
    }
    if (!removeRelationId && !relation) fail('INVALID_INPUT', '请填写需要新增或删除的关系');
    return {removeRelationId, relation};
  }

  private async planRelationChange(tx: UnitOfWork, circle: Circle, change: RelationChange, actorId: string, expectedRelationHash?: string) {
    const before = change.removeRelationId ? await tx.get('relations', change.removeRelationId) : undefined;
    if (change.removeRelationId && (!before || before.circleId !== circle.id)) fail('NOT_FOUND', '要修改的关系不存在');
    if (before && expectedRelationHash && relationFingerprint(before) !== expectedRelationHash) fail('STALE_RELATION', '关系已被其他人修改，请重新提交建议');
    const after: Relation | undefined = change.relation ? {
      id: relationId(circle.id, change.relation.type, change.relation.from, change.relation.to),
      circleId: circle.id, ...change.relation, createdBy: actorId, createdAt: this.now()
    } : undefined;
    // A deterministic doc read keeps identical-edge races inside the CloudBase
    // transaction even though collection-wide graph scans use the SDK query API.
    const exactExisting = after ? await tx.get('relations', after.id) : undefined;
    if (exactExisting && exactExisting.id !== before?.id) fail('DUPLICATE_RELATION', '这条关系已存在');
    const relations = await tx.find('relations', {circleId: circle.id});
    const remaining = relations.filter(relation => relation.id !== before?.id);
    if (after && remaining.some(relation => relation.id === after.id)) fail('DUPLICATE_RELATION', '这条关系已存在');
    // Removing an edge cannot create a new contradiction. Let admins clean up
    // older graphs that already contain more than one conflicting edge.
    if (after) validateFamilyGraph([...remaining, after]);
    const endpoints = [...new Set([before?.from, before?.to, after?.from, after?.to].filter((value): value is string => Boolean(value)))];
    const affectedPersonIds = affectedComponentIds(relations, after, endpoints);
    const impact = {
      removedRelationIds: before ? [before.id] : [],
      createdRelationIds: after ? [after.id] : [],
      affectedPersonIds
    };
    return {before, after, impact};
  }

  private async applyRelationChange(tx: UnitOfWork, circle: Circle, change: RelationChange, actorId: string, expectedRelationHash?: string): Promise<{
    before?: ReturnType<typeof relationSummary>;
    after?: ReturnType<typeof relationSummary>;
    impact: {removedRelationIds: string[]; createdRelationIds: string[]; affectedPersonIds: string[]};
  }> {
    const plan = await this.planRelationChange(tx, circle, change, actorId, expectedRelationHash);
    const persons = new Map<string, Person>();
    const changedEndpoints = [...new Set([plan.before?.from, plan.before?.to, plan.after?.from, plan.after?.to].filter((value): value is string => Boolean(value)))];
    for (const personId of changedEndpoints) persons.set(personId, await this.person(tx, circle.id, personId));
    for (const personId of [plan.before?.from, plan.before?.to]) if (personId) {
      const person = persons.get(personId)!;
      if ((person.relationCount ?? 0) < 1) fail('DATA_INTEGRITY', '关系计数不一致');
      person.relationCount = (person.relationCount ?? 0) - 1;
    }
    for (const personId of [plan.after?.from, plan.after?.to]) if (personId) {
      const person = persons.get(personId)!;
      person.relationCount = (person.relationCount ?? 0) + 1;
    }
    for (const person of persons.values()) await tx.put('persons', person);
    if (plan.before && plan.before.id !== plan.after?.id) await tx.delete('relations', plan.before.id);
    if (plan.after) await tx.put('relations', plan.after);
    // Mutate the circle document in the same transaction to serialize distinct
    // relation IDs whose combined graph would otherwise be inconsistent.
    circle.updatedAt = this.now();
    await tx.put('circles', circle);
    return {before: plan.before && relationSummary(plan.before), after: plan.after && relationSummary(plan.after), impact: plan.impact};
  }

  private parseToken(tokenValue: unknown): {inviteId: string; token: string} {
    if (typeof tokenValue !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(tokenValue)) fail('INVALID_INVITE', '邀请不存在或已失效');
    return {inviteId: hash(tokenValue), token: tokenValue};
  }
  private async verifyInvite(tx: UnitOfWork, token: unknown): Promise<Invite> {
    const {inviteId, token: secret} = this.parseToken(token);
    const invite = await tx.get('invites', inviteId);
    if (!invite || !crypto.timingSafeEqual(Buffer.from(invite.tokenHash, 'hex'), Buffer.from(hash(secret), 'hex'))) fail('INVALID_INVITE', '邀请不存在或已失效');
    return invite;
  }
  private inviteStatus(invite: Invite): 'active' | 'expired' | 'revoked' | 'used' {
    if (invite.revokedAt) return 'revoked';
    if (invite.usedAt) return 'used';
    if (this.now() >= invite.expiresAt) return 'expired';
    return 'active';
  }
  private requireActiveInvite(invite: Invite): void {
    const status = this.inviteStatus(invite);
    if (status !== 'active') fail('INVITE_INACTIVE', status === 'expired' ? '邀请已过期' : status === 'revoked' ? '邀请已撤销' : '邀请已使用');
  }

  private async createInvite(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    if (circle.mode !== 'shared') fail('PRIVATE_CIRCLE', '请先检查资料并开启邀请共建');
    // 24 random bytes encode to exactly 32 URL-safe characters, fitting wxacode scene.
    const secret = crypto.randomBytes(24).toString('base64url');
    const invite: Invite = {id: hash(secret), circleId: circle.id, tokenHash: hash(secret), createdBy: actorId, createdAt: this.now(), expiresAt: this.now() + inviteLifetime};
    await tx.put('invites', invite);
    await this.audit(tx, circle.id, actorId, 'invite.create', invite.id);
    return {invite: {id: invite.id, circleId: invite.circleId, token: secret, expiresAt: invite.expiresAt, status: 'active'}};
  }

  private async previewInvite(tx: UnitOfWork, p: Record<string, unknown>) {
    const invite = await this.verifyInvite(tx, p.token);
    const circle = await this.circle(tx, invite.circleId);
    return {circle: safePublicCircle(circle), expiresAt: invite.expiresAt, status: this.inviteStatus(invite)};
  }

  private async applyInvite(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    // Joining and claiming a person card are separate, independently reviewed
    // actions. Reject older clients that try to bind a card before membership.
    if (p.claimPersonId !== undefined) fail('INVALID_INPUT', '请先加入圈子，再由本人申请认领人物卡');
    const invite = await this.verifyInvite(tx, p.token);
    this.requireActiveInvite(invite);
    const circle = await this.circle(tx, invite.circleId);
    const existingMember = await tx.get('members', memberId(invite.circleId, actorId));
    if (existingMember?.status === 'active') fail('ALREADY_MEMBER', '你已经加入这个圈子');
    const pending = await tx.get('applications', applicationId(invite.id, actorId));
    if (pending?.status === 'pending') return {application: this.safeApplication(pending)};
    const pendingCount = (await tx.find('applications', {inviteId: invite.id, status: 'pending'})).length;
    if (pendingCount >= 20) fail('INVITE_FULL', '此邀请申请人数过多，请联系管理员重新邀请');
    const application: Application = {
      id: applicationId(invite.id, actorId), circleId: invite.circleId, inviteId: invite.id, userId: actorId,
      name: str(p.name, '姓名', 60), note: circle.type === 'classmate' ? str(p.note, '同班核对说明', 300) : optionalStr(p.note, '说明', 300),
      status: 'pending', createdAt: this.now()
    };
    await tx.put('applications', application);
    await this.audit(tx, invite.circleId, actorId, 'join.apply', application.id);
    return {application: this.safeApplication(application)};
  }

  private safeApplication(application: Application, includeIdentity = false) {
    const {id, circleId, inviteId, name, note, status, createdAt, reviewedAt} = application;
    return {...{id, circleId, inviteId, name, note, status, createdAt, reviewedAt}, ...(includeIdentity ? {memberId: memberId(circleId, application.userId)} : {})};
  }

  private async listInvites(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const invites = await tx.find('invites', {circleId: circle.id});
    return {invites: invites.map(i => ({id: i.id, circleId: i.circleId, createdAt: i.createdAt, expiresAt: i.expiresAt, status: this.inviteStatus(i)}))};
  }

  private async revokeInvite(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const invite = await tx.get('invites', str(p.inviteId, 'inviteId'));
    if (!invite || invite.circleId !== circle.id) fail('NOT_FOUND', '邀请不存在');
    if (!invite.revokedAt) { invite.revokedAt = this.now(); await tx.put('invites', invite); await this.audit(tx, circle.id, actorId, 'invite.revoke', invite.id); }
    return {invite: {id: invite.id, status: this.inviteStatus(invite)}};
  }

  private async listApplications(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const applications = await tx.find('applications', {circleId: circle.id, status: 'pending'});
    const views = await Promise.all(applications.map(async application => {
      const invite = await tx.get('invites', application.inviteId);
      const validInvite = invite?.circleId === circle.id ? invite : undefined;
      return {
        ...this.safeApplication(application, true),
        inviteStatus: validInvite ? this.inviteStatus(validInvite) : 'missing',
        inviteExpiresAt: validInvite?.expiresAt
      };
    }));
    return {applications: views};
  }

  private async myApplications(tx: UnitOfWork, actorId: string) {
    const applications = await tx.find('applications', {userId: actorId});
    const views = await Promise.all(applications.map(async application => {
      const circle = await tx.get('circles', application.circleId);
      const invite = application.status === 'pending' ? await tx.get('invites', application.inviteId) : undefined;
      const inviteStatus = invite ? this.inviteStatus(invite) : application.status === 'pending' ? 'expired' : undefined;
      const status = application.status === 'pending' && inviteStatus !== 'active' ? 'expired' : application.status;
      return {...this.safeApplication(application), status, circleName: circle?.name || '圈子', circleType: circle?.type, inviteStatus};
    }));
    return {applications: views.sort((a, b) => b.createdAt - a.createdAt)};
  }

  private async resolveApplication(tx: UnitOfWork, p: Record<string, unknown>, actorId: string, approve: boolean) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const application = await tx.get('applications', str(p.applicationId, 'applicationId'));
    if (!application || application.circleId !== circle.id) fail('NOT_FOUND', '加入申请不存在');
    if (application.status !== 'pending') fail('ALREADY_REVIEWED', '申请已经处理');
    if (approve) {
      // Read and write the SAME invite document inside one CloudBase transaction.
      // Competing approvals therefore cannot both consume its one successful use.
      const invite = await tx.get('invites', application.inviteId);
      if (!invite || invite.circleId !== circle.id) fail('INVALID_INVITE', '邀请不存在');
      this.requireActiveInvite(invite);
      const mid = memberId(circle.id, application.userId);
      const existing = await tx.get('members', mid);
      if (existing?.status === 'active') fail('ALREADY_MEMBER', '申请人已经是成员');
      // Legacy application documents may still carry claimPersonId. Approval
      // must not trust or apply it; the new member claims a card afterwards.
      const member: Member = {id: mid, circleId: circle.id, userId: application.userId, name: application.name, role: 'member', status: 'active', joinedAt: this.now()};
      await tx.put('members', member);
      invite.usedAt = this.now(); invite.usedBy = application.userId;
      await tx.put('invites', invite);
      const others = await tx.find('applications', {inviteId: invite.id, status: 'pending'});
      for (const other of others) if (other.id !== application.id) { other.status = 'expired'; await tx.put('applications', other); }
    }
    application.status = approve ? 'approved' : 'rejected';
    application.reviewedAt = this.now(); application.reviewedBy = actorId;
    await tx.put('applications', application);
    await this.audit(tx, circle.id, actorId, approve ? 'join.approve' : 'join.reject', application.id);
    return {application: this.safeApplication(application, true)};
  }

  private safeMember(member: Member, actorId: string) {
    return {
      id: member.id, circleId: member.circleId, name: member.name || '成员', role: member.role,
      status: member.status, personId: member.personId, joinedAt: member.joinedAt,
      endedAt: member.endedAt, isSelf: member.userId === actorId
    };
  }

  private async listMembers(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    const members = await tx.find('members', {circleId: circle.id, status: 'active'});
    const views = await Promise.all(members.map(async m => {
      const person = m.personId ? await tx.get('persons', m.personId) : undefined;
      return {...this.safeMember(m, actorId), name: person?.circleId === circle.id ? person.name : m.name || '成员'};
    }));
    return {members: views};
  }

  private async scrubAfterLeaving(tx: UnitOfWork, member: Member) {
    if (member.personId) {
      const person = await tx.get('persons', member.personId);
      if (person && person.circleId === member.circleId && person.claimedBy === member.userId) {
        person.claimedBy = undefined;
        for (const field of privateFields) (person as unknown as Record<string, unknown>)[field] = undefined;
        person.visibility = {};
        person.updatedAt = this.now();
        await tx.put('persons', person);
      }
      member.personId = undefined;
    }
    const delegations = await tx.find('delegations', {circleId: member.circleId});
    for (const delegation of delegations) {
      if (!delegation.revokedAt && (delegation.ownerUserId === member.userId || delegation.adminUserId === member.userId)) {
        delegation.revokedAt = this.now();
        await tx.put('delegations', delegation);
      }
    }
  }

  private async endMember(tx: UnitOfWork, p: Record<string, unknown>, actorId: string, state: 'left' | 'removed') {
    const {circle, member: actor} = await this.access(tx, p.circleId, actorId, state === 'removed' ? 'admin' : 'member');
    let target: Member;
    if (state === 'left') target = actor;
    else {
      const result = await tx.get('members', str(p.memberId, 'memberId'));
      if (!result || result.circleId !== circle.id || result.status !== 'active') fail('NOT_FOUND', '成员不存在');
      target = result;
      if (target.id === actor.id) fail('INVALID_INPUT', '请使用退出圈子');
      if (rank(actor.role) <= rank(target.role)) fail('FORBIDDEN', '不能移除同级或更高权限成员');
    }
    if (target.role === 'owner') fail('OWNER_REQUIRED', '圈主须先移交圈子');
    target.status = state; target.endedAt = this.now();
    await this.scrubAfterLeaving(tx, target);
    await tx.put('members', target);
    await this.audit(tx, circle.id, actorId, state === 'left' ? 'member.leave' : 'member.remove', target.id);
    return {member: this.safeMember(target, actorId)};
  }

  private async setRole(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'owner');
    const target = await tx.get('members', str(p.memberId, 'memberId'));
    if (!target || target.circleId !== circle.id || target.status !== 'active' || target.role === 'owner') fail('NOT_FOUND', '可调整的成员不存在');
    const role = oneOf(p.role, ['admin', 'member'] as const, '角色');
    target.role = role;
    await tx.put('members', target);
    if (role === 'member') {
      const delegations = await tx.find('delegations', {circleId: circle.id, adminUserId: target.userId});
      for (const delegation of delegations) if (!delegation.revokedAt) {delegation.revokedAt = this.now(); await tx.put('delegations', delegation);}
    }
    await this.audit(tx, circle.id, actorId, 'member.setRole', target.id, {role});
    return {member: this.safeMember(target, actorId)};
  }

  private async grantDelegation(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    const person = await this.person(tx, circle.id, p.personId);
    if (person.claimedBy !== actorId) fail('FORBIDDEN', '只有本人可以授权代维护');
    const admin = await tx.get('members', str(p.adminMemberId, 'adminMemberId'));
    if (!admin || admin.circleId !== circle.id || admin.status !== 'active' || rank(admin.role) < 2 || admin.userId === actorId) fail('INVALID_INPUT', '请选择本圈其他管理员');
    if (!Array.isArray(p.fields) || p.fields.length === 0 || p.fields.length > delegableFields.length) fail('INVALID_INPUT', '请选择授权字段');
    const fields: PersonField[] = [];
    for (const field of p.fields) {
      if (typeof field !== 'string' || !delegableFields.includes(field as PersonField)) fail('INVALID_INPUT', '授权字段不支持');
      if (!fields.includes(field as PersonField)) fields.push(field as PersonField);
    }
    const delegation: Delegation = {
      id: `${person.id}_${hash(admin.userId).slice(0, 40)}`, circleId: circle.id,
      personId: person.id, ownerUserId: actorId, adminUserId: admin.userId,
      fields, createdAt: this.now()
    };
    await tx.put('delegations', delegation);
    await this.audit(tx, circle.id, actorId, 'delegation.grant', delegation.id, {fields});
    return {delegation: {id: delegation.id, circleId: circle.id, personId: person.id, adminMemberId: admin.id, fields, createdAt: delegation.createdAt}};
  }

  private async revokeDelegation(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    const delegation = await tx.get('delegations', str(p.delegationId, 'delegationId'));
    if (!delegation || delegation.circleId !== circle.id) fail('NOT_FOUND', '授权不存在');
    if (delegation.ownerUserId !== actorId) fail('FORBIDDEN', '只有授权人可撤销');
    if (!delegation.revokedAt) { delegation.revokedAt = this.now(); await tx.put('delegations', delegation); await this.audit(tx, circle.id, actorId, 'delegation.revoke', delegation.id); }
    return {delegation: {id: delegation.id, revokedAt: delegation.revokedAt}};
  }

  private async createSuggestion(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId);
    const type = oneOf(p.type, ['person', 'relation', 'invite'] as const, '建议类型');
    let personId: string | undefined;
    if (p.personId !== undefined) personId = (await this.person(tx, circle.id, p.personId)).id;
    let relationChange: RelationChange | undefined;
    let expectedRelationHash: string | undefined;
    if (type === 'relation') {
      if (circle.type !== 'family') fail('WRONG_CIRCLE_TYPE', '同学圈没有亲属关系');
      relationChange = await this.parseRelationChange(tx, circle, p.relationChange);
      const plan = await this.planRelationChange(tx, circle, relationChange, actorId);
      if (plan.before) expectedRelationHash = relationFingerprint(plan.before);
    } else if (p.relationChange !== undefined) fail('INVALID_INPUT', '只有关系建议可包含关系更正');
    const suggestion: Suggestion = {id: id(), circleId: circle.id, createdBy: actorId, personId, type, message: str(p.message, '建议内容', 500), relationChange, expectedRelationHash, status: 'pending', createdAt: this.now()};
    await tx.put('suggestions', suggestion);
    await this.audit(tx, circle.id, actorId, 'suggestion.create', suggestion.id);
    return {suggestion: this.safeSuggestion(suggestion)};
  }
  private safeSuggestion(s: Suggestion) {return {id: s.id, circleId: s.circleId, type: s.type, personId: s.personId, message: s.message, relationChange: s.relationChange, status: s.status, createdAt: s.createdAt, resolvedAt: s.resolvedAt};}
  private async listSuggestions(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle, member} = await this.access(tx, p.circleId, actorId);
    const suggestions = await tx.find('suggestions', {circleId: circle.id});
    return {suggestions: suggestions.filter(s => rank(member.role) >= 2 || s.createdBy === actorId).map(s => this.safeSuggestion(s))};
  }
  private async resolveSuggestion(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const suggestion = await tx.get('suggestions', str(p.suggestionId, 'suggestionId'));
    if (!suggestion || suggestion.circleId !== circle.id) fail('NOT_FOUND', '建议不存在');
    if (suggestion.status !== 'pending') fail('ALREADY_REVIEWED', '建议已处理');
    const status = oneOf(p.status, ['accepted', 'rejected'] as const, '处理结果');
    let applied: Awaited<ReturnType<ApiService['applyRelationChange']>> | undefined;
    if (status === 'accepted' && suggestion.type !== 'relation') fail('CHANGE_REQUIRED', '请先完成实际修改，暂不能直接标为已采纳');
    if (status === 'accepted' && suggestion.type === 'relation') {
      if (!suggestion.relationChange) fail('CHANGE_REQUIRED', '此建议只有文字说明，请先提交具体关系更正');
      applied = await this.applyRelationChange(tx, circle, suggestion.relationChange, actorId, suggestion.expectedRelationHash);
    }
    suggestion.status = status;
    suggestion.resolvedAt = this.now(); suggestion.resolvedBy = actorId;
    await tx.put('suggestions', suggestion);
    await this.audit(tx, circle.id, actorId, 'suggestion.resolve', suggestion.id, {status: suggestion.status, ...(applied ? {removed: applied.before, created: applied.after, affectedPersonIds: applied.impact.affectedPersonIds, reason: suggestion.message} : {})});
    return {suggestion: this.safeSuggestion(suggestion), ...(applied ? {impact: applied.impact} : {})};
  }

  private async listAudit(tx: UnitOfWork, p: Record<string, unknown>, actorId: string) {
    const {circle} = await this.access(tx, p.circleId, actorId, 'admin');
    const events = await tx.find('audit', {circleId: circle.id});
    const views = await Promise.all(events.sort((a,b) => b.at - a.at).slice(0,100).map(async ({id, circleId, actorId: eventActorId, type, targetId, at, details}) => {
      const member = await tx.get('members', memberId(circle.id, eventActorId));
      const person = member?.personId ? await tx.get('persons', member.personId) : undefined;
      return {id, circleId, actorName: person?.circleId === circle.id ? person.name : member?.name || '原成员', type, targetId, at, details};
    }));
    return {events: views};
  }
}
