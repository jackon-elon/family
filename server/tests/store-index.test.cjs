const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SqliteStore, documentMatchConditions } = require("../store.cjs");

test("family and user lookups use ordered expression indexes and keep query semantics", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "family-index-test-"),
  );
  const store = new SqliteStore(directory);
  t.after(async () => {
    await store.close();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.atomic(async (tx) => {
    for (let i = 0; i < 300; i++)
      await tx.put("persons", {
        id: String(i).padStart(3, "0"),
        circleId: `family-${i % 30}`,
        userId: `user-${i % 40}`,
        flag: i % 2 === 0,
      });
    await tx.put("persons", { id: "missing" });
  });
  for (const [key, value, index] of [
    ["circleId", "family-3", "document_circle_order"],
    ["userId", "user-7", "document_user_order"],
  ]) {
    const { clauses, values } = documentMatchConditions("persons", {
      [key]: value,
    });
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT body FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT 5001`,
      )
      .all(...values)
      .map((row) => row.detail)
      .join("\n");
    assert.match(plan, new RegExp(`USING INDEX ${index}.*<expr>=`));
    assert.doesNotMatch(plan, /TEMP B-TREE/);
    const rows = await store.atomic((tx) =>
      tx.find("persons", { [key]: value }),
    );
    assert.equal(rows.length, key === "circleId" ? 10 : 8);
    assert.ok(rows.every((row) => row[key] === value));
    assert.deepEqual(
      rows.map((row) => row.id),
      rows.map((row) => row.id).sort(),
    );
  }
  assert.equal(
    (await store.atomic((tx) => tx.find("persons", { circleId: undefined })))[0]
      .id,
    "missing",
  );
  assert.equal(
    (await store.atomic((tx) => tx.find("persons", { flag: true }))).length,
    150,
  );
  assert.equal(
    (
      await store.atomic((tx) =>
        tx.find("persons", { circleId: "x' OR 1=1 --" }),
      )
    ).length,
    0,
  );
  await assert.rejects(
    store.atomic((tx) => tx.find("persons", { "circleId') OR 1=1 --": "x" })),
    /Invalid query/,
  );
  await store.atomic((tx) =>
    tx.put("persons", { id: "003", circleId: "moved", userId: "changed" }),
  );
  assert.equal(
    (await store.atomic((tx) => tx.find("persons", { circleId: "family-3" })))
      .length,
    9,
  );
});
