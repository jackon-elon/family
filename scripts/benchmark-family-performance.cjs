// Synthetic, in-memory comparison only; never opens the user's database.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { DatabaseSync } = require("node:sqlite");
const { documentMatchConditions } = require("../server/store.cjs");
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) =>
      name.startsWith(".")
        ? load(path.resolve(path.dirname(file), name) + ".ts")
        : require(name),
    mod,
    mod.exports,
  );
  return mod.exports;
}
const { relationshipFor, relationshipsFor } = load(
  path.join(__dirname, "../frontend/src/shared/relationship.ts"),
);
const people = Array.from({ length: 100 }, (_, i) => ({
  id: String(i),
  name: `家人${i}`,
  gender: i % 2 ? "female" : "male",
  birthday: {
    calendar: "solar",
    year: 1940 + Math.floor(i / 10) * 5,
    month: 1,
    day: 1,
  },
}));
const relations = Array.from({ length: 89 }, (_, i) => ({
  type: "parent",
  from: String(Math.floor(i / 3)),
  to: String(i + 1),
}));
function median(work, rounds = 15) {
  for (let i = 0; i < 3; i++) work();
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }
  return Number(
    times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(3),
  );
}
const kinshipBefore = median(() =>
  people.map((p) => relationshipFor(people, relations, "20", p.id)),
);
const kinshipAfter = median(() => relationshipsFor(people, relations, "20"));
const db = new DatabaseSync(":memory:");
db.exec(
  "CREATE TABLE documents(collection TEXT,id TEXT,body TEXT,PRIMARY KEY(collection,id)); CREATE INDEX document_circle_order ON documents(collection,json_extract(body,'$.circleId'),id); BEGIN;",
);
const insert = db.prepare("INSERT INTO documents VALUES(?,?,?)");
for (let i = 0; i < 20000; i++)
  insert.run(
    "persons",
    String(i).padStart(5, "0"),
    JSON.stringify({
      id: String(i),
      circleId: `family-${i % 200}`,
      name: `家人${i}`,
    }),
  );
db.exec("COMMIT");
const oldSql =
  "SELECT body FROM documents WHERE collection = ? AND json_extract(body, ?) IS ? ORDER BY id LIMIT 5001";
const { clauses, values } = documentMatchConditions("persons", {
  circleId: "family-50",
});
const newSql = `SELECT body FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT 5001`;
const before = db.prepare(oldSql),
  after = db.prepare(newSql);
const databaseBefore = median(() =>
  before.all("persons", "$.circleId", "family-50"),
);
const databaseAfter = median(() => after.all(...values));
console.log(
  JSON.stringify(
    {
      fixture: {
        people: 100,
        queryDocuments: 20000,
        queryResults: after.all(...values).length,
      },
      kinshipMs: { before: kinshipBefore, after: kinshipAfter },
      queryMs: { before: databaseBefore, after: databaseAfter },
      queryPlan: {
        before: db
          .prepare("EXPLAIN QUERY PLAN " + oldSql)
          .all("persons", "$.circleId", "family-50")
          .map((x) => x.detail),
        after: db
          .prepare("EXPLAIN QUERY PLAN " + newSql)
          .all(...values)
          .map((x) => x.detail),
      },
    },
    null,
    2,
  ),
);
db.close();
