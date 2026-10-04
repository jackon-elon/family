"use strict";

const crypto = require("node:crypto");
const userKey = (id) =>
  crypto.createHash("sha256").update(id).digest("hex").slice(0, 40);
const document = (db, collection, id) => {
  const row = db
    .prepare("SELECT body FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id);
  return row ? JSON.parse(row.body) : undefined;
};

function inviteEligibility(db, invite, accountId, now) {
  const family = invite && document(db, "circles", invite.circleId);
  if (
    !invite ||
    invite.tokenHash !== invite.id ||
    family?.type !== "family" ||
    family.mode !== "shared" ||
    invite.revokedAt ||
    invite.usedAt ||
    now >= invite.expiresAt
  )
    return undefined;
  const assigned = db
    .prepare("SELECT account_id FROM invite_accounts WHERE invite_id = ?")
    .get(invite.id);
  if (assigned && assigned.account_id !== accountId) return undefined;
  const member = document(
    db,
    "members",
    `${invite.circleId}_${userKey(accountId)}`,
  );
  // An older unused invitation cannot resurrect an ended family membership.
  if (
    member?.userId === accountId &&
    member.status !== "active" &&
    Number.isFinite(member.endedAt) &&
    invite.createdAt <= member.endedAt
  )
    return undefined;
  const application = document(
    db,
    "applications",
    `${invite.id}_${userKey(accountId)}`,
  );
  if (
    application &&
    (application.userId !== accountId ||
      application.circleId !== invite.circleId ||
      application.inviteId !== invite.id ||
      application.status !== "pending")
  )
    return undefined;
  return {
    assigned: Boolean(assigned),
    application,
    invitation: {
      id: invite.id,
      circleId: family.id,
      circleName: family.name,
      status: application ? "pending" : "profile-required",
      expiresAt: invite.expiresAt,
    },
  };
}

function accountAccess(db, accountId, now) {
  const member = db
    .prepare(
      `SELECT 1 FROM documents m JOIN documents c
    ON c.collection = 'circles' AND c.id = json_extract(m.body, '$.circleId')
    WHERE m.collection = 'members' AND json_extract(m.body, '$.userId') = ?
    AND json_extract(m.body, '$.status') = 'active' AND json_extract(c.body, '$.type') = 'family'
    AND m.id = c.id || '_' || ? LIMIT 1`,
    )
    .get(accountId, userKey(accountId));
  if (member) return { access: "member" };
  // The second branch preserves genuinely invited legacy applicants whose
  // pending application predates the one-account-per-invitation table.
  const candidates = db
    .prepare(
      `SELECT invite_id FROM invite_accounts WHERE account_id = ?
    UNION SELECT json_extract(body, '$.inviteId') AS invite_id FROM documents
    WHERE collection = 'applications' AND json_extract(body, '$.userId') = ?
    AND json_extract(body, '$.status') = 'pending'`,
    )
    .all(accountId, accountId);
  const valid = candidates
    .map(({ invite_id }) =>
      inviteEligibility(db, document(db, "invites", invite_id), accountId, now),
    )
    .filter((value) => value && (value.assigned || value.application));
  valid.sort(
    (a, b) =>
      Number(b.invitation.status === "pending") -
        Number(a.invitation.status === "pending") ||
      b.invitation.expiresAt - a.invitation.expiresAt,
  );
  return valid.length
    ? { access: "invited", invitation: valid[0].invitation }
    : undefined;
}

module.exports = { accountAccess, inviteEligibility };
