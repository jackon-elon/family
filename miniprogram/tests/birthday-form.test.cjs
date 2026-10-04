const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, filename);
};

const {birthdayDayOptions, birthdayDayIndex} = require('../utils/birthday-form.ts');

test('birthday picker only offers existing days for the chosen calendar, month and year', () => {
  assert.equal(birthdayDayOptions(0, 3, '').length, 30);
  assert.equal(birthdayDayOptions(0, 1, '').length, 29);
  assert.equal(birthdayDayOptions(0, 1, '2025').length, 28);
  assert.equal(birthdayDayOptions(0, 1, '2024').length, 29);
  assert.equal(birthdayDayOptions(0, 0, '2025').length, 31);
  assert.equal(birthdayDayOptions(1, 0, '2025').length, 30);
  assert.equal(birthdayDayIndex(30, birthdayDayOptions(0, 3, '')), -1);
  assert.equal(birthdayDayIndex(28, birthdayDayOptions(0, 1, '2025')), -1);
  assert.equal(birthdayDayIndex(27, birthdayDayOptions(0, 1, '2025')), 27);
});
