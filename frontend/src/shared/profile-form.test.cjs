const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const cache = new Map();
function loadTs(file) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved);
  const module = { exports: {} };
  cache.set(resolved, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  new Function("require", "module", "exports", compiled)(
    (name) => {
      // These imports serve the rendered form, not its exported validation.
      // Keep the actual lunar conversion module and its data in the test.
      if (
        [
          "./PhotoPicker",
          "./GeoFields",
          "./UI",
          "../api",
          "lucide-react",
        ].includes(name)
      )
        return {};
      return name.startsWith(".")
        ? loadTs(path.resolve(path.dirname(resolved), `${name}.ts`))
        : require(name);
    },
    module,
    module.exports,
  );
  return module.exports;
}

const { patchOf, draftOf, birthdayDaysInMonth, createFields } = loadTs(
  path.resolve(__dirname, "../components/ProfileForm.tsx"),
);
const base = {
  ...draftOf(),
  name: "生日验收",
  phone: "13800000001",
  country: "中国",
  city: "上海",
  calendar: "solar",
  year: "",
  month: "2",
  day: "29",
};

test("first profile requires a real city and birthday before submission", () => {
  for (const change of [
    { city: "" },
    { city: "   " },
    { country: "  " },
    { month: "" },
    { day: "" },
  ])
    assert.throws(() => patchOf({ ...base, ...change }));
  assert.equal(patchOf({ ...base, city: " 上海 " }).city, "上海");
});

test("solar leap birthdays distinguish a known birth year from an annual date", () => {
  assert.deepEqual(patchOf(base).birthday, {
    calendar: "solar",
    month: 2,
    day: 29,
  });
  assert.equal(patchOf({ ...base, year: "2000" }).birthday.day, 29);
  for (const change of [
    { year: "1900" },
    { year: "2025" },
    { month: "4", day: "31" },
    { year: "2025.5" },
  ])
    assert.throws(() => patchOf({ ...base, ...change }));
});

test("known lunar years reject nonexistent leap months and day thirty in short months", () => {
  const lunar = { ...base, calendar: "lunar" };
  assert.throws(() =>
    patchOf({ ...lunar, year: "2024", month: "1", day: "1", leapMonth: true }),
  );
  assert.throws(() =>
    patchOf({ ...lunar, year: "2024", month: "1", day: "30" }),
  );
  assert.throws(() =>
    patchOf({ ...lunar, year: "2023", month: "2", day: "30", leapMonth: true }),
  );
  assert.deepEqual(
    patchOf({ ...lunar, year: "2023", month: "2", day: "29", leapMonth: true })
      .birthday,
    { calendar: "lunar", year: 2023, month: 2, day: 29, leapMonth: true },
  );
});

test("birthday day choices use the actual solar and lunar month lengths", () => {
  assert.equal(birthdayDaysInMonth({ ...base, year: "2025" }), 28);
  assert.equal(birthdayDaysInMonth({ ...base, year: "2000" }), 29);
  const lunar = { ...base, calendar: "lunar", year: "2024" };
  assert.equal(birthdayDaysInMonth({ ...lunar, month: "1" }), 29);
  assert.equal(birthdayDaysInMonth({ ...lunar, month: "2" }), 30);
  assert.equal(
    birthdayDaysInMonth({
      ...lunar,
      year: "2023",
      month: "2",
      leapMonth: true,
    }),
    29,
  );
});

test("yearless annual lunar birthdays and partially covered 1900 dates remain recordable", () => {
  assert.deepEqual(
    patchOf({
      ...base,
      calendar: "lunar",
      month: "2",
      day: "30",
      leapMonth: true,
    }).birthday,
    { calendar: "lunar", month: 2, day: 30, leapMonth: true },
  );
  assert.equal(
    patchOf({ ...base, calendar: "lunar", year: "1900", month: "1", day: "15" })
      .birthday.year,
    1900,
  );
});

test("new family records include a valid account-compatible phone in the first create request", () => {
  for (const phone of [
    "",
    " ",
    "12345",
    "12800000000",
    "+8602112345678",
    "13800000000 ext3",
  ])
    assert.throws(() => createFields({ ...base, phone }), /手机号/);
  assert.equal(
    createFields({ ...base, phone: "138 0000 0001" }).phone,
    "+8613800000001",
  );
  assert.equal(
    createFields({ ...base, phone: "+1 (202) 555-0100" }).phone,
    "+12025550100",
  );
});

test("every profile edit requires a valid phone and no longer submits a nickname", () => {
  for (const phone of ["", " ", "020-12345678", "12345"])
    assert.throws(() => patchOf({ ...base, phone }), /手机号/);
  assert.equal(patchOf(base).phone, "+8613800000001");
  assert.equal(
    patchOf({ ...base, phone: "+1 (202) 555-0100" }).phone,
    "+12025550100",
  );
  assert.equal("nickname" in draftOf({ nickname: "旧昵称" }), false);
  assert.equal("nickname" in patchOf(base), false);
  assert.equal("nickname" in createFields(base), false);
});
