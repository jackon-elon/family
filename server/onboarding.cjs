"use strict";

const crypto = require("node:crypto");

/** Complete already-approved members only; a name/phone match grants nothing. */
async function completeMemberProfiles(tx, actorId, now, options = {}) {
  const profiles = await tx.find("userProfiles", { userId: actorId });
  const profile = profiles[0];
  if (
    !profile?.name?.trim() ||
    !profile.country?.trim() ||
    !profile.city?.trim() ||
    !profile.birthday
  )
    return;
  const members = await tx.find("members", {
    userId: actorId,
    status: "active",
  });
  for (const member of members) {
    if (member.personId) continue;
    const circle = await tx.get("circles", member.circleId);
    if (circle?.type !== "family") continue;
    const own = await tx.find("persons", {
      circleId: circle.id,
      claimedBy: actorId,
    });
    // Reuse an already claimed node if an older membership lost its pointer.
    // Otherwise the Web layer may resolve a unique phone match for this
    // already-approved member, after checking conflicts and legacy gates.
    if (own.length > 1) continue;
    let person = own[0];
    if (!person && options.findExisting) {
      person = options.findExisting(member);
      if (person) {
        person.claimedBy = actorId;
        person.lastConfirmedAt = now;
        person.updatedAt = Math.max(now, person.updatedAt + 1);
        if (options.fillBlanks(profile, person, now, true))
          await tx.put("userProfiles", profile);
        await tx.put("persons", person);
        await tx.put("audit", {
          id: crypto.randomUUID(),
          circleId: circle.id,
          actorId,
          type: "person.claim",
          targetId: person.id,
          at: now,
          details: { source: "approved-member-phone-match" },
        });
      }
    }
    if (!person) {
      person = {
        id: crypto.randomUUID(),
        circleId: circle.id,
        name: profile.name,
        country: profile.country,
        city: profile.city,
        birthday: profile.birthday,
        claimedBy: actorId,
        visibility: {},
        relationCount: 0,
        createdAt: now,
        updatedAt: now,
        lastConfirmedAt: now,
      };
      await tx.put("persons", person);
      await tx.put("audit", {
        id: crypto.randomUUID(),
        circleId: circle.id,
        actorId,
        type: "person.create",
        targetId: person.id,
        at: now,
        details: { source: "profile-completion" },
      });
    }
    member.personId = person.id;
    member.name = profile.name;
    await tx.put("members", member);
  }
}

module.exports = { completeMemberProfiles };
