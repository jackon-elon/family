const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MemoryRouter } = require("react-router-dom");

// Exercise the real display components; effects and network calls must not be
// needed to render an already loaded guest snapshot.
const cache = new Map();
function load(file) {
  const resolved = path.resolve(__dirname, file);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const subject = { exports: {} };
  cache.set(resolved, subject);
  const compiled = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (name) => {
    if (name.endsWith(".css")) return {};
    if (["./Manage", "./components/ProfileForm"].includes(name)) return {};
    if (name === "./api" || name === "./hooks")
      return new Proxy(
        {},
        {
          get: () => () => {
            throw Error("Protected API called by guest rendering");
          },
        },
      );
    if (name === "./shared/relationship")
      return {
        relationshipFor: () => {
          throw Error("Guest has no member perspective");
        },
      };
    if (!name.startsWith(".")) return require(name);
    const base = path.resolve(path.dirname(resolved), name);
    for (const suffix of ["", ".ts", ".tsx"]) {
      if (fs.existsSync(base + suffix) && fs.statSync(base + suffix).isFile())
        return load(base + suffix);
    }
    throw Error(`Missing test import ${name}`);
  };
  new Function("require", "module", "exports", compiled)(
    localRequire,
    subject,
    subject.exports,
  );
  return subject.exports;
}
const { guestBrowseData } = load("guest-view.ts");
const {
  Auth,
  FamilyAlbum,
  PersonDetail,
  InvitationHome,
  ManagementAccess,
  GuestBirthdayList,
} = load("../App.tsx");
const render = (component, route = "/guest") =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: [route] }, component),
  );
const person = {
  id: "relative",
  circleId: "family-a",
  name: "张青",
  gender: "female",
  country: "中国",
  province: "四川",
  city: "成都",
  latitude: 30.6,
  longitude: 104.1,
  birthday: { calendar: "lunar", year: 1990, month: 6, day: 12 },
  phone: "13800000001",
  wechatId: "qing-test",
  occupation: "教师",
  bio: "最近在读书",
  photoUrl: "/api/guest/photos?personId=relative",
  isSelf: true,
};
const snapshot = {
  family: {
    id: "family-a",
    name: "张家",
    type: "family",
    personCount: 2,
    ownerId: "hidden",
  },
  persons: [
    person,
    { id: "child", circleId: "family-a", name: "张小青", city: "成都" },
  ],
  relations: [
    { id: "relation", from: "relative", to: "child", type: "parent" },
  ],
  expiresAt: 9999999999999,
  remarks: { relative: "只属于管理员的备注" },
  ownerTransfer: { isTarget: true },
};

const birthdays = {
  asOf: "2026-06-01",
  refreshAt: Date.parse("2026-06-02T00:00:00+08:00"),
  events: [
    {
      personId: "relative",
      personName: "张青",
      circleId: "family-a",
      circleName: "张家",
      date: "2026-06-01",
      daysUntil: 0,
      birthdayCalendar: "solar",
      birthdayText: "阳历6月1日",
    },
    {
      personId: "child",
      personName: "张小青",
      circleId: "family-a",
      circleName: "张家",
      date: "2026-06-19",
      daysUntil: 18,
      birthdayCalendar: "lunar",
      birthdayText: "农历5月5日",
    },
  ],
};

test("guest birthdays render once above the family browser, with dates, today emphasis and no automatically opened detail", () => {
  const html = render(
    React.createElement(FamilyAlbum, {
      circleId: "family-a",
      data: guestBrowseData(snapshot),
      error: "",
      loading: false,
      load() {},
      readOnly: true,
      birthdays,
    }),
  );
  assert.equal((html.match(/aria-label="近期生日"/g) || []).length, 1);
  for (const text of [
    "今天生日",
    "is-today",
    "18 天后",
    "2026年6月1日",
    "农历5月5日",
    "本次公历：2026年6月19日",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(
    html.indexOf('aria-label="近期生日"') <
      html.indexOf('class="browse-toolbar"'),
  );
  assert.ok(!html.includes("近况与联系"));
  assert.ok(!html.includes("设置备注"));
});

test("a stale China-day reminder is hidden, but partial calendar failures keep valid solar reminders", () => {
  const stale = render(
    React.createElement(GuestBirthdayList, {
      birthdays,
      stale: true,
      onSelect() {},
      onRetry() {},
    }),
  );
  assert.ok(stale.includes("日期已变化"));
  assert.ok(stale.includes("刷新生日"));
  assert.ok(!stale.includes("今天生日"));
  assert.ok(!stale.includes("暂无家人生日"));
  const partial = render(
    React.createElement(GuestBirthdayList, {
      birthdays: {
        ...birthdays,
        events: [birthdays.events[0]],
        error: "部分生日暂时无法换算，请稍后刷新。",
      },
      stale: false,
      onSelect() {},
      onRetry() {},
    }),
  );
  assert.ok(partial.includes("部分生日暂时无法换算"));
  assert.ok(partial.includes("今天生日"));
  assert.ok(!partial.includes("暂无家人生日"));
});

test("many birthdays stay compact while all members remain available through an explicit expansion", () => {
  const events = Array.from({ length: 8 }, (_, i) => ({
    ...birthdays.events[0],
    personId: `person-${i}`,
    personName: `家人${i}`,
  }));
  const html = render(
    React.createElement(GuestBirthdayList, {
      birthdays: { ...birthdays, events },
      stale: false,
      onSelect() {},
      onRetry() {},
    }),
  );
  assert.equal((html.match(/class="birthday-item/g) || []).length, 3);
  assert.ok(html.includes("还有 5 位家人，展开看看"));
});

test("legacy guest snapshots lacking birthdays still render the entire family and navigation", () => {
  const html = render(
    React.createElement(FamilyAlbum, {
      circleId: "family-a",
      data: guestBrowseData(snapshot),
      error: "",
      loading: false,
      load() {},
      readOnly: true,
    }),
  );
  assert.ok(html.includes("张青"));
  assert.ok(html.includes("家人簿"));
  assert.ok(!html.includes('aria-label="近期生日"'));
});

test("guest snapshot keeps all family members and photos without creating a current member or private state", () => {
  const data = guestBrowseData(snapshot);
  assert.equal(data.people.length, snapshot.family.personCount);
  assert.equal(data.people[0].phone, person.phone);
  assert.equal(data.people[0].photoUrl, person.photoUrl);
  assert.deepEqual(data.people[0].birthday, person.birthday);
  assert.ok(data.people.every((entry) => entry.isSelf === false));
  assert.deepEqual(data.circle, { id: "family-a", name: "张家" });
  assert.deepEqual(data.remarks, {});
  assert.equal(data.ownerTransfer, undefined);
  assert.equal(data.members, undefined);
});

test("guest full profile shows contact and complete birthday with no editing, remark or self controls", () => {
  const html = render(
    React.createElement(PersonDetail, {
      person,
      circleId: "family-a",
      remark: "只属于管理员的备注",
      readOnly: true,
      onClose() {},
      onRemark() {
        throw Error("Guest remark callback");
      },
    }),
  );
  for (const content of [
    "13800000001",
    "qing-test",
    "1990年6月12日",
    "教师",
    "最近在读书",
  ])
    assert.ok(html.includes(content), content);
  for (const hidden of [
    "只属于管理员的备注",
    "设置备注",
    "修改我的资料",
    "self-tag",
    'href="/me"',
  ])
    assert.ok(!html.includes(hidden), hidden);
});

test("authenticated profile rendering retains its own edit entry and personal remark", () => {
  const own = render(
    React.createElement(PersonDetail, {
      person,
      circleId: "family-a",
      remark: "",
      onClose() {},
      onRemark() {},
    }),
  );
  assert.ok(own.includes("修改我的资料"));
  assert.ok(own.includes("self-tag"));
  const other = render(
    React.createElement(PersonDetail, {
      person: { ...person, isSelf: false },
      circleId: "family-a",
      remark: "我的阿姨",
      onClose() {},
      onRemark() {},
    }),
  );
  assert.ok(other.includes("我的阿姨"));
  assert.ok(other.includes("设置备注"));
});

test("guest graph has all people but no self perspective or management handoff even with stale member fields", () => {
  const data = {
    ...guestBrowseData(snapshot),
    people: snapshot.persons,
    remarks: snapshot.remarks,
    ownerTransfer: snapshot.ownerTransfer,
  };
  const html = render(
    React.createElement(FamilyAlbum, {
      circleId: "family-a",
      data,
      error: "",
      loading: false,
      load() {},
      readOnly: true,
    }),
  );
  for (const content of ["张青", "张小青", "亲缘图", "家人簿", "天南海北"])
    assert.ok(html.includes(content), content);
  for (const hidden of [
    "只属于管理员的备注",
    "我的同辈",
    "找到我",
    "前往我的处理",
    "self-tag",
  ])
    assert.ok(!html.includes(hidden), hidden);
});

test("guest person deep links never open people outside the loaded family", () => {
  const html = render(
    React.createElement(FamilyAlbum, {
      circleId: "family-a",
      data: guestBrowseData(snapshot),
      error: "",
      loading: false,
      load() {},
      readOnly: true,
    }),
    "/guest?person=person-from-another-family",
  );
  assert.ok(!html.includes("近况与联系"));
  assert.ok(!html.includes("设置备注"));
});

test("public entry defaults to family-name browsing and offers account login without open registration", () => {
  const html = render(
    React.createElement(Auth, {
      onSuccess() {},
      onGuest() {},
      initialError: "",
    }),
    "/",
  );
  for (const content of ["游客看看", "账号登录", "家庭名称", "进去看看"])
    assert.ok(html.includes(content), content);
  assert.ok(!html.includes("创建账号"));
  assert.ok(!html.includes('type="password"'));
});

test("an invitation stays on account login instead of being replaced by guest entry", () => {
  const html = render(
    React.createElement(Auth, {
      onSuccess() {},
      onGuest() {},
      initialError: "",
    }),
    "/invite/token-value",
  );
  assert.ok(html.includes("有人邀请你相聚"));
  assert.ok(html.includes('type="password"'));
  assert.ok(!html.includes("进去看看"));
});

test("an invited account that has not applied sees a next step instead of an empty family directory", () => {
  const html = render(
    React.createElement(InvitationHome, {
      invitation: {
        id: "invite-id",
        circleId: "family-a",
        circleName: "张家",
        status: "profile-required",
        expiresAt: 9999999999999,
      },
      async refresh() {},
    }),
    "/",
  );
  for (const content of [
    "继续与家人相聚",
    "张家",
    "原邀请链接",
    "查看我的资料",
    'href="/me"',
  ])
    assert.ok(html.includes(content), content);
  for (const hidden of [
    "我的亲友录",
    "近期生日",
    'href="/invite/invite-id"',
    "等待管理员邀请",
  ])
    assert.ok(!html.includes(hidden), hidden);
});

test("an applicant awaiting approval sees its real status and can refresh without pretending to be a member", () => {
  const html = render(
    React.createElement(InvitationHome, {
      invitation: {
        id: "invite-id",
        circleId: "family-a",
        circleName: "张家",
        status: "pending",
        expiresAt: 9999999999999,
      },
      async refresh() {},
    }),
    "/",
  );
  for (const content of [
    "等待家人确认",
    "申请已送达",
    "刷新加入状态",
    "查看我的资料与申请",
  ])
    assert.ok(html.includes(content), content);
  for (const hidden of [
    "重新打开",
    "我的亲友录",
    'href="/album/family-a"',
    "近期生日",
  ])
    assert.ok(!html.includes(hidden), hidden);
});

test("management content is unmounted after a confirmed downgrade or loss of family membership", () => {
  for (const role of ["owner", "admin", "member", undefined]) {
    const html = render(
      React.createElement(ManagementAccess, {
        role,
        loading: false,
        error: "",
        children: React.createElement("div", null, "私有管理操作与邀请二维码"),
      }),
      "/manage/family-a",
    );
    assert.equal(
      html.includes("私有管理操作与邀请二维码"),
      role === "owner" || role === "admin",
    );
    assert.equal(
      html.includes("此页面仅供管理员使用"),
      role !== "owner" && role !== "admin",
    );
  }
  const loading = render(
    React.createElement(ManagementAccess, {
      loading: true,
      error: "",
      children: "尚未确认的管理操作",
    }),
  );
  assert.ok(loading.includes("正在确认管理权限"));
  assert.ok(!loading.includes("尚未确认的管理操作"));
});
