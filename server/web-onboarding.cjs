"use strict";

const crypto = require("node:crypto");
const { ApiError } = require("../backend/dist/service.js");
const { HttpError, normalizePhone, availableInvite } = require("./auth.cjs");

const fields = [
  "name",
  "nickname",
  "gender",
  "birthday",
  "country",
  "province",
  "city",
  "latitude",
  "longitude",
  "status",
  "school",
  "industry",
  "occupation",
  "bio",
  "phone",
  "wechatId",
  "photoFileId",
];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const profileId = (id) => `user_profile_${hash(id).slice(0, 40)}`;
const memberId = (circleId, id) => `${circleId}_${hash(id).slice(0, 40)}`;
function read(db, collection, id) {
  const row = db
    .prepare("SELECT body FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id);
  return row ? JSON.parse(row.body) : undefined;
}
function put(db, collection, value) {
  db.prepare(
    "INSERT INTO documents(collection, id, body) VALUES(?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body",
  ).run(collection, value.id, JSON.stringify(value));
}
function persons(db, circleId) {
  const rows = db
    .prepare(
      "SELECT body FROM documents WHERE collection = 'persons' AND json_extract(body, '$.circleId') = ? LIMIT 5001",
    )
    .all(circleId);
  if (rows.length > 5000)
    throw new ApiError("DATA_LIMIT", "家庭资料过多，请联系网站维护者处理");
  return rows.map((row) => JSON.parse(row.body));
}
function normalized(value) {
  try {
    return normalizePhone(value);
  } catch {
    return undefined;
  }
}
function accountPhone(db, userId) {
  return db.prepare("SELECT phone FROM accounts WHERE id = ?").get(userId)
    ?.phone;
}
function effectivePhone(db, person) {
  if (!person.claimedBy) return person.phone;
  const profile = read(db, "userProfiles", profileId(person.claimedBy));
  if (!profile) return person.phone;
  const correction = person.profileOverrides?.phone;
  if (
    correction &&
    correction.baseRevision === (profile.fieldRevisions?.phone ?? 0)
  )
    return correction.value;
  return !profile.cardFallback ||
    profile.phone !== undefined ||
    profile.clearedFields?.includes("phone")
    ? profile.phone
    : person.phone;
}
function matching(db, circleId, phone) {
  if (!phone) return [];
  return persons(db, circleId).filter(
    (person) =>
      normalized(effectivePhone(db, person)) === phone ||
      (person.claimedBy && accountPhone(db, person.claimedBy) === phone),
  );
}
function legacyPhoneAllowed(db, person, accountId, now) {
  if (!person.matchPhone) return true;
  const identity = read(
    db,
    "phoneIdentities",
    `phone_identity_${hash(accountId).slice(0, 40)}`,
  );
  return (
    identity?.userId === accountId &&
    identity.phone === person.matchPhone &&
    now < identity.verifiedAt + 90 * 86400000
  );
}
function phoneMatch(db, circleId, accountId, now) {
  const matches = matching(db, circleId, accountPhone(db, accountId));
  if (!matches.length) return { status: "none" };
  if (matches.length > 1)
    return {
      status: "conflict",
      message: "家里有多份资料使用这个手机号，请管理员先核对并更正后再加入。",
    };
  const person = matches[0];
  if (person.claimedBy)
    return {
      status: "bound",
      message: "这个手机号对应的家人资料已关联账号，请联系管理员核对。",
    };
  if (!legacyPhoneAllowed(db, person, accountId, now))
    return {
      status: "verification-required",
      message:
        "这份旧资料还需要已验证手机号核对，请联系管理员处理，不能仅凭登录号码关联。",
    };
  return {
    status: "unique",
    personId: person.id,
    personUpdatedAt: person.updatedAt,
  };
}
function rejectMatch(match) {
  if (!["none", "unique"].includes(match.status))
    throw new ApiError(
      match.status === "conflict"
        ? "PHONE_MATCH_CONFLICT"
        : match.status === "bound"
          ? "PHONE_ALREADY_BOUND"
          : "PHONE_MISMATCH",
      match.message,
    );
}
function receipt(db, inviteId, accountId) {
  return db
    .prepare(
      "SELECT person_id, person_updated_at, imported_fields FROM invite_profile_imports WHERE invite_id = ? AND account_id = ?",
    )
    .get(inviteId, accountId);
}
function confirmed(db, inviteId, accountId, match) {
  const saved = receipt(db, inviteId, accountId);
  return (
    match.status === "unique" &&
    saved?.person_id === match.personId &&
    saved.person_updated_at === match.personUpdatedAt
  );
}
function invitationMatch(db, inviteId, circleId, accountId, now) {
  const match = phoneMatch(db, circleId, accountId, now);
  if (match.status === "none" && receipt(db, inviteId, accountId))
    return {
      status: "conflict",
      message:
        "原家人资料的手机号已变化，请联系管理员核对正确号码后重新发送邀请。",
    };
  return match;
}
function assertConfirmation(db, inviteId, accountId, match) {
  if (match.status === "unique" && !confirmed(db, inviteId, accountId, match))
    throw new ApiError(
      "PROFILE_CONFIRMATION_REQUIRED",
      "已找到家里为你填写的资料，请重新打开邀请并确认后再申请。",
    );
  if (match.status === "none" && receipt(db, inviteId, accountId))
    throw new ApiError(
      "TARGET_CHANGED",
      "原来的家人资料已变化，请联系管理员核对后重新邀请。",
    );
}
function profileView(profile) {
  if (!profile) return null;
  const view = {};
  for (const field of fields)
    if (field !== "photoFileId" && profile[field] !== undefined)
      view[field] = profile[field];
  return {
    ...view,
    hasPhoto: Boolean(profile.photoFileId),
    profileComplete: Boolean(
      profile.name?.trim() &&
      profile.country?.trim() &&
      profile.city?.trim() &&
      profile.birthday,
    ),
    updatedAt: profile.updatedAt,
  };
}
function profileVersion(profile) {
  return hash(
    JSON.stringify(
      profile
        ? [
            ...fields.map((field) => profile[field] ?? null),
            profile.clearedFields ?? [],
          ]
        : null,
    ),
  );
}
/** Fill only absent values; explicit account edits and removals always win. */
function fillBlanks(profile, source, now, includePhoto) {
  const differentLocation = ["country", "province", "city"].some(
    (field) => profile[field] !== undefined && profile[field] !== source[field],
  );
  let changed = false;
  for (const field of fields) {
    if (
      (!includePhoto && field === "photoFileId") ||
      profile.clearedFields?.includes(field)
    )
      continue;
    if (
      differentLocation &&
      ["province", "latitude", "longitude"].includes(field)
    )
      continue;
    if (profile[field] === undefined && source[field] !== undefined) {
      profile[field] = source[field];
      profile.fieldRevisions ??= {};
      profile.fieldRevisions[field] = (profile.fieldRevisions[field] ?? 0) + 1;
      changed = true;
    }
  }
  if (changed) profile.updatedAt = Math.max(now, (profile.updatedAt || 0) + 1);
  if (profileView(profile).profileComplete) delete profile.cardFallback;
  return changed;
}
// Reconfirmation updates previous automatic fills only while both the value
// and field revision still match. Any explicit account edit wins, even if its
// value happened to be identical to the old imported value.
function importFields(profile, source, previousReceipt, now) {
  const old = previousReceipt?.imported_fields
    ? JSON.parse(previousReceipt.imported_fields)
    : {};
  const same = (a, b) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const unchanged = (field) =>
    old[field] &&
    (profile.fieldRevisions?.[field] ?? 0) === old[field].revision &&
    same(profile[field], old[field].value) &&
    !profile.clearedFields?.includes(field);
  const localLocation = ["country", "province", "city"].some(
    (field) =>
      profile[field] !== undefined &&
      profile[field] !== source[field] &&
      !unchanged(field),
  );
  const tracked = new Set();
  let refreshed = false;
  for (const field of fields) {
    if (
      field === "photoFileId" ||
      !unchanged(field) ||
      (localLocation &&
        ["country", "province", "city", "latitude", "longitude"].includes(
          field,
        ))
    )
      continue;
    if (!same(profile[field], source[field])) {
      profile[field] = source[field];
      profile.fieldRevisions ??= {};
      profile.fieldRevisions[field] = (profile.fieldRevisions[field] ?? 0) + 1;
      refreshed = true;
    }
    tracked.add(field);
  }
  const absent = fields.filter((field) => profile[field] === undefined);
  fillBlanks(profile, source, now, false);
  for (const field of absent)
    if (profile[field] !== undefined) tracked.add(field);
  if (refreshed)
    profile.updatedAt = Math.max(now, (profile.updatedAt || 0) + 1);
  return Object.fromEntries(
    [...tracked].map((field) => [
      field,
      {
        value: profile[field] ?? null,
        revision: profile.fieldRevisions?.[field] ?? 0,
      },
    ]),
  );
}
function requireAdmin(db, circleId, actorId) {
  const circle = typeof circleId === "string" && read(db, "circles", circleId);
  const member = circle && read(db, "members", memberId(circle.id, actorId));
  return (
    circle?.type === "family" &&
    member?.status === "active" &&
    ["owner", "admin"].includes(member.role)
  );
}
function requireUnusedPhone(db, circleId, phone, exceptId) {
  if (matching(db, circleId, phone).some((person) => person.id !== exceptId))
    throw new ApiError(
      "PHONE_ALREADY_USED",
      "家里已有资料使用这个手机号，请编辑已有家人的资料，或核对后填写正确号码。",
    );
}

/** Called inside the same SQLite transaction as the domain action. */
function beforeWebWork(db, current, action, payload, now) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const actorId = current.user.id;
  if (
    action === "account.profile.update" &&
    payload.patch &&
    typeof payload.patch === "object" &&
    !Array.isArray(payload.patch)
  ) {
    const profile = read(db, "userProfiles", profileId(actorId));
    // Legacy profiles can use the login phone when no contact was recorded.
    const phone = Object.prototype.hasOwnProperty.call(payload.patch, "phone")
      ? payload.patch.phone
      : profile?.phone || accountPhone(db, actorId);
    try {
      const validated = normalizePhone(phone);
      if (
        Object.prototype.hasOwnProperty.call(payload.patch, "phone") ||
        !profile?.phone
      )
        payload.patch.phone = validated;
    } catch {
      throw new ApiError("PHONE_REQUIRED", "请填写本人有效手机号。");
    }
  }
  if (
    action === "person.create" &&
    payload.claimSelf !== true &&
    requireAdmin(db, payload.circleId, actorId)
  ) {
    try {
      payload.phone = normalizePhone(payload.phone);
    } catch {
      throw new ApiError(
        "PHONE_REQUIRED",
        "添加家人时请填写本人将来登录使用的有效手机号。",
      );
    }
    // Permit an exact retry; the domain compares the complete request fingerprint.
    const exceptId =
      typeof payload.requestId === "string"
        ? `idem_${hash(JSON.stringify([`person.create:${payload.circleId}`, actorId, payload.requestId])).slice(0, 40)}`
        : undefined;
    requireUnusedPhone(db, payload.circleId, payload.phone, exceptId);
  }
  if (action === "person.create" && payload.claimSelf === true) {
    try {
      payload.phone = normalizePhone(
        payload.phone === undefined ? accountPhone(db, actorId) : payload.phone,
      );
    } catch {
      throw new ApiError("PHONE_REQUIRED", "请填写本人有效手机号。");
    }
    const member =
      typeof payload.circleId === "string" &&
      read(db, "members", memberId(payload.circleId, actorId));
    if (member?.status === "active" && !member.personId) {
      const match = phoneMatch(db, payload.circleId, actorId, now);
      rejectMatch(match);
      if (match.status === "unique")
        throw new ApiError(
          "PHONE_TARGET_REQUIRED",
          "家里已有你的资料，请保存我的资料以关联原记录，不必重新添加。",
        );
    }
  }
  if (
    action === "person.update" &&
    typeof payload.circleId === "string" &&
    typeof payload.personId === "string" &&
    payload.patch &&
    typeof payload.patch === "object" &&
    !Array.isArray(payload.patch)
  ) {
    const person = read(db, "persons", payload.personId);
    const member = read(db, "members", memberId(payload.circleId, actorId));
    if (
      person?.circleId === payload.circleId &&
      member?.status === "active" &&
      (requireAdmin(db, payload.circleId, actorId) ||
        person.claimedBy === actorId)
    ) {
      const phone = Object.prototype.hasOwnProperty.call(payload.patch, "phone")
        ? payload.patch.phone
        : effectivePhone(db, person);
      try {
        const validated = normalizePhone(phone);
        if (Object.prototype.hasOwnProperty.call(payload.patch, "phone"))
          payload.patch.phone = validated;
      } catch {
        throw new ApiError("PHONE_REQUIRED", "请填写这位家人的有效手机号。");
      }
      if (
        !person.claimedBy &&
        Object.prototype.hasOwnProperty.call(payload.patch, "phone")
      )
        requireUnusedPhone(db, person.circleId, payload.patch.phone, person.id);
    }
  }
  if (action === "invite.apply") {
    const invite = availableInvite(db, payload.token, now, actorId);
    const match = invitationMatch(db, invite.id, invite.circleId, actorId, now);
    rejectMatch(match);
    assertConfirmation(db, invite.id, actorId, match);
  }
  if (
    action === "join.approve" &&
    requireAdmin(db, payload.circleId, actorId)
  ) {
    const application = read(db, "applications", payload.applicationId);
    if (!application || application.circleId !== payload.circleId) return;
    const match = invitationMatch(
      db,
      application.inviteId,
      application.circleId,
      application.userId,
      now,
    );
    rejectMatch(match);
    assertConfirmation(db, application.inviteId, application.userId, match);
    if (
      match.status === "unique" &&
      (payload.targetPersonId !== match.personId ||
        payload.targetPersonUpdatedAt !== match.personUpdatedAt)
    )
      throw new ApiError(
        "PHONE_TARGET_REQUIRED",
        "请核对并关联手机号对应的已有家人资料，不能另建一份。",
      );
    const target =
      typeof payload.targetPersonId === "string" &&
      read(db, "persons", payload.targetPersonId);
    if (target && target.circleId === application.circleId) {
      const targetPhone = normalized(target.phone);
      if (targetPhone && targetPhone !== accountPhone(db, application.userId))
        throw new ApiError(
          "PHONE_MISMATCH",
          "所选资料的手机号与申请账号不同，请先核对并更正资料手机号。",
        );
      return { approval: { accountId: application.userId, source: target } };
    }
  }
}

async function afterWebWork(db, tx, action, payload, result, state, now) {
  if (action === "join.list" && result?.applications) {
    for (const view of result.applications) {
      const application = read(db, "applications", view.id);
      if (!application || application.circleId !== payload.circleId) continue;
      view.loginPhone = accountPhone(db, application.userId);
      const match = invitationMatch(
        db,
        application.inviteId,
        application.circleId,
        application.userId,
        now,
      );
      view.phoneMatch = {
        ...match,
        confirmed: confirmed(
          db,
          application.inviteId,
          application.userId,
          match,
        ),
      };
    }
  }
  if (state?.approval && result?.application?.status === "approved") {
    const { accountId, source } = state.approval;
    const profile = await tx.get("userProfiles", profileId(accountId));
    if (profile && fillBlanks(profile, source, now, true))
      await tx.put("userProfiles", profile);
  }
}

function approvedMemberMatch(db, member, now) {
  const match = phoneMatch(db, member.circleId, member.userId, now);
  rejectMatch(match);
  return match.status === "unique"
    ? read(db, "persons", match.personId)
    : undefined;
}

class WebOnboarding {
  constructor(store, auth, now) {
    this.store = store;
    this.auth = auth;
    this.now = now;
  }
  async run(current, body, importing = false) {
    return this.store.exclusive((db) => {
      this.auth.requireSession(db, current);
      const now = this.now(),
        actorId = current.user.id;
      const invite = availableInvite(db, body.inviteToken, now, actorId);
      const bound = db
        .prepare("SELECT account_id FROM invite_accounts WHERE invite_id = ?")
        .get(invite.id);
      if (bound && bound.account_id !== actorId)
        throw new HttpError(
          403,
          "INVITE_ASSIGNED",
          "请从邀请链接登录后再确认家人资料。",
        );
      const member = read(db, "members", memberId(invite.circleId, actorId));
      if (member?.status === "active")
        throw new HttpError(409, "ALREADY_MEMBER", "你已经加入这个家庭。");
      const match = invitationMatch(
        db,
        invite.id,
        invite.circleId,
        actorId,
        now,
      );
      const source =
        match.status === "unique"
          ? read(db, "persons", match.personId)
          : undefined;
      const previous = read(db, "userProfiles", profileId(actorId));
      if (importing) {
        rejectMatch(match);
        if (
          !source ||
          body.personId !== source.id ||
          body.personUpdatedAt !== source.updatedAt
        )
          throw new HttpError(
            409,
            "TARGET_CHANGED",
            "家人资料已变化，请刷新后重新确认。",
          );
        if (body.profileVersion !== profileVersion(previous))
          throw new HttpError(
            409,
            "PROFILE_CHANGED",
            "你的资料已变化，请刷新后重新确认。",
          );
        db.prepare(
          "INSERT INTO invite_accounts(invite_id, account_id, created_at) VALUES(?, ?, ?) ON CONFLICT(invite_id) DO NOTHING",
        ).run(invite.id, actorId, now);
        const profile = previous || {
          id: profileId(actorId),
          userId: actorId,
          createdAt: now,
          updatedAt: now,
        };
        const imported = importFields(
          profile,
          source,
          receipt(db, invite.id, actorId),
          now,
        );
        put(db, "userProfiles", profile);
        db.prepare(
          "INSERT INTO invite_profile_imports(invite_id, account_id, person_id, person_updated_at, imported_fields) VALUES(?, ?, ?, ?, ?) ON CONFLICT(invite_id, account_id) DO UPDATE SET person_id = excluded.person_id, person_updated_at = excluded.person_updated_at, imported_fields = excluded.imported_fields",
        ).run(
          invite.id,
          actorId,
          source.id,
          source.updatedAt,
          JSON.stringify(imported),
        );
        return { profile: profileView(profile) };
      }
      return {
        loginPhone: accountPhone(db, actorId),
        match: {
          ...match,
          confirmed: confirmed(db, invite.id, actorId, match),
          ...(source
            ? {
                person: {
                  id: source.id,
                  updatedAt: source.updatedAt,
                  profile: profileView(source),
                },
              }
            : {}),
        },
        profileVersion: profileVersion(previous),
      };
    });
  }
}

module.exports = {
  WebOnboarding,
  beforeWebWork,
  afterWebWork,
  approvedMemberMatch,
  fillBlanks,
};
