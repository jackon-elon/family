const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018
  }}).outputText, filename);
};

const {lunarForGregorian} = require('../utils/lunar-calendar.ts');
const {BirthdayCalendar} = require('../utils/birthday-calendar.ts');

test('mini program and backend use the same official lunar month table', () => {
  const frontend = fs.readFileSync(path.join(__dirname,'../utils/lunar-calendar.ts'),'utf8');
  const backend = fs.readFileSync(path.join(__dirname,'../../backend/src/lunar-calendar.ts'),'utf8');
  assert.equal(frontend,backend);
  assert.deepEqual(lunarForGregorian('2027-02-06'),{year:2027,month:1,day:1,leapMonth:false});
  assert.deepEqual(lunarForGregorian('2025-07-25'),{year:2025,month:6,day:1,leapMonth:true});
});

test('mini program converts the same lunar birthday anew each year', () => {
  const birthday = {calendar:'lunar',month:1,day:1};
  assert.equal(new BirthdayCalendar(Date.UTC(2026,1,16,12),3,true).next(birthday).date,'2026-02-17');
  assert.equal(new BirthdayCalendar(Date.UTC(2027,1,5,12),3,true).next(birthday).date,'2027-02-06');
  assert.equal(new BirthdayCalendar(Date.UTC(2027,1,5,17),0,true).next(birthday).daysUntil,0);
});
