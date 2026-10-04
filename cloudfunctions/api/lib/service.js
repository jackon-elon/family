"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiService = exports.ApiError = void 0;
const crypto = require('node:crypto');
const repository_1 = require("./repository");
const birthday_1 = require("./birthday");
const lunar_calendar_1 = require("./lunar-calendar");
class ApiError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.ApiError = ApiError;
const profileFields = ['name', 'nickname', 'gender', 'birthOrder', 'birthday', 'country', 'province', 'city', 'latitude', 'longitude', 'status', 'school', 'industry', 'occupation', 'bio', 'phone', 'wechatId', 'photoFileId'];
// Rank among siblings belongs to a family graph. The remaining fields belong
// to the WeChat account and are projected onto all of its claimed cards.
const sharedProfileFields = profileFields.filter(field => field !== 'birthOrder');
const locationFields = ['country', 'province', 'city', 'latitude', 'longitude'];
const privateFields = ['birthday', 'country', 'province', 'city', 'latitude', 'longitude', 'status', 'school', 'industry', 'occupation', 'bio', 'phone', 'wechatId', 'photoFileId'];
const delegableFields = profileFields.filter(field => field !== 'latitude' && field !== 'longitude');
const relationTypes = ['parent', 'spouse', 'sibling'];
const inviteLifetime = 72 * 60 * 60 * 1000;
const ownerTransferLifetime = 72 * 60 * 60 * 1000;
const photoUploadWindow = 24 * 60 * 60 * 1000;
const maxPhotoUploadAttempts = 20;
const maxBulkTransactionWrites = 80;
const suggestionWindow = 24 * 60 * 60 * 1000;
const maxPendingSuggestionsPerCircle = 5;
const maxSuggestionsPerDayPerCircle = 10;
// A long-lived phone-to-account association could be reused after a number is
// reassigned. Re-consent is required before matching cards added months later.
const phoneIdentityLifetime = 90 * 24 * 60 * 60 * 1000;
function fail(code, message) { throw new ApiError(code, message); }
function object(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail('INVALID_INPUT', '请求内容格式错误');
    return value;
}
function str(value, name, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
        fail('INVALID_INPUT', `${name}格式错误`);
    return value.trim();
}
function optionalStr(value, name, max = 120) {
    if (value === undefined || value === null || value === '')
        return undefined;
    return str(value, name, max);
}
function parseBirthday(value, required = false) {
    if (value === undefined || value === null) {
        if (required)
            fail('PROFILE_INCOMPLETE', '请填写生日月日和阳历或农历');
        return undefined;
    }
    const raw = object(value);
    if (Object.keys(raw).some(key => !['calendar', 'month', 'day', 'year', 'leapMonth'].includes(key)))
        fail('INVALID_INPUT', '生日字段不支持');
    const calendar = oneOf(raw.calendar, ['solar', 'lunar'], '生日历法');
    const month = raw.month;
    const day = raw.day;
    if (!Number.isInteger(month) || Number(month) < 1 || Number(month) > 12 || !Number.isInteger(day) || Number(day) < 1 || Number(day) > 31)
        fail('INVALID_INPUT', '生日月日无效');
    const year = raw.year;
    if (year !== undefined && (!Number.isInteger(year) || Number(year) < 1900 || Number(year) > 2100))
        fail('INVALID_INPUT', '生日年份无效');
    if (raw.leapMonth !== undefined && typeof raw.leapMonth !== 'boolean')
        fail('INVALID_INPUT', '闰月标记无效');
    if (calendar === 'solar') {
        if (raw.leapMonth === true)
            fail('INVALID_INPUT', '阳历生日不能标记闰月');
        const checkYear = year === undefined ? 2000 : Number(year);
        const date = new Date(Date.UTC(checkYear, Number(month) - 1, Number(day)));
        if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day))
            fail('INVALID_INPUT', '阳历生日不存在');
    }
    else {
        if (Number(day) > 30)
            fail('INVALID_INPUT', '农历每月最多三十天');
        // The conversion table fully covers lunar years 1901–2099. A dated
        // birthday must actually exist in its birth year; yearly observance
        // fallbacks (short months / missing leap months) are a separate concern.
        // Keep yearless anniversaries and partially covered 1900/2100 inputs.
        if (year !== undefined && Number(year) >= 1901 && Number(year) <= 2099 &&
            !(0, lunar_calendar_1.gregorianForLunar)({ year: Number(year), month: Number(month), day: Number(day), leapMonth: raw.leapMonth === true })) {
            fail('INVALID_INPUT', '填写的农历生日在该出生年份不存在，请检查月份、日期和闰月');
        }
    }
    return { calendar, month: Number(month), day: Number(day), ...(year === undefined ? {} : { year: Number(year) }), ...(calendar === 'lunar' && raw.leapMonth === true ? { leapMonth: true } : {}) };
}
function profileComplete(person) {
    return Boolean(person.name?.trim() && person.country?.trim() && person.city?.trim() && person.birthday);
}
function parseJoinProfile(value) {
    if (value === undefined)
        fail('PROFILE_INCOMPLETE', '请先填写城市和生日再申请加入');
    const raw = object(value);
    if (Object.keys(raw).some(key => !['country', 'province', 'city', 'latitude', 'longitude', 'birthday'].includes(key)))
        fail('INVALID_INPUT', '申请资料字段不支持');
    const country = str(raw.country, '国家或地区', 80);
    const province = optionalStr(raw.province, '省份', 80);
    const city = str(raw.city, '城市', 80);
    const latitude = raw.latitude;
    const longitude = raw.longitude;
    if ((latitude === undefined) !== (longitude === undefined))
        fail('INVALID_INPUT', '城市坐标须同时填写');
    if (latitude !== undefined && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180))
        fail('INVALID_INPUT', '城市坐标无效');
    return { country, province, city, ...(latitude === undefined ? {} : { latitude: Math.round(latitude * 10) / 10, longitude: Math.round(longitude * 10) / 10 }), birthday: parseBirthday(raw.birthday, true) };
}
function oneOf(value, values, name) {
    if (typeof value !== 'string' || !values.includes(value))
        fail('INVALID_INPUT', `${name}不支持`);
    return value;
}
function parseInitialRelation(raw) {
    const input = object(raw);
    const anchorPersonId = str(input.anchorPersonId, '关系对象');
    const kind = oneOf(input.kind, ['newParent', 'newChild', 'spouse', 'sibling'], '关系类型');
    const older = oneOf(input.older ?? 'unknown', ['unknown', 'new', 'anchor'], '兄弟姐妹长幼');
    if (input.older !== undefined && kind !== 'sibling')
        fail('INVALID_INPUT', '只有兄弟姐妹关系可记录长幼');
    return { anchorPersonId, kind, older };
}
function id() { return crypto.randomUUID(); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function createRequestId(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value))
        fail('INVALID_INPUT', 'requestId 格式错误');
    return value;
}
function stableCreateId(scope, actorId, requestId) {
    return `idem_${hash(JSON.stringify([scope, actorId, requestId])).slice(0, 40)}`;
}
function photoOwnerPath(circleId, userId) { return hash(`${circleId}|${userId}`).slice(0, 40); }
function memberId(circleId, userId) { return `${circleId}_${hash(userId).slice(0, 40)}`; }
function phoneIdentityId(userId) { return `phone_identity_${hash(userId).slice(0, 40)}`; }
function userProfileId(userId) { return `user_profile_${hash(userId).slice(0, 40)}`; }
function personRemarkId(circleId, personId, userId) { return `person_remark_${hash(JSON.stringify([circleId, personId, userId])).slice(0, 40)}`; }
function phoneMatchId(circleId, phone) { return `phone_match_${hash(JSON.stringify([circleId, phone])).slice(0, 40)}`; }
function normalizePhone(value) {
    if (typeof value !== 'string')
        fail('INVALID_INPUT', '手机号格式错误');
    const compact = value.replace(/[\s()-]/g, '');
    const phone = /^1[3-9]\d{9}$/.test(compact) ? `+86${compact}` : compact;
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+86') && !/^\+861[3-9]\d{9}$/.test(phone))) {
        fail('INVALID_INPUT', '请填中国大陆手机号，其他地区请加国家区号');
    }
    return phone;
}
function optionalMatchPhone(value) {
    return value === undefined || value === null || value === '' ? undefined : normalizePhone(value);
}
function claimRequestId(circleId, personId, userId) { return `${circleId}_${hash(`${personId}|${userId}`).slice(0, 40)}`; }
function applicationId(inviteId, userId) { return `${inviteId}_${hash(userId).slice(0, 40)}`; }
function relationId(circleId, type, from, to) {
    const endpoints = type === 'parent' ? [from, to] : [from, to].sort();
    return `${circleId}_${hash(`${type}|${endpoints[0]}|${endpoints[1]}`).slice(0, 40)}`;
}
function relationSummary(relation) {
    const { id, from, to, type, olderId } = relation;
    return { id, from, to, type, olderId };
}
function relationFingerprint(relation) {
    return hash(JSON.stringify([relation.id, relation.from, relation.to, relation.type, relation.olderId, relation.createdBy, relation.createdAt]));
}
function validateFamilyGraph(relations) {
    const pairTypes = new Map();
    const children = new Map();
    const adjacency = new Map();
    const add = (from, to, distance) => {
        if (!adjacency.has(from))
            adjacency.set(from, []);
        adjacency.get(from).push({ id: to, distance });
    };
    for (const relation of relations) {
        const pair = [relation.from, relation.to].sort().join('|');
        const existing = pairTypes.get(pair);
        if (existing)
            fail('RELATION_CONFLICT', '同两人之间已有不能并存的关系');
        pairTypes.set(pair, relation.type);
        const distance = relation.type === 'parent' ? 1 : 0;
        add(relation.from, relation.to, distance);
        add(relation.to, relation.from, -distance);
        if (relation.type === 'parent') {
            if (!children.has(relation.from))
                children.set(relation.from, []);
            children.get(relation.from).push(relation.to);
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const checkCycle = (personId) => {
        if (visiting.has(personId))
            fail('RELATION_CYCLE', '亲子关系不能形成循环');
        if (visited.has(personId))
            return;
        visiting.add(personId);
        for (const child of children.get(personId) ?? [])
            checkCycle(child);
        visiting.delete(personId);
        visited.add(personId);
    };
    for (const personId of children.keys())
        checkCycle(personId);
    const generation = new Map();
    for (const start of adjacency.keys()) {
        if (generation.has(start))
            continue;
        generation.set(start, 0);
        const queue = [start];
        for (let cursor = 0; cursor < queue.length; cursor++) {
            const current = queue[cursor];
            const value = generation.get(current);
            for (const next of adjacency.get(current) ?? []) {
                const expected = value + next.distance;
                const actual = generation.get(next.id);
                if (actual === undefined) {
                    generation.set(next.id, expected);
                    queue.push(next.id);
                }
                else if (actual !== expected)
                    fail('GENERATION_CONFLICT', '这条关系与现有辈分关系矛盾');
            }
        }
    }
}
function affectedComponentIds(relations, added, endpoints) {
    const adjacency = new Map();
    for (const relation of added ? [...relations, added] : relations) {
        if (!adjacency.has(relation.from))
            adjacency.set(relation.from, new Set());
        if (!adjacency.has(relation.to))
            adjacency.set(relation.to, new Set());
        adjacency.get(relation.from).add(relation.to);
        adjacency.get(relation.to).add(relation.from);
    }
    const seen = new Set(endpoints);
    const queue = [...endpoints];
    for (let cursor = 0; cursor < queue.length; cursor++) {
        for (const next of adjacency.get(queue[cursor]) ?? [])
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
    }
    return [...seen];
}
function effectiveDelegationFields(fields) {
    return fields.includes('city') ? [...new Set([...fields, 'country', 'province', 'latitude', 'longitude'])] : fields;
}
function rank(role) { return role === 'owner' ? 3 : role === 'admin' ? 2 : 1; }
function safePublicCircle(circle) { const { id, name, type, school, cohort, className } = circle; return { id, name, type, school, cohort, className }; }
function safeCircle(circle) { const { ownerId: _ownerId, createdBy: _createdBy, createPayloadHash: _createPayloadHash, ownerTransfer: _ownerTransfer, ...view } = circle; return view; }
class ApiService {
    repo;
    now;
    signPhoto;
    signPhotos;
    constructor(repo, now = Date.now, signPhoto, signPhotos) {
        this.repo = repo;
        this.now = now;
        this.signPhoto = signPhoto;
        this.signPhotos = signPhotos;
    }
    nextPersonUpdatedAt(person) {
        return Math.max(this.now(), person.updatedAt + 1);
    }
    async storedProfile(tx, userId) {
        const profile = await tx.get('userProfiles', userProfileId(userId));
        return profile?.userId === userId ? profile : undefined;
    }
    profileFromPerson(person, userId) {
        const now = this.now();
        const profile = { id: userProfileId(userId), userId, createdAt: now, updatedAt: now };
        for (const field of sharedProfileFields) {
            profile[field] = person[field];
        }
        return profile;
    }
    fillProfileBlanks(profile, person) {
        // Coordinates must follow the selected city, never an older card's city.
        const locationChanged = (profile.country !== undefined && profile.country !== person.country) ||
            (profile.province !== undefined && profile.province !== person.province) ||
            (profile.city !== undefined && profile.city !== person.city);
        let filled = false;
        for (const field of sharedProfileFields) {
            if (profile.clearedFields?.includes(field))
                continue;
            if (locationChanged && (field === 'province' || field === 'latitude' || field === 'longitude'))
                continue;
            const row = profile;
            if (row[field] === undefined && person[field] !== undefined) {
                row[field] = person[field];
                filled = true;
            }
        }
        return filled;
    }
    async ensureProfileForPerson(tx, person, userId) {
        const existing = await this.storedProfile(tx, userId);
        if (existing) {
            // A member may have uploaded a photo or started filling their profile
            // before a card was linked. Keep their choices and fill only blanks.
            const filled = this.fillProfileBlanks(existing, person);
            if (filled) {
                existing.updatedAt = this.now();
                await tx.put('userProfiles', existing);
            }
            return existing;
        }
        const profile = this.profileFromPerson(person, userId);
        await tx.put('userProfiles', profile);
        return profile;
    }
    async ensureEmptyProfile(tx, userId) {
        const existing = await this.storedProfile(tx, userId);
        if (existing)
            return existing;
        const now = this.now();
        const profile = { id: userProfileId(userId), userId, createdAt: now, updatedAt: now, cardFallback: true };
        await tx.put('userProfiles', profile);
        return profile;
    }
    async hydratedPerson(tx, person) {
        if (!person.claimedBy)
            return person;
        const profile = await this.storedProfile(tx, person.claimedBy);
        return this.personWithProfile(person, profile);
    }
    async profilesByUser(tx, userIds) {
        const allowed = new Set(userIds.filter((userId) => Boolean(userId)));
        const rows = await tx.findByIds('userProfiles', [...allowed].map(userProfileId));
        return new Map(rows.filter(row => allowed.has(row.userId) && row.id === userProfileId(row.userId)).map(row => [row.userId, row]));
    }
    async peopleForRead(tx, rows) {
        const profiles = await this.profilesByUser(tx, rows.map(person => person.claimedBy));
        // A person may leave while the external profile queries are running. Read
        // the subject bindings after the profiles, so an old circle snapshot can
        // never expose a newer account profile after that binding has ended.
        const original = new Map(rows.map(person => [person.id, person]));
        const current = (await tx.findByIds('persons', [...original.keys()]))
            .filter(person => original.get(person.id)?.circleId === person.circleId);
        const members = new Map((await tx.findByIds('members', current.filter(person => person.claimedBy)
            .map(person => memberId(person.circleId, person.claimedBy)))).map(member => [member.id, member]));
        return current.map(person => {
            const before = original.get(person.id);
            const member = person.claimedBy ? members.get(memberId(person.circleId, person.claimedBy)) : undefined;
            const sameBinding = before.claimedBy === person.claimedBy && before.createdAt === person.createdAt &&
                member?.status === 'active' && member.userId === person.claimedBy && member.circleId === person.circleId && member.personId === person.id;
            return this.personWithProfile(person, sameBinding ? profiles.get(person.claimedBy || '') : undefined);
        });
    }
    personWithProfile(person, profile) {
        if (!profile)
            return person; // legacy card; migrated when its owner next opens My
        const view = { ...person };
        for (const field of sharedProfileFields) {
            const canonical = profile[field];
            if (!profile.cardFallback || canonical !== undefined || profile.clearedFields?.includes(field)) {
                view[field] = canonical;
            }
            const correction = person.profileOverrides?.[field];
            if (correction && correction.baseRevision === this.profileFieldRevision(profile, field)) {
                view[field] = correction.value === null ? undefined : correction.value;
            }
        }
        return view;
    }
    profileFieldRevision(profile, field) {
        return profile.fieldRevisions?.[field] ?? 0;
    }
    touchProfileFields(profile, fields) {
        const touched = fields.some(field => locationFields.includes(field))
            ? [...new Set([...fields, ...locationFields])] : [...new Set(fields)];
        profile.fieldRevisions ??= {};
        profile.clearedFields ??= [];
        for (const field of touched) {
            profile.fieldRevisions[field] = (profile.fieldRevisions[field] ?? 0) + 1;
            if (profile[field] === undefined) {
                if (!profile.clearedFields.includes(field))
                    profile.clearedFields.push(field);
            }
            else
                profile.clearedFields = profile.clearedFields.filter(key => key !== field);
        }
    }
    profileView(profile) {
        const view = {};
        for (const field of sharedProfileFields) {
            const value = profile[field];
            if (field !== 'photoFileId' && value !== undefined)
                view[field] = value;
        }
        return { ...view, hasPhoto: Boolean(profile.photoFileId), profileComplete: profileComplete(profile), updatedAt: profile.updatedAt };
    }
    profileVersion(profile) {
        // Compare values rather than updatedAt: two edits can happen in one
        // millisecond, and a photo or contact edit must invalidate an old review.
        return hash(JSON.stringify(sharedProfileFields.map(field => {
            if (field === 'birthday') {
                const birthday = profile.birthday;
                return birthday ? [birthday.calendar, birthday.month, birthday.day,
                    birthday.year ?? null, birthday.leapMonth === true] : null;
            }
            return profile[field] ?? null;
        })));
    }
    joinProfileFromAccount(profile) {
        return parseJoinProfile({ country: profile.country, province: profile.province, city: profile.city,
            latitude: profile.latitude, longitude: profile.longitude, birthday: profile.birthday });
    }
    applicationIdentityKey(name, profile) {
        const birthday = profile?.birthday;
        return JSON.stringify([name, profile?.country ?? null, profile?.province ?? null,
            profile?.city ?? null, profile?.latitude ?? null, profile?.longitude ?? null,
            birthday?.calendar ?? null, birthday?.month ?? null, birthday?.day ?? null,
            birthday?.year ?? null, birthday?.leapMonth === true]);
    }
    applicationProfileChanged(application, profile, name, joinedProfile) {
        return application.profileVersion
            ? application.profileVersion !== this.profileVersion(profile)
            : this.applicationIdentityKey(application.name, application.profile) !== this.applicationIdentityKey(name, joinedProfile);
    }
    applicationReviewToken(application, profile) {
        return hash(JSON.stringify([application.id, this.profileVersion(profile)]));
    }
    async ownProfile(tx, actorId) {
        // An administrator may have entered the older card. Never treat it as
        // account-owned data merely because its owner opened My.
        return this.storedProfile(tx, actorId);
    }
    async ownPhotoTarget(tx, actorId) {
        const memberships = await tx.find('members', { userId: actorId, status: 'active' });
        for (const member of memberships) {
            if (!member.personId)
                continue;
            const current = await tx.get('members', memberId(member.circleId, actorId));
            const person = await tx.get('persons', member.personId);
            if (current?.status === 'active' && current.personId === member.personId &&
                person?.circleId === member.circleId && person.claimedBy === actorId) {
                return { circleId: member.circleId, personId: person.id };
            }
        }
        return null;
    }
    async getAccountProfile(tx, actorId) {
        const profile = await this.ownProfile(tx, actorId);
        return { profile: profile ? this.profileView(profile) : null, photoUploadTarget: await this.ownPhotoTarget(tx, actorId) };
    }
    async updateAccountProfile(tx, p, actorId) {
        const patch = this.parsePatch(p.patch);
        if ('birthOrder' in patch || patch.photoFileId !== undefined)
            fail('INVALID_INPUT', '该资料字段不能在这里修改');
        const latitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'latitude');
        const longitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'longitude');
        if (latitudeTouched !== longitudeTouched ||
            (latitudeTouched && ((patch.latitude === undefined) !== (patch.longitude === undefined)))) {
            fail('INVALID_INPUT', '城市坐标须同时填写或同时清除');
        }
        const existing = await this.ownProfile(tx, actorId);
        const now = this.now();
        const profile = existing ?? { id: userProfileId(actorId), userId: actorId, createdAt: now, updatedAt: now, cardFallback: true };
        const wasComplete = profileComplete(profile);
        const locationNameChanged = (Object.prototype.hasOwnProperty.call(patch, 'city') && patch.city !== profile.city) ||
            (Object.prototype.hasOwnProperty.call(patch, 'country') && patch.country !== profile.country) ||
            (Object.prototype.hasOwnProperty.call(patch, 'province') && patch.province !== profile.province);
        Object.assign(profile, patch);
        if (profileComplete(profile))
            profile.cardFallback = undefined;
        if (wasComplete && !profileComplete(profile))
            fail('PROFILE_INCOMPLETE', '已加入关系网的资料须保留姓名、国家或地区、城市和生日');
        if (!profile.city || (locationNameChanged && !latitudeTouched)) {
            profile.latitude = undefined;
            profile.longitude = undefined;
        }
        if (latitudeTouched && patch.latitude !== undefined && !profile.city)
            fail('INVALID_INPUT', '请先填写城市再确认城市中心点');
        this.touchProfileFields(profile, Object.keys(patch));
        profile.updatedAt = now;
        await tx.put('userProfiles', profile);
        return { profile: this.profileView(profile) };
    }
    async invoke(request, actorId) {
        try {
            const action = str(request?.action, 'action', 80);
            if (action !== 'invite.preview' && !actorId)
                fail('UNAUTHENTICATED', '请先登录微信');
            const p = object(request.payload ?? {});
            const data = action === 'photo.url'
                ? await this.signedPhotoUrl(p, actorId ?? '')
                : action === 'photo.urls'
                    ? await this.signedPhotoUrls(p, actorId ?? '')
                    : action === 'account.sync'
                        ? await this.syncVerifiedPhone(actorId ?? '')
                        : await this.repo.atomic(tx => this.dispatch(tx, action, p, actorId ?? ''));
            // Bulk profile queries deliberately run outside document transactions.
            // Recheck current access in a fresh, short transaction before releasing
            // their results, including administrator status for the approval list.
            if (['person.list', 'member.list', 'birthday.upcoming', 'join.list'].includes(action)) {
                const circleIds = action === 'birthday.upcoming' && p.circleId === undefined
                    ? [...new Set(data.events.map(event => event.circleId))]
                    : [str(p.circleId, 'circleId')];
                await this.repo.atomic(async (tx) => {
                    for (const circleId of circleIds)
                        await this.access(tx, circleId, actorId ?? '', action === 'join.list' ? 'admin' : 'member');
                });
            }
            return { ok: true, data };
        }
        catch (error) {
            if (error instanceof ApiError)
                return { ok: false, error: { code: error.code, message: error.message } };
            if (error instanceof repository_1.QueryResultLimitError)
                return { ok: false, error: { code: 'DATA_LIMIT', message: '当前数据量超过查询上限，请联系管理员处理' } };
            // Do not return database errors, secrets or stack traces to clients.
            return { ok: false, error: { code: 'SERVER_ERROR', message: '服务暂时不可用，请稍后重试' } };
        }
    }
    /** Cloud-function-only reservation; never dispatch this as a client action. */
    async reservePhotoUpload(payload, actorId) {
        try {
            if (!actorId)
                fail('UNAUTHENTICATED', '请先登录微信');
            const p = object(payload);
            const data = await this.repo.atomic(async (tx) => {
                const path = await this.photoUploadPath(tx, p, actorId);
                const budgetId = `photo_${hash(actorId).slice(0, 40)}`;
                const now = this.now();
                let budget = await tx.get('photoUploadBudgets', budgetId);
                if (!budget || now < budget.windowStartedAt || now - budget.windowStartedAt >= photoUploadWindow) {
                    budget = { id: budgetId, windowStartedAt: now, count: 0, reservationIds: [] };
                }
                if (budget.count >= maxPhotoUploadAttempts)
                    fail('PHOTO_UPLOAD_LIMIT', '每 24 小时最多尝试上传 20 张照片，请稍后再试');
                const reservationId = id();
                budget.count++;
                budget.reservationIds.push(reservationId);
                await tx.put('photoUploadBudgets', budget);
                return { ...path, reservationId };
            });
            return { ok: true, data };
        }
        catch (error) {
            if (error instanceof ApiError)
                return { ok: false, error: { code: error.code, message: error.message } };
            if (error instanceof repository_1.QueryResultLimitError)
                return { ok: false, error: { code: 'DATA_LIMIT', message: '当前数据量超过查询上限，请联系管理员处理' } };
            return { ok: false, error: { code: 'SERVER_ERROR', message: '服务暂时不可用，请稍后重试' } };
        }
    }
    /** Refund only after the new cloud object is known to have been removed. */
    async refundPhotoUpload(actorId, reservationId) {
        const budgetId = `photo_${hash(actorId).slice(0, 40)}`;
        await this.repo.atomic(async (tx) => {
            const budget = await tx.get('photoUploadBudgets', budgetId);
            if (!budget)
                return;
            const index = budget.reservationIds.indexOf(reservationId);
            if (index < 0)
                return;
            budget.reservationIds.splice(index, 1);
            budget.count = Math.max(0, budget.count - 1);
            await tx.put('photoUploadBudgets', budget);
        });
    }
    /** Cloud-function-only binding after a sanitized upload; no client action maps here. */
    async bindUploadedPhoto(payload, actorId) {
        try {
            if (!actorId)
                fail('UNAUTHENTICATED', '请先登录微信');
            const p = object(payload);
            const fileID = str(p.fileID, 'fileID', 512);
            const data = await this.repo.atomic(async (tx) => {
                if (p.circleId === undefined && p.personId === undefined) {
                    const expected = photoOwnerPath('account', actorId);
                    const match = /^cloud:\/\/[^/]+\/photos\/([0-9a-f]{40})\/[0-9a-f-]{36}\.jpg$/.exec(fileID);
                    if (!match || match[1] !== expected)
                        fail('INVALID_INPUT', '照片文件不在你的上传目录');
                    const now = this.now();
                    const profile = await this.ownProfile(tx, actorId) ??
                        { id: userProfileId(actorId), userId: actorId, createdAt: now, updatedAt: now };
                    profile.photoFileId = fileID;
                    this.touchProfileFields(profile, ['photoFileId']);
                    profile.updatedAt = now;
                    await tx.put('userProfiles', profile);
                    return { profile: this.profileView(profile) };
                }
                return this.updatePerson(tx, {
                    circleId: p.circleId, personId: p.personId,
                    patch: { photoFileId: fileID }
                }, actorId, true);
            });
            return { ok: true, data };
        }
        catch (error) {
            if (error instanceof ApiError)
                return { ok: false, error: { code: error.code, message: error.message } };
            if (error instanceof repository_1.QueryResultLimitError)
                return { ok: false, error: { code: 'DATA_LIMIT', message: '当前数据量超过查询上限，请联系管理员处理' } };
            return { ok: false, error: { code: 'SERVER_ERROR', message: '服务暂时不可用，请稍后重试' } };
        }
    }
    /** Only the cloud entry point may call this after exchanging a WeChat phone code. */
    async linkVerifiedPhone(actorId, verifiedPhone) {
        try {
            if (!actorId)
                fail('UNAUTHENTICATED', '请先登录微信');
            const phone = normalizePhone(verifiedPhone);
            const identity = { id: phoneIdentityId(actorId), userId: actorId, phone, verifiedAt: this.now() };
            await this.repo.atomic(tx => tx.put('phoneIdentities', identity));
            return { ok: true, data: await this.syncVerifiedPhone(actorId) };
        }
        catch (error) {
            if (error instanceof ApiError)
                return { ok: false, error: { code: error.code, message: error.message } };
            if (error instanceof repository_1.QueryResultLimitError)
                return { ok: false, error: { code: 'DATA_LIMIT', message: '当前数据量超过查询上限，请联系管理员处理' } };
            return { ok: false, error: { code: 'SERVER_ERROR', message: '服务暂时不可用，请稍后重试' } };
        }
    }
    async syncVerifiedPhone(actorId) {
        const identityId = phoneIdentityId(actorId);
        const identity = await this.repo.atomic(tx => tx.get('phoneIdentities', identityId));
        const empty = { hasVerifiedPhone: false, linked: [],
            alreadyLinked: [], skipped: 0 };
        if (!identity || identity.userId !== actorId)
            return empty;
        if (this.now() >= identity.verifiedAt + phoneIdentityLifetime) {
            await this.repo.atomic(async (tx) => {
                const latest = await tx.get('phoneIdentities', identityId);
                if (latest?.userId === actorId && this.now() >= latest.verifiedAt + phoneIdentityLifetime) {
                    await tx.delete('phoneIdentities', identityId);
                }
            });
            return empty;
        }
        const candidates = await this.repo.atomic(tx => tx.find('phoneMatches', { phone: identity.phone }));
        if (candidates.length > maxBulkTransactionWrites)
            fail('DATA_LIMIT', '待关联资料过多，请联系管理员处理');
        const result = { ...empty, hasVerifiedPhone: true };
        for (const candidate of candidates) {
            const state = await this.repo.atomic(async (tx) => {
                const latestIdentity = await tx.get('phoneIdentities', identityId);
                if (!latestIdentity || latestIdentity.userId !== actorId || latestIdentity.phone !== identity.phone ||
                    this.now() >= latestIdentity.verifiedAt + phoneIdentityLifetime)
                    return 'skip';
                // The indexed document is read by deterministic ID in the transaction;
                // the collection query above is only a candidate list.
                const match = await tx.get('phoneMatches', candidate.id);
                if (!match || match.phone !== identity.phone || match.circleId !== candidate.circleId || match.personId !== candidate.personId)
                    return 'skip';
                const circle = await tx.get('circles', match.circleId);
                const person = await tx.get('persons', match.personId);
                const member = await tx.get('members', memberId(match.circleId, actorId));
                if (!person || person.circleId !== match.circleId || person.matchPhone !== match.phone) {
                    await tx.delete('phoneMatches', match.id);
                    return 'skip';
                }
                if (!circle || circle.mode !== 'shared' || !profileComplete(person))
                    return 'skip';
                if (person.claimedBy === actorId && member?.status === 'active' && member.personId === person.id) {
                    person.matchPhone = undefined;
                    await tx.put('persons', person);
                    await tx.delete('phoneMatches', match.id);
                    return 'already';
                }
                // A phone number confirms identity, not consent to join a record.
                // Only an existing active membership may link its own pre-recorded card.
                if (person.claimedBy || member?.status !== 'active' || (member.personId && member.personId !== person.id))
                    return 'skip';
                // Older data can have a claimed card while its member.personId was
                // lost. Do not give that account a second self card in this circle.
                const priorSelfCandidates = await tx.find('persons', { circleId: circle.id, claimedBy: actorId });
                for (const candidateSelf of priorSelfCandidates) {
                    const currentSelf = await tx.get('persons', candidateSelf.id);
                    if (currentSelf?.circleId === circle.id && currentSelf.claimedBy === actorId && currentSelf.id !== person.id)
                        return 'skip';
                }
                const pendingClaims = await tx.find('claimRequests', { circleId: circle.id, userId: actorId, status: 'pending' });
                if (pendingClaims.length > 15)
                    return 'skip';
                const now = this.now();
                person.claimedBy = actorId;
                person.matchPhone = undefined;
                person.lastConfirmedAt = now;
                person.updatedAt = this.nextPersonUpdatedAt(person);
                // Never import administrator-entered card data into the account's
                // canonical profile. That profile can span other records.
                await this.ensureEmptyProfile(tx, actorId);
                member.personId = person.id;
                await tx.put('persons', person);
                await tx.put('members', member);
                await tx.delete('phoneMatches', match.id);
                for (const candidateClaim of pendingClaims) {
                    const claim = await tx.get('claimRequests', candidateClaim.id);
                    if (!claim || claim.circleId !== circle.id || claim.userId !== actorId || claim.status !== 'pending')
                        continue;
                    claim.status = claim.personId === person.id ? 'approved' : 'rejected';
                    claim.reviewedAt = now;
                    claim.reviewedBy = 'system_phone_match';
                    await tx.put('claimRequests', claim);
                }
                await this.audit(tx, circle.id, actorId, 'person.phoneLinked', person.id);
                return 'linked';
            });
            if (state === 'linked')
                result.linked.push({ circleId: candidate.circleId, personId: candidate.personId });
            else if (state === 'already')
                result.alreadyLinked.push({ circleId: candidate.circleId, personId: candidate.personId });
            else
                result.skipped++;
        }
        return result;
    }
    async dispatch(tx, action, p, actorId) {
        switch (action) {
            case 'circle.create': return this.createCircle(tx, p, actorId);
            case 'circle.list': return this.listCircles(tx, actorId);
            case 'circle.detail': return this.detailCircle(tx, p, actorId);
            case 'circle.upgrade': return this.upgradeCircle(tx, p, actorId);
            case 'circle.transferOwner': return this.transferOwner(tx, p, actorId);
            case 'circle.acceptOwnerTransfer': return this.acceptOwnerTransfer(tx, p, actorId);
            case 'circle.cancelOwnerTransfer': return this.cancelOwnerTransfer(tx, p, actorId);
            case 'account.profile.get': return this.getAccountProfile(tx, actorId);
            case 'account.profile.update': return this.updateAccountProfile(tx, p, actorId);
            case 'person.list': return this.listPeople(tx, p, actorId);
            case 'person.get': return this.getPerson(tx, p, actorId);
            case 'person.remark.list': return this.listPersonRemarks(tx, p, actorId);
            case 'person.remark.get': return this.personRemark(tx, p, actorId, false);
            case 'person.remark.update': return this.personRemark(tx, p, actorId, true);
            case 'person.matchPhone': return this.getMatchPhone(tx, p, actorId);
            case 'birthday.upcoming': return this.upcomingBirthdays(tx, p, actorId);
            case 'person.create': return this.createPerson(tx, p, actorId);
            case 'person.update': return this.updatePerson(tx, p, actorId);
            case 'person.delete': return this.deletePerson(tx, p, actorId);
            case 'person.claim': return this.claimPerson(tx, p, actorId);
            case 'person.claimList': return this.listClaims(tx, p, actorId);
            case 'person.claimMine': return this.myClaims(tx, p, actorId);
            case 'person.claimApprove': return this.resolveClaim(tx, p, actorId, true);
            case 'person.claimReject': return this.resolveClaim(tx, p, actorId, false);
            case 'person.unclaim': return this.unclaimPerson(tx, p, actorId);
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
            case 'join.mine': return this.myApplications(tx, p, actorId);
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
    async circle(tx, circleId) {
        const circle = await tx.get('circles', str(circleId, 'circleId'));
        if (!circle)
            fail('NOT_FOUND', '记录不存在');
        return circle;
    }
    async member(tx, circleId, actorId) {
        const member = await tx.get('members', memberId(circleId, actorId));
        if (!member || member.status !== 'active')
            fail('FORBIDDEN', '你尚未加入这份记录');
        return member;
    }
    async access(tx, circleId, actorId, min = 'member') {
        const circle = await this.circle(tx, circleId);
        const member = await this.member(tx, circle.id, actorId);
        if (rank(member.role) < rank(min))
            fail('FORBIDDEN', '没有此操作权限');
        return { circle, member };
    }
    async person(tx, circleId, personId) {
        const person = await tx.get('persons', str(personId, 'personId'));
        if (!person || person.circleId !== circleId)
            fail('NOT_FOUND', '人物不存在');
        return person;
    }
    async audit(tx, circleId, actorId, type, targetId, details) {
        const event = { id: id(), circleId, actorId, type, targetId, at: this.now(), details };
        await tx.put('audit', event);
    }
    async createCircle(tx, p, actorId) {
        const type = oneOf(p.type, ['family', 'classmate'], '记录类型');
        const mode = oneOf(p.mode ?? 'private', ['private', 'shared'], '维护模式');
        const name = str(p.name, '圈名', 60);
        const school = type === 'classmate' ? str(p.school, '学校', 80) : undefined;
        const cohort = type === 'classmate' ? str(p.cohort, '届别', 40) : undefined;
        const className = type === 'classmate' ? str(p.className, '班级', 40) : undefined;
        const requestId = createRequestId(p.requestId);
        const createPayloadHash = requestId ? hash(JSON.stringify([type, name, mode, school, cohort, className])) : undefined;
        const circleId = requestId ? stableCreateId('circle.create', actorId, requestId) : id();
        if (requestId) {
            const existing = await tx.get('circles', circleId);
            if (existing) {
                if (existing.createdBy !== actorId || existing.createPayloadHash !== createPayloadHash)
                    fail('IDEMPOTENCY_CONFLICT', '该创建请求已用于其他记录');
                const member = await tx.get('members', memberId(circleId, actorId));
                if (!member || member.status !== 'active')
                    fail('FORBIDDEN', '你已不在这份记录');
                const memberCount = (await tx.find('members', { circleId, status: 'active' })).length;
                const personCount = (await tx.find('persons', { circleId })).length;
                return { circle: { ...safeCircle(existing), role: member.role, memberCount, personCount } };
            }
        }
        const activeMemberships = await tx.find('members', { userId: actorId, status: 'active' });
        if (activeMemberships.length >= maxBulkTransactionWrites)
            fail('DATA_LIMIT', '已加入的记录达到当前上限');
        const now = this.now();
        const circle = { id: circleId, type, name, mode, ownerId: actorId, createdBy: actorId, createdAt: now, updatedAt: now, createPayloadHash };
        if (type === 'classmate') {
            circle.school = school;
            circle.cohort = cohort;
            circle.className = className;
        }
        const member = { id: memberId(circle.id, actorId), circleId: circle.id, userId: actorId, name: '创建者', role: 'owner', status: 'active', joinedAt: now };
        await tx.put('circles', circle);
        await tx.put('members', member);
        await this.audit(tx, circle.id, actorId, 'circle.create', circle.id);
        return { circle: { ...safeCircle(circle), role: 'owner', memberCount: 1, personCount: 0 } };
    }
    async listCircles(tx, actorId) {
        const memberships = await tx.find('members', { userId: actorId, status: 'active' });
        if (memberships.length > maxBulkTransactionWrites)
            fail('DATA_LIMIT', '加入的记录过多，暂无法一次性列出');
        const circles = [];
        for (const member of memberships) {
            const circle = await tx.get('circles', member.circleId);
            if (!circle)
                continue;
            const count = (await tx.find('members', { circleId: circle.id, status: 'active' })).length;
            const personCount = (await tx.find('persons', { circleId: circle.id })).length;
            circles.push({ ...safeCircle(circle), role: member.role, memberCount: count, personCount });
        }
        return { circles };
    }
    async detailCircle(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const memberCount = (await tx.find('members', { circleId: circle.id, status: 'active' })).length;
        const personCount = (await tx.find('persons', { circleId: circle.id })).length;
        const ownerTransfer = await this.visibleOwnerTransfer(tx, circle, member);
        return { circle: { ...safeCircle(circle), role: member.role, memberCount, personCount }, role: member.role, ownerTransfer };
    }
    async upgradeCircle(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'owner');
        if (p.privacyReviewed !== true)
            fail('PRIVACY_REVIEW_REQUIRED', '请先确认历史资料适合供新成员查看');
        circle.mode = 'shared';
        circle.updatedAt = this.now();
        await tx.put('circles', circle);
        await this.audit(tx, circle.id, actorId, 'circle.upgrade', circle.id);
        return { circle: safeCircle(circle) };
    }
    async visibleOwnerTransfer(tx, circle, member) {
        const transfer = circle.ownerTransfer;
        if (!transfer || this.now() >= transfer.expiresAt)
            return null;
        const isOwner = member.userId === circle.ownerId && member.role === 'owner';
        const isTarget = member.id === transfer.targetMemberId;
        if (!isOwner && !isTarget)
            return null;
        const target = await tx.get('members', transfer.targetMemberId);
        if (!target || target.circleId !== circle.id || target.status !== 'active' || target.joinedAt !== transfer.targetJoinedAt)
            return null;
        const storedPerson = target.personId ? await tx.get('persons', target.personId) : undefined;
        // Keep the recipient's name consistent with the member picker. Account
        // profile updates need not rewrite each record's original person row.
        const person = storedPerson?.circleId === circle.id && storedPerson.claimedBy === target.userId
            ? await this.hydratedPerson(tx, storedPerson) : undefined;
        return {
            id: transfer.id, targetMemberId: transfer.targetMemberId,
            targetName: person?.circleId === circle.id ? person.name : target?.name || '成员',
            expiresAt: transfer.expiresAt, isTarget, isOwner
        };
    }
    async transferOwner(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId, 'owner');
        if (circle.ownerId !== actorId)
            fail('FORBIDDEN', '只有当前创建者可以发起移交');
        const target = await tx.get('members', str(p.memberId, 'memberId'));
        if (!target || target.circleId !== circle.id || target.status !== 'active' || target.id === member.id)
            fail('INVALID_INPUT', '请选择这份记录中的其他成员');
        const now = this.now();
        if (circle.ownerTransfer && now < circle.ownerTransfer.expiresAt) {
            const priorTarget = await tx.get('members', circle.ownerTransfer.targetMemberId);
            if (priorTarget?.circleId === circle.id && priorTarget.status === 'active' && priorTarget.joinedAt === circle.ownerTransfer.targetJoinedAt) {
                fail('TRANSFER_PENDING', '已有待接收的创建者移交，请先取消或等待过期');
            }
        }
        circle.ownerTransfer = { id: id(), targetMemberId: target.id, targetJoinedAt: target.joinedAt, createdAt: now, expiresAt: now + ownerTransferLifetime };
        circle.updatedAt = now;
        await tx.put('circles', circle);
        await this.audit(tx, circle.id, actorId, 'circle.transferRequested', target.id, { transferId: circle.ownerTransfer.id, expiresAt: circle.ownerTransfer.expiresAt });
        return { ownerTransfer: await this.visibleOwnerTransfer(tx, circle, member) };
    }
    async acceptOwnerTransfer(tx, p, actorId) {
        const { circle, member: target } = await this.access(tx, p.circleId, actorId);
        const transferId = str(p.transferId, 'transferId');
        const transfer = circle.ownerTransfer;
        if (!transfer || transfer.id !== transferId)
            fail('STALE_TRANSFER', '这次创建者移交已失效，请刷新后重试');
        if (target.id !== transfer.targetMemberId)
            fail('FORBIDDEN', '只有被邀请的成员可以接收管理权');
        if (target.joinedAt !== transfer.targetJoinedAt)
            fail('STALE_TRANSFER', '接收成员资格已变化，请原创建者重新发起');
        if (this.now() >= transfer.expiresAt)
            fail('TRANSFER_EXPIRED', '创建者移交已过期，请原创建者重新发起');
        const oldOwner = await tx.get('members', memberId(circle.id, circle.ownerId));
        if (!oldOwner || oldOwner.status !== 'active' || oldOwner.role !== 'owner' || oldOwner.id === target.id)
            fail('DATA_INTEGRITY', '当前创建者状态异常，请刷新后重试');
        oldOwner.role = 'admin';
        target.role = 'owner';
        circle.ownerId = target.userId;
        circle.ownerTransfer = undefined;
        circle.updatedAt = this.now();
        await tx.put('members', oldOwner);
        await tx.put('members', target);
        await tx.put('circles', circle);
        await this.audit(tx, circle.id, actorId, 'circle.transferAccepted', target.id, { transferId });
        return { circle: safeCircle(circle), member: this.safeMember(target, actorId) };
    }
    async cancelOwnerTransfer(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const transferId = str(p.transferId, 'transferId');
        const transfer = circle.ownerTransfer;
        if (!transfer || transfer.id !== transferId)
            fail('STALE_TRANSFER', '这次创建者移交已失效，请刷新后重试');
        const isOwner = member.userId === circle.ownerId && member.role === 'owner';
        const isTarget = member.id === transfer.targetMemberId;
        if (!isOwner && !isTarget)
            fail('FORBIDDEN', '只有原创建者或接收成员可以取消移交');
        circle.ownerTransfer = undefined;
        circle.updatedAt = this.now();
        await tx.put('circles', circle);
        await this.audit(tx, circle.id, actorId, isOwner ? 'circle.transferCancelled' : 'circle.transferRejected', transfer.targetMemberId, { transferId });
        return { transferId, status: isOwner ? 'cancelled' : 'rejected' };
    }
    visiblePerson(person, actorId) {
        const own = person.claimedBy === actorId;
        const result = {
            id: person.id, circleId: person.circleId, name: person.name,
            nickname: person.nickname, gender: person.gender, birthOrder: person.birthOrder,
            birthday: person.birthday,
            profileComplete: profileComplete(person),
            hasMapLocation: Boolean(person.city && Number.isFinite(person.latitude) && Number.isFinite(person.longitude)),
            isSelf: own, isClaimed: Boolean(person.claimedBy),
            hasPhoto: false,
            createdAt: person.createdAt, updatedAt: person.updatedAt,
            lastConfirmedAt: person.lastConfirmedAt
        };
        for (const field of privateFields) {
            if (person[field] === undefined)
                continue;
            // All active members of this private circle can see member cards. Raw
            // cloud file IDs remain hidden; photo.url performs a fresh member check.
            if (field === 'photoFileId')
                result.hasPhoto = true;
            else
                result[field] = person[field];
        }
        return result;
    }
    async listPeople(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        const rows = await tx.find('persons', { circleId: circle.id });
        const persons = (await this.peopleForRead(tx, rows)).map(person => this.visiblePerson(person, actorId));
        return { persons };
    }
    async getPerson(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const person = await this.person(tx, circle.id, p.personId);
        const current = await this.hydratedPerson(tx, person);
        const view = this.visiblePerson(current, actorId);
        if (person.claimedBy === actorId) {
            view.delegations = (await tx.find('delegations', { circleId: circle.id, personId: person.id })).filter(d => !d.revokedAt).map(d => ({ id: d.id, adminMemberId: memberId(circle.id, d.adminUserId), fields: d.fields, createdAt: d.createdAt }));
        }
        else if (rank(member.role) >= 2) {
            const delegation = await tx.get('delegations', `${person.id}_${hash(actorId).slice(0, 40)}`);
            if (delegation && !delegation.revokedAt && delegation.ownerUserId === person.claimedBy) {
                const fields = effectiveDelegationFields(delegation.fields);
                view.myDelegatedFields = fields;
                for (const field of fields)
                    if (privateFields.includes(field) && current[field] !== undefined) {
                        if (field === 'photoFileId')
                            view.hasPhoto = true;
                        else
                            view[field] = current[field];
                    }
            }
        }
        return { person: view };
    }
    async listPersonRemarks(tx, p, actorId) {
        if (Object.keys(p).some(key => key !== 'circleId'))
            fail('INVALID_INPUT', '备注字段不支持');
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        // Query once per collection, rather than spending one transaction read per
        // person. The membership and person generations also invalidate old notes.
        const rows = await tx.find('personRemarks', { circleId: circle.id, userId: actorId, memberJoinedAt: member.joinedAt });
        const people = new Map((await tx.find('persons', { circleId: circle.id })).map(person => [person.id, person]));
        const remarks = {};
        for (const row of rows) {
            const person = people.get(row.personId);
            if (person && row.personCreatedAt === person.createdAt && row.remark)
                remarks[person.id] = row.remark;
        }
        return { remarks };
    }
    async personRemark(tx, p, actorId, update) {
        // Identity is derived only from the trusted caller, including for admins.
        const allowed = update ? ['circleId', 'personId', 'remark'] : ['circleId', 'personId'];
        if (Object.keys(p).some(key => !allowed.includes(key)))
            fail('INVALID_INPUT', '备注字段不支持');
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const person = await this.person(tx, circle.id, p.personId);
        const remarkId = personRemarkId(circle.id, person.id, actorId);
        if (!update) {
            const row = await tx.get('personRemarks', remarkId);
            const current = row?.userId === actorId && row.circleId === circle.id && row.personId === person.id &&
                row.memberJoinedAt === member.joinedAt && row.personCreatedAt === person.createdAt;
            return { remark: current ? row.remark : '' };
        }
        if (typeof p.remark !== 'string' || p.remark.trim().length > 200)
            fail('INVALID_INPUT', '备注最多填写 200 字');
        const remark = p.remark.trim();
        if (remark) {
            await tx.put('personRemarks', { id: remarkId, circleId: circle.id, personId: person.id, userId: actorId,
                memberJoinedAt: member.joinedAt, personCreatedAt: person.createdAt, remark, updatedAt: this.now() });
        }
        else {
            const existing = await tx.get('personRemarks', remarkId);
            if (existing)
                await tx.delete('personRemarks', remarkId);
        }
        // Notes are deliberately excluded from administrator-visible audit logs.
        return { remark };
    }
    async getMatchPhone(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const person = await this.person(tx, circle.id, p.personId);
        return { matchPhone: person.claimedBy ? undefined : person.matchPhone };
    }
    async clearMatchPhone(tx, person) {
        if (!person.matchPhone)
            return;
        const matchId = phoneMatchId(person.circleId, person.matchPhone);
        const match = await tx.get('phoneMatches', matchId);
        if (match?.personId === person.id)
            await tx.delete('phoneMatches', matchId);
        person.matchPhone = undefined;
    }
    async requireMatchingPhone(tx, person, userId) {
        if (!person.matchPhone)
            return;
        const identity = await tx.get('phoneIdentities', phoneIdentityId(userId));
        if (!identity || identity.userId !== userId || identity.phone !== person.matchPhone ||
            this.now() >= identity.verifiedAt + phoneIdentityLifetime) {
            fail('PHONE_MISMATCH', '这张资料的核对手机号与申请人已验证手机号不一致，请先更正手机号或选择其他人');
        }
    }
    async upcomingBirthdays(tx, p, actorId) {
        let circles;
        if (p.circleId !== undefined)
            circles = [(await this.access(tx, p.circleId, actorId)).circle];
        else {
            const memberships = await tx.find('members', { userId: actorId, status: 'active' });
            // CloudBase collection queries are outside the transaction. Re-read
            // deterministic membership IDs so a concurrent removal cannot leave a
            // stale query row authorized for this request.
            if (memberships.length > 40)
                fail('DATA_LIMIT', '加入的记录过多，请按记录查看生日');
            const verified = await Promise.all(memberships.map(async (member) => {
                const current = await tx.get('members', member.id);
                if (!current || current.userId !== actorId || current.status !== 'active' || current.circleId !== member.circleId)
                    return undefined;
                return tx.get('circles', current.circleId);
            }));
            circles = verified.filter((circle) => Boolean(circle));
        }
        const days = p.days === undefined ? 30 : p.days;
        if (!Number.isInteger(days) || Number(days) < 0 || Number(days) > 366)
            fail('INVALID_INPUT', '生日查询范围须为 0 至 366 天');
        const candidates = (await Promise.all(circles.map(async (circle) => ({ circle, persons: await tx.find('persons', { circleId: circle.id }) }))))
            .flatMap(({ circle, persons }) => persons.filter(person => person.claimedBy !== actorId).map(person => ({ circle, person })))
            .sort((a, b) => a.circle.name.localeCompare(b.circle.name, 'zh-CN') || a.person.id.localeCompare(b.person.id));
        const seenOwners = new Set();
        const people = [];
        const currentPeople = new Map((await this.peopleForRead(tx, candidates.map(candidate => candidate.person))).map(person => [person.id, person]));
        for (const candidate of candidates) {
            const person = currentPeople.get(candidate.person.id);
            if (!person || person.claimedBy === actorId)
                continue;
            if (!profileComplete(person))
                continue;
            if (p.circleId === undefined && person.claimedBy) {
                if (seenOwners.has(person.claimedBy))
                    continue;
                seenOwners.add(person.claimedBy);
            }
            people.push({ circle: candidate.circle, person });
        }
        let calendar;
        try {
            calendar = new birthday_1.BirthdayCalendar(this.now(), Number(days), people.some(({ person }) => person.birthday?.calendar === 'lunar'));
        }
        catch {
            fail('LUNAR_CALENDAR_UNAVAILABLE', '当前服务暂不支持农历计算，请联系管理员');
        }
        const events = people.flatMap(({ circle, person }) => {
            const occurrence = calendar.next(person.birthday);
            return occurrence ? [{ personId: person.id, personName: person.name, circleId: circle.id,
                    circleName: circle.name, date: occurrence.date, daysUntil: occurrence.daysUntil,
                    birthdayCalendar: person.birthday.calendar, birthdayText: occurrence.birthdayText }] : [];
        }).sort((a, b) => a.daysUntil - b.daysUntil || a.circleName.localeCompare(b.circleName, 'zh-CN') || a.personName.localeCompare(b.personName, 'zh-CN'));
        return { events };
    }
    async createPerson(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        if (rank(member.role) < 2 && p.claimSelf !== true)
            fail('FORBIDDEN', '普通成员只能建立本人的人物卡');
        const requestId = createRequestId(p.requestId);
        const name = str(p.name, '姓名', 60);
        const nickname = optionalStr(p.nickname, '昵称', 60);
        const gender = p.gender !== undefined ? oneOf(p.gender, ['male', 'female', 'unknown'], '性别') : undefined;
        let birthOrder;
        if (p.birthOrder !== undefined) {
            if (!Number.isInteger(p.birthOrder) || Number(p.birthOrder) < 1 || Number(p.birthOrder) > 20)
                fail('INVALID_INPUT', '排行应为 1 至 20');
            birthOrder = Number(p.birthOrder);
        }
        const claimSelf = p.claimSelf === true;
        if (p.matchPhone !== undefined && (claimSelf || rank(member.role) < 2))
            fail('FORBIDDEN', '只有管理员可为未关联资料填写匹配手机号');
        const matchPhone = optionalMatchPhone(p.matchPhone);
        const initial = p.initialRelation === undefined ? undefined : parseInitialRelation(p.initialRelation);
        if (p.deferRelation !== undefined && typeof p.deferRelation !== 'boolean')
            fail('INVALID_INPUT', '请明确选择是否稍后补充关系');
        const deferRelation = p.deferRelation === true;
        if (deferRelation && initial)
            fail('INVALID_INPUT', '已选择关系时不能同时选择稍后补充');
        if (p.deferRelation !== undefined && circle.type !== 'family')
            fail('WRONG_CIRCLE_TYPE', '同窗录不需要设置亲属关系');
        if (initial && !claimSelf && rank(member.role) < 2)
            fail('FORBIDDEN', '只有管理员可在添加家人时建立关系');
        if (initial && circle.type !== 'family')
            fail('WRONG_CIRCLE_TYPE', '同窗录不能录入亲属关系');
        if (!p.country || !p.city || !p.birthday)
            fail('PROFILE_INCOMPLETE', '创建人物卡前请填完整国家或地区、城市和生日');
        const location = parseJoinProfile({ country: p.country, province: p.province, city: p.city,
            latitude: p.latitude, longitude: p.longitude, birthday: p.birthday });
        const birthday = location.birthday;
        const createFingerprint = [name, nickname, gender, birthOrder, claimSelf, location, birthday, matchPhone];
        if (initial)
            createFingerprint.push([initial.anchorPersonId, initial.kind, initial.older]);
        if (deferRelation)
            createFingerprint.push({ deferRelation: true });
        const createPayloadHash = requestId ? hash(JSON.stringify(createFingerprint)) : undefined;
        const personId = requestId ? stableCreateId(`person.create:${circle.id}`, actorId, requestId) : id();
        if (requestId) {
            const existing = await tx.get('persons', personId);
            if (existing) {
                if (existing.circleId !== circle.id || existing.createPayloadHash !== createPayloadHash)
                    fail('IDEMPOTENCY_CONFLICT', '该创建请求已用于其他人物卡内容');
                if (claimSelf && (existing.claimedBy !== actorId || member.personId !== existing.id))
                    fail('IDEMPOTENCY_STATE_CHANGED', '这张人物卡已解除认领，请重新申请认领');
                return { person: this.visiblePerson(await this.hydratedPerson(tx, existing), actorId) };
            }
        }
        if (circle.type === 'family' && !initial && !deferRelation && (await tx.find('persons', { circleId: circle.id })).length > 0) {
            fail('RELATION_REQUIRED', '请先选择这位家人与已有家人的关系');
        }
        const now = this.now();
        const person = { id: personId, circleId: circle.id, name, nickname, gender, birthOrder, birthday,
            country: location.country, province: location.province, city: location.city, latitude: location.latitude, longitude: location.longitude,
            visibility: {}, relationCount: 0, createdAt: now, updatedAt: now, createPayloadHash };
        if (matchPhone) {
            const matchId = phoneMatchId(circle.id, matchPhone);
            const existingMatch = await tx.get('phoneMatches', matchId);
            if (existingMatch)
                fail('PHONE_ALREADY_USED', '这份记录已有资料使用这个匹配手机号');
            person.matchPhone = matchPhone;
            const phoneMatch = { id: matchId, circleId: circle.id, personId: person.id, phone: matchPhone, createdAt: now };
            await tx.put('phoneMatches', phoneMatch);
        }
        if (claimSelf) {
            if (member.personId)
                fail('ALREADY_CLAIMED', '你已经认领一张人物卡');
            const pendingClaims = await tx.find('claimRequests', { circleId: circle.id, userId: actorId, status: 'pending' });
            if (pendingClaims.length)
                fail('CLAIM_PENDING', '认领申请仍在审核中，请先等待审核结果');
            person.claimedBy = actorId;
            member.personId = person.id;
            await tx.put('members', member);
            await this.ensureProfileForPerson(tx, person, actorId);
        }
        await tx.put('persons', person);
        if (initial)
            await this.createInitialRelation(tx, circle, actorId, person.id, initial, 'person.create');
        await this.audit(tx, circle.id, actorId, 'person.create', person.id);
        return { person: this.visiblePerson(await this.hydratedPerson(tx, (await tx.get('persons', person.id)) || person), actorId) };
    }
    async createInitialRelation(tx, circle, actorId, newPersonId, initial, source) {
        const from = initial.kind === 'newChild' ? initial.anchorPersonId : newPersonId;
        const to = initial.kind === 'newChild' ? newPersonId : initial.anchorPersonId;
        const type = initial.kind === 'newParent' || initial.kind === 'newChild' ? 'parent' : initial.kind;
        const olderId = initial.kind === 'sibling' && initial.older !== 'unknown'
            ? initial.older === 'new' ? newPersonId : initial.anchorPersonId : undefined;
        const change = await this.parseRelationChange(tx, circle, { relation: { from, to, type, ...(olderId ? { olderId } : {}) } });
        const linked = await this.applyRelationChange(tx, circle, change, actorId);
        await this.audit(tx, circle.id, actorId, 'relation.create', linked.after.id, { created: linked.after, source });
    }
    parsePatch(raw) {
        const input = object(raw);
        const patch = {};
        for (const [key, value] of Object.entries(input)) {
            if (!profileFields.includes(key))
                fail('INVALID_INPUT', `不能修改字段 ${key}`);
            if (value === null || value === '') {
                if (key === 'name')
                    fail('INVALID_INPUT', '姓名不能为空');
                patch[key] = undefined;
                continue;
            }
            if (key === 'birthday')
                patch[key] = parseBirthday(value, true);
            else if (key === 'gender')
                patch[key] = oneOf(value, ['male', 'female', 'unknown'], '性别');
            else if (key === 'birthOrder') {
                if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20)
                    fail('INVALID_INPUT', '排行应为 1 至 20');
                patch[key] = Number(value);
            }
            else if (key === 'latitude' || key === 'longitude') {
                const limit = key === 'latitude' ? 90 : 180;
                if (typeof value !== 'number' || !Number.isFinite(value) || value < -limit || value > limit)
                    fail('INVALID_INPUT', `${key}须为有效坐标`);
                // Keep only a city-scale representative point, not a precise pin.
                patch[key] = Math.round(value * 10) / 10;
            }
            else
                patch[key] = str(value, key, key === 'bio' ? 500 : key === 'phone' ? 30 : key === 'photoFileId' ? 512 : 120);
        }
        return patch;
    }
    async updatePerson(tx, p, actorId, internalPhotoBinding = false) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const storedPerson = await this.person(tx, circle.id, p.personId);
        const person = await this.hydratedPerson(tx, storedPerson);
        const patch = this.parsePatch(p.patch);
        const matchPhoneTouched = Object.prototype.hasOwnProperty.call(p, 'matchPhone');
        if (matchPhoneTouched && (internalPhotoBinding || rank(member.role) < 2 || person.claimedBy)) {
            fail('FORBIDDEN', '只有管理员可修改尚未关联资料的匹配手机号');
        }
        const nextMatchPhone = matchPhoneTouched ? optionalMatchPhone(p.matchPhone) : person.matchPhone;
        if (patch.photoFileId !== undefined && !internalPhotoBinding)
            fail('FORBIDDEN', '请通过照片上传功能更换照片');
        const latitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'latitude');
        const longitudeTouched = Object.prototype.hasOwnProperty.call(patch, 'longitude');
        if (latitudeTouched !== longitudeTouched ||
            (latitudeTouched && ((patch.latitude === undefined) !== (patch.longitude === undefined)))) {
            fail('INVALID_INPUT', '城市坐标须同时填写或同时清除');
        }
        const allowedPhoto = /^cloud:\/\/[^/]+\/photos\/([0-9a-f]{40})\/([0-9a-f-]{36}\.jpg)$/;
        const photoMatch = patch.photoFileId === undefined ? undefined : allowedPhoto.exec(patch.photoFileId);
        if (patch.photoFileId !== undefined && (!photoMatch || photoMatch[1] !== photoOwnerPath(circle.id, actorId))) {
            fail('INVALID_INPUT', '照片文件不在你的上传目录');
        }
        const own = person.claimedBy === actorId;
        if (!own && rank(member.role) < 2)
            fail('FORBIDDEN', '只有本人或管理员可以修改资料');
        // Old clients may still send visibility, but the former per-field setting
        // is ignored. Circle membership is the only audience boundary.
        const wasComplete = profileComplete(person);
        const locationNameChanged = (Object.prototype.hasOwnProperty.call(patch, 'city') && patch.city !== person.city) ||
            (Object.prototype.hasOwnProperty.call(patch, 'country') && patch.country !== person.country) ||
            (Object.prototype.hasOwnProperty.call(patch, 'province') && patch.province !== person.province);
        Object.assign(person, patch);
        if (wasComplete && !profileComplete(person))
            fail('PROFILE_INCOMPLETE', '已加入关系网的资料须保留姓名、国家或地区、城市和生日');
        if (nextMatchPhone && !profileComplete(person))
            fail('PROFILE_INCOMPLETE', '请先补齐城市和生日，再填写匹配手机号');
        if (latitudeTouched && patch.latitude !== undefined && !person.city) {
            fail('INVALID_INPUT', '请先填写城市再确认城市中心点');
        }
        if (!person.city || (locationNameChanged && !latitudeTouched)) {
            person.latitude = undefined;
            person.longitude = undefined;
        }
        if ((person.latitude === undefined) !== (person.longitude === undefined) ||
            (person.latitude !== undefined && !person.city))
            fail('INVALID_INPUT', '请先填写城市再确认城市中心点');
        if (matchPhoneTouched) {
            const previous = person.matchPhone;
            if (nextMatchPhone) {
                const nextId = phoneMatchId(circle.id, nextMatchPhone);
                const existing = await tx.get('phoneMatches', nextId);
                if (existing && existing.personId !== person.id)
                    fail('PHONE_ALREADY_USED', '这份记录已有资料使用这个匹配手机号');
                if (!existing)
                    await tx.put('phoneMatches', { id: nextId, circleId: circle.id,
                        personId: person.id, phone: nextMatchPhone, createdAt: this.now() });
            }
            if (previous && previous !== nextMatchPhone)
                await this.clearMatchPhone(tx, person);
            person.matchPhone = nextMatchPhone;
        }
        person.updatedAt = this.nextPersonUpdatedAt(person);
        if (own)
            person.lastConfirmedAt = this.now();
        const changedShared = Object.keys(patch).filter(key => sharedProfileFields.includes(key));
        if (locationNameChanged && !latitudeTouched)
            changedShared.push('latitude', 'longitude');
        if (person.claimedBy && changedShared.length) {
            const profile = await this.ensureEmptyProfile(tx, person.claimedBy);
            if (own) {
                for (const field of changedShared) {
                    profile[field] = person[field];
                    if (person.profileOverrides)
                        delete person.profileOverrides[field];
                }
                if (locationNameChanged && person.profileOverrides) {
                    for (const field of locationFields)
                        delete person.profileOverrides[field];
                }
                this.touchProfileFields(profile, changedShared);
                profile.updatedAt = this.now();
                await tx.put('userProfiles', profile);
            }
            else {
                person.profileOverrides = { ...storedPerson.profileOverrides };
                for (const field of changedShared) {
                    person.profileOverrides[field] = { baseRevision: this.profileFieldRevision(profile, field), value: person[field] ?? null };
                }
                // A legacy claimed card may not have been migrated to the account
                // profile yet; establish its pre-correction baseline now.
                if (!(await this.storedProfile(tx, person.claimedBy)))
                    await tx.put('userProfiles', profile);
            }
        }
        await tx.put('persons', person);
        await this.audit(tx, circle.id, actorId, own ? 'person.update' : 'person.maintain', person.id, { fields: [...Object.keys(patch), ...(matchPhoneTouched ? ['matchPhone'] : [])] });
        return { person: this.visiblePerson(person, actorId) };
    }
    async photoUploadPath(tx, p, actorId) {
        if (p.circleId === undefined && p.personId === undefined) {
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorId))
                fail('INVALID_IDENTITY', '微信身份格式不支持照片上传');
            return { cloudPath: `photos/${photoOwnerPath('account', actorId)}/${id()}.jpg`, isSelf: true, accountProfile: true };
        }
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const person = await this.person(tx, circle.id, p.personId);
        if (person.claimedBy !== actorId && rank(member.role) < 2)
            fail('FORBIDDEN', '只有本人或管理员可以修改照片');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorId))
            fail('INVALID_IDENTITY', '微信身份格式不支持照片上传');
        return { cloudPath: `photos/${photoOwnerPath(circle.id, actorId)}/${id()}.jpg`, isSelf: person.claimedBy === actorId };
    }
    async mayViewPhoto(tx, person, member, actorId) {
        void tx;
        void member;
        void actorId;
        // The caller has already passed access() for this circle. A photo has one
        // circle-level audience; old per-field flags are ignored on read.
        return Boolean(person.photoFileId);
    }
    async authorizedPhotoFileId(tx, p, actorId) {
        if (p.circleId === undefined && p.personId === undefined) {
            const profile = await this.ownProfile(tx, actorId);
            if (!profile?.photoFileId)
                fail('FORBIDDEN', '尚未上传照片');
            return profile.photoFileId;
        }
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const person = await this.hydratedPerson(tx, await this.person(tx, circle.id, p.personId));
        if (!person.photoFileId || !(await this.mayViewPhoto(tx, person, member, actorId)))
            fail('FORBIDDEN', '照片未开放查看');
        return person.photoFileId;
    }
    async signedPhotoUrl(p, actorId) {
        if (!this.signPhoto)
            fail('NOT_CONFIGURED', '当前未配置云存储');
        // Finish the authorization transaction before contacting cloud storage.
        const fileId = await this.repo.atomic(tx => this.authorizedPhotoFileId(tx, p, actorId));
        const url = await this.signPhoto(fileId);
        return { url };
    }
    async signedPhotoUrls(p, actorId) {
        if (!Array.isArray(p.personIds) || p.personIds.length < 1 || p.personIds.length > 20)
            fail('INVALID_INPUT', '每次最多获取 20 人的照片');
        const personIds = [...new Set(p.personIds.map(personId => str(personId, 'personId')))];
        const files = await this.repo.atomic(async (tx) => {
            const { circle, member } = await this.access(tx, p.circleId, actorId);
            const eligible = [];
            for (const personId of personIds) {
                const stored = await tx.get('persons', personId);
                const person = stored?.circleId === circle.id ? await this.hydratedPerson(tx, stored) : undefined;
                if (person?.photoFileId && await this.mayViewPhoto(tx, person, member, actorId)) {
                    eligible.push({ personId, fileId: person.photoFileId });
                }
            }
            return eligible;
        });
        if (!files.length)
            return { urls: {} };
        if (!this.signPhotos && !this.signPhoto)
            fail('NOT_CONFIGURED', '当前未配置云存储');
        const signed = this.signPhotos
            ? await this.signPhotos([...new Set(files.map(file => file.fileId))])
            : Object.fromEntries(await Promise.all(files.map(async (file) => [file.fileId, await this.signPhoto(file.fileId)])));
        const urls = {};
        for (const file of files)
            if (typeof signed[file.fileId] === 'string')
                urls[file.personId] = signed[file.fileId];
        return { urls };
    }
    async deletePerson(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const person = await this.person(tx, circle.id, p.personId);
        if (person.claimedBy)
            fail('CLAIMED_PERSON', '这位成员正在使用资料，不能直接删除');
        if ((person.relationCount ?? 0) > 0)
            fail('RELATION_CONNECTED', `该人物关联 ${person.relationCount} 条关系，请先处理关系`);
        // Legacy counts may be stale. Never delete a node still referenced by a
        // real edge even when its denormalized relationCount says zero.
        const actualRelations = await tx.find('relations', { circleId: circle.id });
        if (actualRelations.some(relation => relation.from === person.id || relation.to === person.id))
            fail('RELATION_CONNECTED', '该人物仍有关联关系，请先处理关系');
        const pendingClaims = await tx.find('claimRequests', { circleId: circle.id, personId: person.id, status: 'pending' });
        // Each candidate needs a fresh read and a write; reserve room for access,
        // the person, phone-match cleanup and audit in the 100-operation limit.
        if (pendingClaims.length > maxBulkTransactionWrites / 2)
            fail('DATA_LIMIT', '待审关联申请过多，请先处理申请后再删除人物');
        let cancelledClaimCount = 0;
        for (const candidate of pendingClaims) {
            const claim = await tx.get('claimRequests', candidate.id);
            if (!claim || claim.circleId !== circle.id || claim.personId !== person.id || claim.status !== 'pending')
                continue;
            claim.status = 'rejected';
            claim.reviewedAt = this.now();
            claim.reviewedBy = actorId;
            await tx.put('claimRequests', claim);
            cancelledClaimCount++;
        }
        await this.clearMatchPhone(tx, person);
        await tx.delete('persons', person.id);
        await this.audit(tx, circle.id, actorId, 'person.delete', person.id, { cancelledClaimCount });
        return { personId: person.id };
    }
    async claimPerson(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const person = await this.person(tx, circle.id, p.personId);
        if (member.personId)
            fail('ALREADY_CLAIMED', '你已认领一张人物卡');
        if (person.claimedBy)
            fail('ALREADY_CLAIMED', '这张人物卡已被认领');
        // Even administrators need approval for a card created by somebody else.
        // The creator can link their own freshly created card via claimSelf.
        const request = {
            id: claimRequestId(circle.id, person.id, actorId), circleId: circle.id,
            personId: person.id, userId: actorId, status: 'pending', createdAt: this.now()
        };
        const existing = await tx.get('claimRequests', request.id);
        if (existing?.status === 'pending')
            return { claimRequest: this.safeClaim(existing) };
        const pendingClaims = await tx.find('claimRequests', { circleId: circle.id, userId: actorId, status: 'pending' });
        if (pendingClaims.length)
            fail('CLAIM_PENDING', '已有其他人物卡认领申请正在审核');
        // Creation of a pending claim and creation of a claimed self card both
        // write the member document, preventing a cross-action race in CloudBase.
        await tx.put('members', member);
        // Serialize against deleting this unclaimed person, so a concurrent new
        // request cannot survive the deletion's pending-application cleanup.
        await tx.put('persons', person);
        await tx.put('claimRequests', request);
        await this.audit(tx, circle.id, actorId, 'person.claimRequest', person.id);
        return { claimRequest: this.safeClaim(request) };
    }
    safeClaim(request) {
        const { id, circleId, personId, status, createdAt, reviewedAt } = request;
        return { id, circleId, personId, status, createdAt, reviewedAt };
    }
    async listClaims(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const requests = await tx.find('claimRequests', { circleId: circle.id, status: 'pending' });
        const members = new Map((await tx.find('members', { circleId: circle.id })).map(member => [member.id, member]));
        const claimRequests = requests.map(r => ({
            ...this.safeClaim(r), memberId: memberId(circle.id, r.userId),
            applicantName: members.get(memberId(circle.id, r.userId))?.name || '申请人'
        }));
        return { claimRequests };
    }
    async myClaims(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        const requests = await tx.find('claimRequests', { circleId: circle.id, userId: actorId });
        const persons = new Map((await tx.find('persons', { circleId: circle.id })).map(person => [person.id, person]));
        const claimRequests = requests.map(request => ({
            ...this.safeClaim(request), personName: persons.get(request.personId)?.name || '人物卡已删除'
        }));
        return { claimRequests: claimRequests.sort((a, b) => b.createdAt - a.createdAt) };
    }
    async resolveClaim(tx, p, actorId, approve) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const request = await tx.get('claimRequests', str(p.claimRequestId, 'claimRequestId'));
        if (!request || request.circleId !== circle.id)
            fail('NOT_FOUND', '认领申请不存在');
        if (request.status !== 'pending')
            fail('ALREADY_REVIEWED', '认领申请已处理');
        if (approve && request.userId === actorId)
            fail('FORBIDDEN', '不能审核自己的资料关联申请');
        if (approve) {
            const person = await this.person(tx, circle.id, request.personId);
            const member = await this.member(tx, circle.id, request.userId);
            if (person.claimedBy || member.personId)
                fail('ALREADY_CLAIMED', '人物卡或成员已被认领');
            await this.requireMatchingPhone(tx, person, request.userId);
            await this.clearMatchPhone(tx, person);
            person.claimedBy = request.userId;
            person.lastConfirmedAt = this.now();
            person.updatedAt = this.nextPersonUpdatedAt(person);
            await this.ensureEmptyProfile(tx, request.userId);
            member.personId = person.id;
            await tx.put('persons', person);
            await tx.put('members', member);
        }
        request.status = approve ? 'approved' : 'rejected';
        request.reviewedAt = this.now();
        request.reviewedBy = actorId;
        await tx.put('claimRequests', request);
        await this.audit(tx, circle.id, actorId, approve ? 'person.claimApprove' : 'person.claimReject', request.personId);
        return { claimRequest: this.safeClaim(request) };
    }
    async unclaimPerson(tx, p, actorId) {
        const { circle, member: actor } = await this.access(tx, p.circleId, actorId, 'admin');
        const person = await this.person(tx, circle.id, p.personId);
        if (!person.claimedBy)
            fail('INVALID_INPUT', '人物卡尚未认领');
        const targetMember = await tx.get('members', memberId(circle.id, person.claimedBy));
        if (person.claimedBy === actorId || !targetMember || targetMember.status !== 'active' ||
            targetMember.personId !== person.id || rank(actor.role) <= rank(targetMember.role)) {
            fail('FORBIDDEN', '只能解除下级成员与资料的关联');
        }
        const reasonCode = p.reasonCode === undefined ? undefined : oneOf(p.reasonCode, ['wrong_person', 'member_request', 'duplicate_card', 'other'], '解绑原因');
        const oldOwner = person.claimedBy;
        const delegations = await tx.find('delegations', { circleId: circle.id, personId: person.id });
        const activeDelegations = delegations.filter(delegation => !delegation.revokedAt);
        if (activeDelegations.length > maxBulkTransactionWrites)
            fail('DATA_LIMIT', '授权记录过多，无法一次性安全解绑');
        const oldMemberId = memberId(circle.id, oldOwner);
        const clearedFields = privateFields.filter(field => person[field] !== undefined);
        const member = await tx.get('members', memberId(circle.id, oldOwner));
        if (member?.status === 'active' && member.personId === person.id) {
            member.personId = undefined;
            await tx.put('members', member);
        }
        person.claimedBy = undefined;
        person.profileOverrides = undefined;
        await this.clearMatchPhone(tx, person);
        for (const field of privateFields)
            person[field] = undefined;
        person.visibility = {};
        person.updatedAt = this.nextPersonUpdatedAt(person);
        await tx.put('persons', person);
        for (const delegation of activeDelegations) {
            delegation.revokedAt = this.now();
            await tx.put('delegations', delegation);
        }
        const revokedDelegationCount = activeDelegations.length;
        await this.audit(tx, circle.id, actorId, 'person.unclaim', person.id, { oldMemberId, clearedFields, revokedDelegationCount, reasonCode });
        return { person: this.visiblePerson(person, actorId) };
    }
    async listRelations(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        if (circle.type !== 'family')
            fail('WRONG_CIRCLE_TYPE', '同窗录没有亲属关系');
        const relations = await tx.find('relations', { circleId: circle.id });
        return { relations: relations.map(({ id, circleId, from, to, type, olderId, createdAt }) => ({ id, circleId, from, to, type, olderId, createdAt })) };
    }
    async createRelation(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        if (circle.type !== 'family')
            fail('WRONG_CIRCLE_TYPE', '同窗录不能录入亲属关系');
        const change = await this.parseRelationChange(tx, circle, { relation: p });
        const result = await this.applyRelationChange(tx, circle, change, actorId);
        await this.audit(tx, circle.id, actorId, 'relation.create', result.after.id, { created: result.after, reason: optionalStr(p.reason, '原因', 300) });
        return { relation: result.after, impact: result.impact };
    }
    async deleteRelation(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const change = await this.parseRelationChange(tx, circle, { removeRelationId: p.relationId });
        const result = await this.applyRelationChange(tx, circle, change, actorId);
        await this.audit(tx, circle.id, actorId, 'relation.delete', result.before.id, { removed: result.before, reason: optionalStr(p.reason, '原因', 300) });
        return { relationId: result.before.id, impact: result.impact };
    }
    async replaceRelation(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        if (circle.type !== 'family')
            fail('WRONG_CIRCLE_TYPE', '同窗录没有亲属关系');
        const change = await this.parseRelationChange(tx, circle, { removeRelationId: p.relationId, relation: p.relation });
        if (!change.relation)
            fail('INVALID_INPUT', '请填写替换后的关系');
        const result = await this.applyRelationChange(tx, circle, change, actorId);
        await this.audit(tx, circle.id, actorId, 'relation.replace', result.after.id, { removed: result.before, created: result.after, reason: optionalStr(p.reason, '原因', 300) });
        return { relation: result.after, impact: result.impact };
    }
    async previewRelation(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        if (circle.type !== 'family')
            fail('WRONG_CIRCLE_TYPE', '同窗录没有亲属关系');
        const change = await this.parseRelationChange(tx, circle, p.relationChange);
        const plan = await this.planRelationChange(tx, circle, change, actorId);
        return { impact: plan.impact, before: plan.before && relationSummary(plan.before), after: plan.after && relationSummary(plan.after) };
    }
    async parseRelationChange(tx, circle, raw) {
        const input = object(raw);
        const removeRelationId = input.removeRelationId === undefined ? undefined : str(input.removeRelationId, 'removeRelationId');
        let relation;
        if (input.relation !== undefined) {
            const proposed = object(input.relation);
            const from = (await this.person(tx, circle.id, proposed.from)).id;
            const to = (await this.person(tx, circle.id, proposed.to)).id;
            if (from === to)
                fail('INVALID_INPUT', '不能把人物关联到自己');
            const type = oneOf(proposed.type, relationTypes, '关系类型');
            let olderId;
            if (proposed.olderId !== undefined) {
                if (type !== 'sibling')
                    fail('INVALID_INPUT', '只有兄弟姐妹关系可记录长幼');
                olderId = str(proposed.olderId, 'olderId');
                if (olderId !== from && olderId !== to)
                    fail('INVALID_INPUT', '长者必须是关系中的一人');
            }
            relation = { from, to, type, olderId };
        }
        if (!removeRelationId && !relation)
            fail('INVALID_INPUT', '请填写需要新增或删除的关系');
        return { removeRelationId, relation };
    }
    async planRelationChange(tx, circle, change, actorId, expectedRelationHash) {
        const before = change.removeRelationId ? await tx.get('relations', change.removeRelationId) : undefined;
        if (change.removeRelationId && (!before || before.circleId !== circle.id))
            fail('NOT_FOUND', '要修改的关系不存在');
        if (before && expectedRelationHash && relationFingerprint(before) !== expectedRelationHash)
            fail('STALE_RELATION', '关系已被其他人修改，请重新提交建议');
        const after = change.relation ? {
            id: relationId(circle.id, change.relation.type, change.relation.from, change.relation.to),
            circleId: circle.id, ...change.relation, createdBy: actorId, createdAt: this.now()
        } : undefined;
        // A deterministic doc read keeps identical-edge races inside the CloudBase
        // transaction even though collection-wide graph scans use the SDK query API.
        const exactExisting = after ? await tx.get('relations', after.id) : undefined;
        if (exactExisting && exactExisting.id !== before?.id)
            fail('DUPLICATE_RELATION', '这条关系已存在');
        const relations = await tx.find('relations', { circleId: circle.id });
        const remaining = relations.filter(relation => relation.id !== before?.id);
        if (after && remaining.some(relation => relation.id === after.id))
            fail('DUPLICATE_RELATION', '这条关系已存在');
        // Removing an edge cannot create a new contradiction. Let admins clean up
        // older graphs that already contain more than one conflicting edge.
        if (after)
            validateFamilyGraph([...remaining, after]);
        const endpoints = [...new Set([before?.from, before?.to, after?.from, after?.to].filter((value) => Boolean(value)))];
        const affectedPersonIds = affectedComponentIds(relations, after, endpoints);
        const impact = {
            removedRelationIds: before ? [before.id] : [],
            createdRelationIds: after ? [after.id] : [],
            affectedPersonIds
        };
        return { before, after, impact };
    }
    async applyRelationChange(tx, circle, change, actorId, expectedRelationHash) {
        const plan = await this.planRelationChange(tx, circle, change, actorId, expectedRelationHash);
        const persons = new Map();
        const changedEndpoints = [...new Set([plan.before?.from, plan.before?.to, plan.after?.from, plan.after?.to].filter((value) => Boolean(value)))];
        for (const personId of changedEndpoints)
            persons.set(personId, await this.person(tx, circle.id, personId));
        for (const personId of [plan.before?.from, plan.before?.to])
            if (personId) {
                const person = persons.get(personId);
                if ((person.relationCount ?? 0) < 1)
                    fail('DATA_INTEGRITY', '关系计数不一致');
                person.relationCount = (person.relationCount ?? 0) - 1;
            }
        for (const personId of [plan.after?.from, plan.after?.to])
            if (personId) {
                const person = persons.get(personId);
                person.relationCount = (person.relationCount ?? 0) + 1;
            }
        for (const person of persons.values()) {
            person.updatedAt = this.nextPersonUpdatedAt(person);
            await tx.put('persons', person);
        }
        if (plan.before && plan.before.id !== plan.after?.id)
            await tx.delete('relations', plan.before.id);
        if (plan.after)
            await tx.put('relations', plan.after);
        // Mutate the circle document in the same transaction to serialize distinct
        // relation IDs whose combined graph would otherwise be inconsistent.
        circle.updatedAt = this.now();
        await tx.put('circles', circle);
        return { before: plan.before && relationSummary(plan.before), after: plan.after && relationSummary(plan.after), impact: plan.impact };
    }
    parseToken(tokenValue) {
        if (typeof tokenValue !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(tokenValue))
            fail('INVALID_INVITE', '邀请不存在或已失效');
        return { inviteId: hash(tokenValue), token: tokenValue };
    }
    async verifyInvite(tx, token) {
        const { inviteId, token: secret } = this.parseToken(token);
        const invite = await tx.get('invites', inviteId);
        if (!invite || !crypto.timingSafeEqual(Buffer.from(invite.tokenHash, 'hex'), Buffer.from(hash(secret), 'hex')))
            fail('INVALID_INVITE', '邀请不存在或已失效');
        return invite;
    }
    inviteStatus(invite) {
        if (invite.revokedAt)
            return 'revoked';
        if (invite.usedAt)
            return 'used';
        if (this.now() >= invite.expiresAt)
            return 'expired';
        return 'active';
    }
    requireActiveInvite(invite) {
        const status = this.inviteStatus(invite);
        if (status !== 'active')
            fail('INVITE_INACTIVE', status === 'expired' ? '邀请已过期' : status === 'revoked' ? '邀请已撤销' : '邀请已使用');
    }
    async createInvite(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        if (circle.mode !== 'shared')
            fail('PRIVATE_CIRCLE', '请先检查资料并开启邀请共建');
        // 24 random bytes encode to exactly 32 URL-safe characters, fitting wxacode scene.
        const secret = crypto.randomBytes(24).toString('base64url');
        const invite = { id: hash(secret), circleId: circle.id, tokenHash: hash(secret), createdBy: actorId, createdAt: this.now(), expiresAt: this.now() + inviteLifetime };
        await tx.put('invites', invite);
        await this.audit(tx, circle.id, actorId, 'invite.create', invite.id);
        return { invite: { id: invite.id, circleId: invite.circleId, token: secret, expiresAt: invite.expiresAt, status: 'active' } };
    }
    async previewInvite(tx, p) {
        const invite = await this.verifyInvite(tx, p.token);
        const circle = await this.circle(tx, invite.circleId);
        return { circle: safePublicCircle(circle), expiresAt: invite.expiresAt, status: this.inviteStatus(invite) };
    }
    async applyInvite(tx, p, actorId) {
        // The applicant cannot choose a card. Only the reviewing administrator may
        // explicitly select an existing unclaimed card after seeing the profile.
        if (p.claimPersonId !== undefined)
            fail('INVALID_INPUT', '请先加入这份记录，再由本人申请关联人物资料');
        const invite = await this.verifyInvite(tx, p.token);
        this.requireActiveInvite(invite);
        const circle = await this.circle(tx, invite.circleId);
        const existingMember = await tx.get('members', memberId(invite.circleId, actorId));
        if (existingMember?.status === 'active')
            fail('ALREADY_MEMBER', '你已经加入这份记录');
        const pending = await tx.get('applications', applicationId(invite.id, actorId));
        if (pending?.status === 'pending')
            return { application: this.safeApplication(pending) };
        if (pending?.status === 'rejected')
            fail('APPLICATION_REJECTED', '这次加入申请已被拒绝，请联系管理员获取新邀请');
        const pendingCount = (await tx.find('applications', { inviteId: invite.id, status: 'pending' })).length;
        if (pendingCount >= 20)
            fail('INVITE_FULL', '此邀请申请人数过多，请联系管理员重新邀请');
        const own = await this.ownProfile(tx, actorId);
        if (!own || !profileComplete(own))
            fail('PROFILE_INCOMPLETE', '请先在我的资料填写姓名、城市和生日');
        const profile = this.joinProfileFromAccount(own);
        const application = {
            id: applicationId(invite.id, actorId), circleId: invite.circleId, inviteId: invite.id, userId: actorId,
            name: str(own.name, '姓名', 60), note: circle.type === 'classmate' ? str(p.note, '同班核对说明', 300) : optionalStr(p.note, '说明', 300),
            profile, profileVersion: this.profileVersion(own),
            status: 'pending', createdAt: this.now()
        };
        await tx.put('applications', application);
        await this.audit(tx, invite.circleId, actorId, 'join.apply', application.id);
        return { application: this.safeApplication(application) };
    }
    safeApplication(application, includeIdentity = false) {
        const { id, circleId, inviteId, name, note, profile, status, createdAt, reviewedAt } = application;
        return { ...{ id, circleId, inviteId, name, note, profile, status, createdAt, reviewedAt }, ...(includeIdentity ? { memberId: memberId(circleId, application.userId) } : {}) };
    }
    async listInvites(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const invites = await tx.find('invites', { circleId: circle.id });
        return { invites: invites.map(i => ({ id: i.id, circleId: i.circleId, createdAt: i.createdAt, expiresAt: i.expiresAt, status: this.inviteStatus(i) })) };
    }
    async revokeInvite(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const invite = await tx.get('invites', str(p.inviteId, 'inviteId'));
        if (!invite || invite.circleId !== circle.id)
            fail('NOT_FOUND', '邀请不存在');
        if (!invite.revokedAt) {
            invite.revokedAt = this.now();
            await tx.put('invites', invite);
            await this.audit(tx, circle.id, actorId, 'invite.revoke', invite.id);
        }
        return { invite: { id: invite.id, status: this.inviteStatus(invite) } };
    }
    async listApplications(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const applications = await tx.find('applications', { circleId: circle.id, status: 'pending' });
        const invites = new Map((await tx.find('invites', { circleId: circle.id })).map(invite => [invite.id, invite]));
        const profiles = await this.profilesByUser(tx, applications.map(application => application.userId));
        const original = new Map(applications.map(application => [application.id, application.userId]));
        const pending = (await tx.find('applications', { circleId: circle.id, status: 'pending' }))
            .filter(application => original.get(application.id) === application.userId);
        const views = pending.map(application => {
            const validInvite = invites.get(application.inviteId);
            const current = profiles.get(application.userId);
            const currentReady = Boolean(current && profileComplete(current));
            const currentName = currentReady ? str(current.name, '姓名', 60) : application.name;
            const currentProfile = currentReady ? this.joinProfileFromAccount(current) : undefined;
            return {
                ...this.safeApplication(application, true),
                name: currentName, profile: currentProfile,
                profileChanged: currentReady ? this.applicationProfileChanged(application, current, currentName, currentProfile) : true,
                profileIncomplete: !currentReady || !application.profile,
                reviewToken: currentReady ? this.applicationReviewToken(application, current) : undefined,
                inviteStatus: validInvite ? this.inviteStatus(validInvite) : 'missing',
                inviteExpiresAt: validInvite?.expiresAt
            };
        });
        return { applications: views };
    }
    async myApplications(tx, p, actorId) {
        if (p.inviteToken !== undefined && p.applicationId !== undefined)
            fail('INVALID_INPUT', '请只选择一种申请查询方式');
        // An expired, revoked or used invitation still identifies the applicant's
        // own history. It never substitutes for current membership authorization.
        const requestedInvite = p.inviteToken === undefined ? undefined : await this.verifyInvite(tx, p.inviteToken);
        const requestedId = requestedInvite ? applicationId(requestedInvite.id, actorId)
            : p.applicationId === undefined ? undefined : str(p.applicationId, 'applicationId');
        const all = requestedId
            ? [await tx.get('applications', requestedId)].filter((item) => Boolean(item && item.userId === actorId &&
                (!requestedInvite || (item.inviteId === requestedInvite.id && item.circleId === requestedInvite.circleId))))
            : (await tx.find('applications', { userId: actorId })).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        if (requestedId && !requestedInvite && all.length === 0)
            fail('NOT_FOUND', '加入申请不存在');
        // Bound document lookups: 20 applications require at most 40 circle/invite
        // reads, well within CloudBase's per-transaction operation limit.
        const applications = requestedId ? all : all.slice(0, 20);
        const views = await Promise.all(applications.map(async (application) => {
            const circle = await tx.get('circles', application.circleId);
            const invite = application.status === 'pending' ? await tx.get('invites', application.inviteId) : undefined;
            const currentMember = application.status === 'approved' ? await tx.get('members', memberId(application.circleId, actorId)) : undefined;
            const inviteStatus = invite ? this.inviteStatus(invite) : application.status === 'pending' ? 'expired' : undefined;
            const status = application.status === 'pending' && inviteStatus !== 'active' ? 'expired' : application.status;
            return { ...this.safeApplication(application), status, canEnter: currentMember?.status === 'active', circleName: circle?.name || '记录', circleType: circle?.type, inviteStatus };
        }));
        return { applications: views, hasMore: !requestedId && all.length > applications.length };
    }
    async resolveApplication(tx, p, actorId, approve) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const application = await tx.get('applications', str(p.applicationId, 'applicationId'));
        if (!application || application.circleId !== circle.id)
            fail('NOT_FOUND', '加入申请不存在');
        if (application.status !== 'pending')
            fail('ALREADY_REVIEWED', '申请已经处理');
        if (approve) {
            const initial = p.initialRelation === undefined ? undefined : parseInitialRelation(p.initialRelation);
            if (p.deferRelation !== undefined && typeof p.deferRelation !== 'boolean')
                fail('INVALID_INPUT', '请明确选择是否稍后补充关系');
            const deferRelation = p.deferRelation === true;
            if (deferRelation && (initial || p.targetPersonId !== undefined))
                fail('INVALID_INPUT', '关联已有资料或已选择关系时不能同时选择稍后补充');
            if (p.deferRelation !== undefined && circle.type !== 'family')
                fail('WRONG_CIRCLE_TYPE', '同窗录不需要设置亲属关系');
            if (initial && p.targetPersonId !== undefined)
                fail('INVALID_INPUT', '关联已有资料时不能同时为新人建立关系');
            if (initial && circle.type !== 'family')
                fail('WRONG_CIRCLE_TYPE', '同窗录不能录入亲属关系');
            if (circle.type === 'family' && p.targetPersonId === undefined && !initial && !deferRelation &&
                (await tx.find('persons', { circleId: circle.id })).length > 0) {
                fail('RELATION_REQUIRED', '请先选择新家人与已有家人的关系');
            }
            if (!application.profile)
                fail('PROFILE_INCOMPLETE', '旧申请缺少城市或生日，请让申请人使用新邀请重新填写');
            const current = await this.ownProfile(tx, application.userId);
            if (!current || !profileComplete(current))
                fail('PROFILE_INCOMPLETE', '申请人的资料尚未填完整，请让申请人补齐后再审核');
            const currentName = str(current.name, '姓名', 60);
            const reviewedProfile = this.joinProfileFromAccount(current);
            const reviewToken = this.applicationReviewToken(application, current);
            const profileChanged = this.applicationProfileChanged(application, current, currentName, reviewedProfile);
            if ((p.reviewToken !== undefined && p.reviewToken !== reviewToken) ||
                (profileChanged && p.reviewToken !== reviewToken)) {
                fail('PROFILE_CHANGED', '申请人的资料已变化，请刷新审核列表后重新核对');
            }
            // Read and write the SAME invite document inside one CloudBase transaction.
            // Competing approvals therefore cannot both consume its one successful use.
            const invite = await tx.get('invites', application.inviteId);
            if (!invite || invite.circleId !== circle.id)
                fail('INVALID_INVITE', '邀请不存在');
            this.requireActiveInvite(invite);
            const mid = memberId(circle.id, application.userId);
            const existing = await tx.get('members', mid);
            if (existing?.status === 'active')
                fail('ALREADY_MEMBER', '申请人已经是成员');
            const applicantMemberships = await tx.find('members', { userId: application.userId, status: 'active' });
            if (applicantMemberships.length >= maxBulkTransactionWrites)
                fail('DATA_LIMIT', '申请人已加入太多记录');
            const pendingForInvite = await tx.find('applications', { inviteId: invite.id, status: 'pending' });
            const pendingForUser = await tx.find('applications', { circleId: circle.id, userId: application.userId, status: 'pending' });
            const others = [...new Map([...pendingForInvite, ...pendingForUser]
                    .filter(other => other.id !== application.id).map(other => [other.id, other])).values()];
            // Creating a family edge adds endpoint reads/writes, a circle write and
            // an audit record to the same CloudBase transaction (100 doc operations).
            if (others.length > (initial ? maxBulkTransactionWrites - 12 : maxBulkTransactionWrites))
                fail('DATA_LIMIT', '待审申请过多，请先处理申请');
            // Legacy claimPersonId is never trusted. The administrator must pass a
            // fresh targetPersonId, or a new claimed card is created atomically.
            let person;
            if (p.targetPersonId !== undefined) {
                person = await this.person(tx, circle.id, p.targetPersonId);
                if (person.claimedBy)
                    fail('ALREADY_CLAIMED', '所选人物卡已被认领');
                if (!Number.isSafeInteger(p.targetPersonUpdatedAt) || p.targetPersonUpdatedAt !== person.updatedAt) {
                    fail('TARGET_CHANGED', '这位人物的资料或关系已变化，请刷新后重新选择');
                }
                await this.requireMatchingPhone(tx, person, application.userId);
                const pendingClaims = await tx.find('claimRequests', { circleId: circle.id, personId: person.id, status: 'pending' });
                if (pendingClaims.length)
                    fail('CLAIM_PENDING', '所选人物卡还有待审认领，请先处理');
                await this.clearMatchPhone(tx, person);
                person.name = currentName;
                person.country = reviewedProfile.country;
                person.province = reviewedProfile.province;
                person.city = reviewedProfile.city;
                person.latitude = reviewedProfile.latitude;
                person.longitude = reviewedProfile.longitude;
                person.birthday = reviewedProfile.birthday;
                person.claimedBy = application.userId;
                person.lastConfirmedAt = this.now();
                person.updatedAt = this.nextPersonUpdatedAt(person);
            }
            else {
                const now = this.now();
                person = { id: id(), circleId: circle.id, name: currentName, ...reviewedProfile,
                    claimedBy: application.userId, lastConfirmedAt: now, visibility: {}, relationCount: 0, createdAt: now, updatedAt: now };
            }
            // The applicant's account profile is already loaded above. Do not copy
            // any administrator-entered card fields into that shared profile.
            // Remarks use joinedAt as the membership generation. Keep it strictly
            // increasing even for rapid rejoins or a wall-clock correction.
            const joinedAt = existing ? Math.max(this.now(), existing.joinedAt + 1, (existing.endedAt ?? 0) + 1) : this.now();
            const member = { id: mid, circleId: circle.id, userId: application.userId, name: currentName, role: 'member', status: 'active', personId: person.id, joinedAt };
            await tx.put('persons', person);
            await tx.put('members', member);
            if (initial)
                await this.createInitialRelation(tx, circle, actorId, person.id, initial, 'join.approve');
            application.name = currentName;
            application.profile = reviewedProfile;
            application.profileVersion = this.profileVersion(current);
            invite.usedAt = this.now();
            invite.usedBy = application.userId;
            await tx.put('invites', invite);
            for (const other of others) {
                other.status = 'expired';
                await tx.put('applications', other);
            }
        }
        application.status = approve ? 'approved' : 'rejected';
        application.reviewedAt = this.now();
        application.reviewedBy = actorId;
        await tx.put('applications', application);
        await this.audit(tx, circle.id, actorId, approve ? 'join.approve' : 'join.reject', application.id, approve ? { personId: (await tx.get('members', memberId(circle.id, application.userId)))?.personId, personChoice: p.targetPersonId ? 'existing' : 'new' } : undefined);
        return { application: this.safeApplication(application, true) };
    }
    safeMember(member, actorId) {
        return {
            id: member.id, circleId: member.circleId, name: member.name || '成员', role: member.role,
            status: member.status, personId: member.personId, joinedAt: member.joinedAt,
            endedAt: member.endedAt, isSelf: member.userId === actorId
        };
    }
    async listMembers(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        const rows = await tx.find('persons', { circleId: circle.id });
        const persons = new Map((await this.peopleForRead(tx, rows)).map(person => [person.id, person]));
        const members = await tx.find('members', { circleId: circle.id, status: 'active' });
        const views = members.map(m => {
            const linked = m.personId ? persons.get(m.personId) : undefined;
            const name = linked?.claimedBy === m.userId ? linked.name : undefined;
            return { ...this.safeMember(m, actorId), name: name || m.name || '成员' };
        });
        return { members: views };
    }
    async scrubAfterLeaving(tx, member, actorId) {
        const delegations = await tx.find('delegations', { circleId: member.circleId });
        const activeDelegations = delegations.filter(delegation => !delegation.revokedAt && (delegation.ownerUserId === member.userId || delegation.adminUserId === member.userId));
        const pendingClaims = await tx.find('claimRequests', { circleId: member.circleId, userId: member.userId, status: 'pending' });
        if (activeDelegations.length + pendingClaims.length > maxBulkTransactionWrites)
            fail('DATA_LIMIT', '待处理授权或认领过多，无法一次性安全移除成员');
        if (member.personId) {
            const person = await tx.get('persons', member.personId);
            if (person && person.circleId === member.circleId && person.claimedBy === member.userId) {
                person.claimedBy = undefined;
                person.profileOverrides = undefined;
                await this.clearMatchPhone(tx, person);
                for (const field of privateFields)
                    person[field] = undefined;
                person.visibility = {};
                person.updatedAt = this.nextPersonUpdatedAt(person);
                await tx.put('persons', person);
            }
            member.personId = undefined;
        }
        for (const delegation of activeDelegations) {
            delegation.revokedAt = this.now();
            await tx.put('delegations', delegation);
        }
        for (const claim of pendingClaims) {
            claim.status = 'rejected';
            claim.reviewedAt = this.now();
            claim.reviewedBy = actorId;
            await tx.put('claimRequests', claim);
        }
    }
    async endMember(tx, p, actorId, state) {
        const { circle, member: actor } = await this.access(tx, p.circleId, actorId, state === 'removed' ? 'admin' : 'member');
        let target;
        if (state === 'left')
            target = actor;
        else {
            const result = await tx.get('members', str(p.memberId, 'memberId'));
            if (!result || result.circleId !== circle.id || result.status !== 'active')
                fail('NOT_FOUND', '成员不存在');
            target = result;
            if (target.id === actor.id)
                fail('INVALID_INPUT', '请使用退出记录');
            if (rank(actor.role) <= rank(target.role))
                fail('FORBIDDEN', '不能移除同级或更高权限成员');
        }
        if (target.role === 'owner')
            fail('OWNER_REQUIRED', '创建者须先移交管理权');
        target.status = state;
        target.endedAt = this.now();
        await this.scrubAfterLeaving(tx, target, actorId);
        await tx.put('members', target);
        if (circle.ownerTransfer?.targetMemberId === target.id) {
            const transferId = circle.ownerTransfer.id;
            circle.ownerTransfer = undefined;
            circle.updatedAt = this.now();
            await tx.put('circles', circle);
            await this.audit(tx, circle.id, actorId, 'circle.transferCancelled', target.id, { transferId, reason: 'target_membership_ended' });
        }
        await this.audit(tx, circle.id, actorId, state === 'left' ? 'member.leave' : 'member.remove', target.id);
        return { member: this.safeMember(target, actorId) };
    }
    async setRole(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'owner');
        const target = await tx.get('members', str(p.memberId, 'memberId'));
        if (!target || target.circleId !== circle.id || target.status !== 'active' || target.role === 'owner')
            fail('NOT_FOUND', '可调整的成员不存在');
        const role = oneOf(p.role, ['admin', 'member'], '角色');
        const activeDelegations = role === 'member'
            ? (await tx.find('delegations', { circleId: circle.id, adminUserId: target.userId })).filter(delegation => !delegation.revokedAt)
            : [];
        if (activeDelegations.length > maxBulkTransactionWrites)
            fail('DATA_LIMIT', '授权记录过多，无法一次性安全调整管理员');
        target.role = role;
        await tx.put('members', target);
        for (const delegation of activeDelegations) {
            delegation.revokedAt = this.now();
            await tx.put('delegations', delegation);
        }
        await this.audit(tx, circle.id, actorId, 'member.setRole', target.id, { role });
        return { member: this.safeMember(target, actorId) };
    }
    async grantDelegation(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        const person = await this.person(tx, circle.id, p.personId);
        if (person.claimedBy !== actorId)
            fail('FORBIDDEN', '只有本人可以授权代维护');
        const admin = await tx.get('members', str(p.adminMemberId, 'adminMemberId'));
        if (!admin || admin.circleId !== circle.id || admin.status !== 'active' || rank(admin.role) < 2 || admin.userId === actorId)
            fail('INVALID_INPUT', '请选择这份记录中的其他管理员');
        if (!Array.isArray(p.fields) || p.fields.length === 0 || p.fields.length > delegableFields.length)
            fail('INVALID_INPUT', '请选择授权字段');
        const fields = [];
        for (const field of p.fields) {
            if (typeof field !== 'string' || !delegableFields.includes(field))
                fail('INVALID_INPUT', '授权字段不支持');
            if (!fields.includes(field))
                fields.push(field);
        }
        const delegation = {
            id: `${person.id}_${hash(admin.userId).slice(0, 40)}`, circleId: circle.id,
            personId: person.id, ownerUserId: actorId, adminUserId: admin.userId,
            fields, createdAt: this.now()
        };
        await tx.put('delegations', delegation);
        await this.audit(tx, circle.id, actorId, 'delegation.grant', delegation.id, { fields });
        return { delegation: { id: delegation.id, circleId: circle.id, personId: person.id, adminMemberId: admin.id, fields, createdAt: delegation.createdAt } };
    }
    async revokeDelegation(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId);
        const delegation = await tx.get('delegations', str(p.delegationId, 'delegationId'));
        if (!delegation || delegation.circleId !== circle.id)
            fail('NOT_FOUND', '授权不存在');
        if (delegation.ownerUserId !== actorId)
            fail('FORBIDDEN', '只有授权人可撤销');
        if (!delegation.revokedAt) {
            delegation.revokedAt = this.now();
            await tx.put('delegations', delegation);
            await this.audit(tx, circle.id, actorId, 'delegation.revoke', delegation.id);
        }
        return { delegation: { id: delegation.id, revokedAt: delegation.revokedAt } };
    }
    async createSuggestion(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const now = this.now();
        const ownSuggestions = await tx.find('suggestions', { circleId: circle.id, createdBy: actorId });
        if (ownSuggestions.filter(suggestion => suggestion.status === 'pending').length >= maxPendingSuggestionsPerCircle) {
            fail('SUGGESTION_PENDING_LIMIT', `你在这份记录还有 ${maxPendingSuggestionsPerCircle} 条待处理建议，请等待管理员处理`);
        }
        if (ownSuggestions.filter(suggestion => suggestion.createdAt > now - suggestionWindow).length >= maxSuggestionsPerDayPerCircle) {
            fail('SUGGESTION_DAILY_LIMIT', `每 24 小时在同一份记录最多提交 ${maxSuggestionsPerDayPerCircle} 条建议，请稍后再试`);
        }
        const type = oneOf(p.type, ['person', 'relation', 'invite'], '建议类型');
        let personId;
        if (p.personId !== undefined)
            personId = (await this.person(tx, circle.id, p.personId)).id;
        let relationChange;
        let expectedRelationHash;
        if (type === 'relation') {
            if (circle.type !== 'family')
                fail('WRONG_CIRCLE_TYPE', '同窗录没有亲属关系');
            relationChange = await this.parseRelationChange(tx, circle, p.relationChange);
            const plan = await this.planRelationChange(tx, circle, relationChange, actorId);
            if (plan.before)
                expectedRelationHash = relationFingerprint(plan.before);
        }
        else if (p.relationChange !== undefined)
            fail('INVALID_INPUT', '只有关系建议可包含关系更正');
        const suggestion = { id: id(), circleId: circle.id, createdBy: actorId, personId, type, message: str(p.message, '建议内容', 500), relationChange, expectedRelationHash, status: 'pending', createdAt: now };
        // CloudBase collection scans run outside the transaction. Writing the
        // deterministic member document serializes this member's submissions so
        // concurrent requests cannot both pass the same quota snapshot.
        await tx.put('members', member);
        await tx.put('suggestions', suggestion);
        await this.audit(tx, circle.id, actorId, 'suggestion.create', suggestion.id);
        return { suggestion: this.safeSuggestion(suggestion) };
    }
    safeSuggestion(s) { return { id: s.id, circleId: s.circleId, type: s.type, personId: s.personId, message: s.message, relationChange: s.relationChange, status: s.status, createdAt: s.createdAt, resolvedAt: s.resolvedAt, resolutionNote: s.resolutionNote }; }
    async listSuggestions(tx, p, actorId) {
        const { circle, member } = await this.access(tx, p.circleId, actorId);
        const suggestions = await tx.find('suggestions', { circleId: circle.id });
        return { suggestions: suggestions.filter(s => rank(member.role) >= 2 || s.createdBy === actorId).map(s => this.safeSuggestion(s)) };
    }
    async resolveSuggestion(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const suggestion = await tx.get('suggestions', str(p.suggestionId, 'suggestionId'));
        if (!suggestion || suggestion.circleId !== circle.id)
            fail('NOT_FOUND', '建议不存在');
        if (suggestion.status !== 'pending')
            fail('ALREADY_REVIEWED', '建议已处理');
        const status = oneOf(p.status, ['accepted', 'handled', 'rejected'], '处理结果');
        const resolutionNote = str(p.resolutionNote, '处理说明', 500);
        const hasRelationChange = Boolean(suggestion.relationChange?.removeRelationId || suggestion.relationChange?.relation);
        let applied;
        if (status === 'handled' && suggestion.type === 'relation' && hasRelationChange)
            fail('CHANGE_REQUIRED', '具体关系变更须采纳并应用或拒绝，不能只标为已处理');
        if (status === 'accepted' && suggestion.type !== 'relation')
            fail('CHANGE_REQUIRED', '资料或邀请建议请标为已人工处理，不能直接标为已采纳');
        if (status === 'accepted' && suggestion.type === 'relation') {
            if (!hasRelationChange)
                fail('CHANGE_REQUIRED', '此建议只有文字说明，人工核对后请标记已处理');
            applied = await this.applyRelationChange(tx, circle, suggestion.relationChange, actorId, suggestion.expectedRelationHash);
        }
        suggestion.status = status;
        suggestion.resolvedAt = this.now();
        suggestion.resolvedBy = actorId;
        suggestion.resolutionNote = resolutionNote;
        await tx.put('suggestions', suggestion);
        await this.audit(tx, circle.id, actorId, 'suggestion.resolve', suggestion.id, { status: suggestion.status, resolutionNote, ...(applied ? { removed: applied.before, created: applied.after, affectedPersonIds: applied.impact.affectedPersonIds, reason: suggestion.message } : {}) });
        return { suggestion: this.safeSuggestion(suggestion), ...(applied ? { impact: applied.impact } : {}) };
    }
    async listAudit(tx, p, actorId) {
        const { circle } = await this.access(tx, p.circleId, actorId, 'admin');
        const events = await tx.find('audit', { circleId: circle.id });
        const members = new Map((await tx.find('members', { circleId: circle.id })).map(member => [member.id, member]));
        const persons = new Map((await tx.find('persons', { circleId: circle.id })).map(person => [person.id, person]));
        const views = events.sort((a, b) => b.at - a.at).slice(0, 100).map(({ id, circleId, actorId: eventActorId, type, targetId, at, details }) => {
            const member = members.get(memberId(circle.id, eventActorId));
            const person = member?.personId ? persons.get(member.personId) : undefined;
            return { id, circleId, actorName: person?.name || member?.name || '原成员', type, targetId, at, details };
        });
        return { events: views };
    }
}
exports.ApiService = ApiService;
