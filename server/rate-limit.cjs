"use strict";

// Reserve before verification so parallel guesses cannot exceed the budget.
// Successful verification refunds only its own reservation, never other failures.
function reserveAttempts(db, keys, now, window) {
  db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").run(now);
  const rows = keys.map(([key, cap]) => ({
    key,
    cap,
    row: db
      .prepare("SELECT count, expires_at FROM rate_limits WHERE key = ?")
      .get(key),
  }));
  const blocked = rows.filter(({ row, cap }) => row && row.count >= cap);
  if (blocked.length)
    return {
      retryAfter: Math.max(
        1,
        Math.ceil(
          (Math.max(...blocked.map(({ row }) => row.expires_at)) - now) / 1000,
        ),
      ),
    };
  const reservations = rows.map(({ key, row }) => {
    const expiresAt = row?.expires_at ?? now + window;
    db.prepare(
      "INSERT INTO rate_limits(key, count, expires_at) VALUES(?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1",
    ).run(key, expiresAt);
    return { key, expiresAt };
  });
  return { retryAfter: 0, reservations };
}

function refundAttempts(db, reservations) {
  for (const { key, expiresAt } of reservations) {
    db.prepare(
      "UPDATE rate_limits SET count = MAX(0, count - 1) WHERE key = ? AND expires_at = ?",
    ).run(key, expiresAt);
    db.prepare(
      "DELETE FROM rate_limits WHERE key = ? AND expires_at = ? AND count = 0",
    ).run(key, expiresAt);
  }
}

module.exports = { reserveAttempts, refundAttempts };
