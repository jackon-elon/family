const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createApp } = require("../app.cjs");
const { seedScale } = require("../../scripts/family-scale-fixture.cjs");
const ts = require("typescript");
const syncFs = require("node:fs");
const modules = new Map();
function pureModule(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file).exports;
  const mod = { exports: {} };
  modules.set(file, mod);
  const compiled = ts.transpileModule(syncFs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", compiled)(
    (name) =>
      name.startsWith(".")
        ? pureModule(path.resolve(path.dirname(file), name) + ".ts")
        : require(name),
    mod,
    mod.exports,
  );
  return mod.exports;
}

test("four generations and 100 relatives survive relation changes, role checks, and guest browsing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kin-scale-test-"));
  const env = { DATA_DIR: directory, FRONTEND_ORIGIN: "http://localhost:5173" };
  let clock = Date.parse("2026-10-04T04:00:00Z");
  const app = createApp({ env, now: () => clock });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const meta = await seedScale(app, env, clock);
  const address = await app.listen(0);
  const request = async (route, body, cookie) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/${route}`, {
      method: "POST",
      headers: {
        Origin: env.FRONTEND_ORIGIN,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      json: await res.json(),
      cookie: res.headers.getSetCookie()[0]?.split(";")[0],
      status: res.status,
    };
  };
  const login = async (phone) => {
    const r = await request("auth/login", { phone, password: meta.password });
    assert.equal(r.json.ok, true);
    return r.cookie;
  };
  const owner = await login(meta.ownerPhone),
    member = await login(meta.memberPhone);
  const rpc = async (action, payload, cookie = owner) =>
    (
      await request(
        "rpc",
        { action, payload: { circleId: meta.familyId, ...payload } },
        cookie,
      )
    ).json;
  const ok = async (action, payload, cookie) => {
    const r = await rpc(action, payload, cookie);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.data;
  };
  const list = () => ok("person.list", {});
  const relations = async () => (await ok("relation.list", {})).relations;
  const ids = meta.persons.map((p) => p.id);
  await t.test(
    "100 graph nodes retain four generations, ten disconnected records and all map counts",
    async () => {
      const people = (await list()).persons,
        edges = await relations();
      const { buildStarLayout } = pureModule(
        path.join(__dirname, "../../frontend/src/shared/family-layout.ts"),
      );
      const { citySummary } = pureModule(
        path.join(__dirname, "../../frontend/src/shared/geography.ts"),
      );
      const { clusterCityMarkers } = pureModule(
        path.join(__dirname, "../../frontend/src/shared/map-clusters.ts"),
      );
      const { relationshipFor } = pureModule(
        path.join(__dirname, "../../frontend/src/shared/relationship.ts"),
      );
      const start = performance.now();
      const labels = Object.fromEntries(
        people.map((p) => [
          p.id,
          relationshipFor(people, edges, ids[14], p.id).label,
        ]),
      );
      const graph = buildStarLayout(
        people,
        edges,
        ids[14],
        ids[14],
        labels,
        "",
      );
      t.diagnostic(
        `100 kinship labels + layout: ${Math.round(performance.now() - start)}ms on test host`,
      );
      assert.equal(graph.nodes.length, 100);
      assert.equal(graph.hiddenCount, 0);
      assert.equal(graph.conflictCount, 0);
      assert.equal(graph.nodes.filter((n) => n.generation === null).length, 10);
      assert.equal(
        new Set(
          graph.nodes
            .filter((n) => n.generation !== null)
            .map((n) => n.generation),
        ).size,
        4,
      );
      for (const edge of edges) {
        const a = graph.nodes.find((n) => n.id === edge.from),
          b = graph.nodes.find((n) => n.id === edge.to);
        if (edge.type === "parent") assert.ok(a.y < b.y);
        if (edge.type === "spouse") assert.equal(a.y, b.y);
      }
      const summary = citySummary(people);
      assert.equal(summary.total, 100);
      assert.equal(
        summary.domestic + summary.overseas + summary.unlocated,
        100,
      );
      assert.ok(summary.groups.filter((g) => g.city).length >= 39);
      assert.equal(
        summary.groups.reduce((n, g) => n + g.people.length, 0),
        100,
      );
      const clusters = clusterCityMarkers(summary.groups, (p) => ({
        x: p.longitude * 3,
        y: p.latitude * 3,
      }));
      assert.equal(
        clusters.reduce((n, c) => n + c.count, 0),
        100 - summary.unlocated,
      );
      for (let i = 0; i < clusters.length; i++)
        for (let j = i + 1; j < clusters.length; j++)
          assert.ok(
            Math.abs(clusters[i].x - clusters[j].x) >= 120 ||
              Math.abs(clusters[i].y - clusters[j].y) >= 44,
          );
    },
  );
  await t.test(
    "owner/member/guest retain all 100 people and exclude only own birthday",
    async () => {
      assert.equal((await list()).persons.length, 100);
      assert.equal((await ok("person.list", {}, member)).persons.length, 100);
      const upcoming = await ok("birthday.upcoming", { days: 30 });
      assert.ok(upcoming.events.length > 30);
      assert.ok(!upcoming.events.some((e) => e.personId === ids[14]));
      assert.ok(upcoming.events.some((e) => e.birthdayCalendar === "lunar"));
      assert.ok(upcoming.serverTime < upcoming.refreshAt);
      assert.equal(new Date(upcoming.refreshAt).getUTCHours(), 16);
      const entered = await request("guest/enter", {
        familyName: "四代百人验收家庭",
      });
      assert.equal(entered.json.ok, true, JSON.stringify(entered.json));
      const family = await fetch(
        `http://127.0.0.1:${address.port}/api/guest/family`,
        { headers: { Cookie: entered.cookie } },
      ).then((r) => r.json());
      assert.equal(family.ok, true, JSON.stringify(family));
      assert.equal(family.data.persons.length, 100);
      assert.equal(family.data.family.personCount, 100);
      assert.ok(upcoming.events.some(event => event.personId === ids[99]), "a missing city must not hide an otherwise valid birthday");
      assert.deepEqual(upcoming.events.map(event => event.personId).sort(), family.data.birthdays.events.filter(event => event.personId !== ids[14]).map(event => event.personId).sort());
      const denied = await rpc(
        "relation.create",
        { from: ids[0], to: ids[90], type: "parent" },
        entered.cookie,
      );
      assert.equal(denied.ok, false);
    },
  );
  await t.test(
    "pending people remain independent until connected; edits and deletes update the same node",
    async () => {
      assert.ok(
        !(await relations()).some(
          (r) => r.from === ids[90] || r.to === ids[90],
        ),
      );
      const edge = (
        await ok("relation.create", {
          from: ids[14],
          to: ids[90],
          type: "parent",
        })
      ).relation;
      assert.ok((await relations()).some((r) => r.id === edge.id));
      const changed = (
        await ok("relation.replace", {
          relationId: edge.id,
          relation: { from: ids[16], to: ids[90], type: "parent" },
        })
      ).relation;
      assert.ok(
        !(await relations()).some(
          (r) => r.from === ids[14] && r.to === ids[90],
        ),
      );
      await ok("relation.delete", { relationId: changed.id });
      assert.ok(
        !(await relations()).some(
          (r) => r.from === ids[90] || r.to === ids[90],
        ),
      );
      assert.equal((await list()).persons.length, 100);
    },
  );
  await t.test(
    "invalid relationship edits are atomic; no self links, ancestor cycles, or missing targets",
    async () => {
      const before = await relations();
      for (const payload of [
        { from: ids[0], to: ids[0], type: "parent" },
        { from: ids[50], to: ids[0], type: "parent" },
        { from: ids[0], to: "missing-person", type: "parent" },
      ])
        assert.equal((await rpc("relation.create", payload)).ok, false);
      const existing = before.find((r) => r.type === "parent");
      assert.equal(
        (
          await rpc("relation.replace", {
            relationId: existing.id,
            relation: { from: ids[0], to: ids[0], type: "parent" },
          })
        ).ok,
        false,
      );
      assert.deepEqual(await relations(), before);
      const duplicate = await rpc("relation.create", {
        from: existing.from,
        to: existing.to,
        type: existing.type,
      });
      assert.equal((await relations()).length, before.length);
    },
  );
  await t.test(
    "ordinary member cannot change family relationships or someone else data",
    async () => {
      assert.equal(
        (
          await rpc(
            "relation.create",
            { from: ids[14], to: ids[91], type: "parent" },
            member,
          )
        ).ok,
        false,
      );
      assert.equal(
        (
          await rpc(
            "person.update",
            { personId: ids[0], patch: { name: "非法改名" } },
            member,
          )
        ).ok,
        false,
      );
      await ok(
        "person.remark.update",
        { personId: ids[0], remark: "我家的长辈" },
        member,
      );
      const adminRemarks = await ok("person.remark.list", {});
      assert.equal(adminRemarks.remarks[ids[0]], undefined);
    },
  );
  await t.test(
    "same names and missing city do not merge people or lose records",
    async () => {
      const persons = (await list()).persons;
      assert.equal(persons.filter((p) => p.name === "李同名").length, 2);
      assert.equal(new Set(persons.map((p) => p.id)).size, 100);
      assert.ok(persons.some((p) => !p.city));
      const bad = await rpc("person.create", {
        name: "重复号码",
        phone: persons[0].phone,
        country: "中国",
        city: "杭州",
        birthday: { calendar: "solar", month: 1, day: 1 },
        deferRelation: true,
      });
      assert.equal(bad.ok, false);
      assert.equal((await list()).persons.length, 100);
    },
  );
  await t.test("birthdays advance with the Beijing date and return the next refresh deadline", async () => {
    clock = Date.parse("2026-10-04T16:00:01Z");
    const next = await ok("birthday.upcoming", { days: 30 });
    assert.equal(next.asOf, "2026-10-05");
    assert.equal(next.refreshAt, Date.parse("2026-10-05T16:00:00Z"));
    assert.ok(next.events.every(event => event.date >= next.asOf));
    assert.ok(next.events.some(event => event.date === "2026-10-05" && event.daysUntil === 0));
  });
});
