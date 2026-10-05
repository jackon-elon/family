"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { Authentication } = require("../auth.cjs");
const { reserveAttempts, refundAttempts } = require("../rate-limit.cjs");

test("password work queues FIFO, keeps four slots, and releases after failures", async () => {
  const auth = new Authentication({}, {});
  const releases = [];
  const order = [];
  const tasks = Array.from({ length: 50 }, (_, i) =>
    auth.withPasswordWork(() => {
      order.push(i);
      assert.ok(auth.hashesInFlight <= 4);
      return new Promise((resolve) => releases.push(resolve));
    }),
  );
  assert.equal(auth.hashesInFlight, 4);
  assert.equal(auth.passwordQueue.length, 46);
  for (let i = 0; i < 50; i++) {
    assert.ok(releases[i]);
    releases[i]();
    await tasks[i];
  }
  assert.deepEqual(
    order,
    Array.from({ length: 50 }, (_, i) => i),
  );
  assert.equal(auth.hashesInFlight, 0);
  const failure = auth.withPasswordWork(() => {
    throw new Error("failed");
  });
  await assert.rejects(failure, /failed/);
  assert.equal(auth.hashesInFlight, 0);
});

test("queue is bounded, expired requests never execute or consume attempt budgets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const auth = new Authentication({}, {});
  const releases = [];
  const running = Array.from({ length: 4 }, () =>
    auth.withPasswordWork(
      () => new Promise((resolve) => releases.push(resolve)),
    ),
  );
  let executed = 0;
  const queued = Array.from({ length: 64 }, () =>
    auth.passwordAttempt({}, "13812340000", () => executed++),
  );
  const settled = Promise.allSettled(queued);
  await assert.rejects(
    auth.withPasswordWork(() => executed++),
    (error) => error.status === 429,
  );
  t.mock.timers.tick(15_000);
  assert.ok(
    (await settled).every(
      (r) => r.status === "rejected" && r.reason.retryAfterSeconds === 2,
    ),
  );
  assert.equal(auth.passwordQueue.length, 0);
  assert.equal(executed, 0);
  releases.forEach((resolve) => resolve());
  await Promise.all(running);
  assert.equal(auth.hashesInFlight, 0);
  assert.equal(await auth.withPasswordWork(() => "recovered"), "recovered");
});

test("successful reservations preserve other failures and cannot refund a newer window", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE rate_limits(key TEXT PRIMARY KEY, count INTEGER, expires_at INTEGER)",
    );
    const keys = [["ip:test", 3]];
    const first = reserveAttempts(db, keys, 0, 100);
    reserveAttempts(db, keys, 0, 100); // failed verification
    const third = reserveAttempts(db, keys, 0, 100);
    assert.equal(reserveAttempts(db, keys, 0, 100).retryAfter, 1);
    refundAttempts(db, first.reservations);
    assert.equal(db.prepare("SELECT count FROM rate_limits").get().count, 2);
    reserveAttempts(db, keys, 100, 100);
    refundAttempts(db, third.reservations);
    assert.equal(db.prepare("SELECT count FROM rate_limits").get().count, 1);
  } finally {
    db.close();
  }
});
