const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const mod = {exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(require.resolve('./contact.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod,mod.exports);
const {phoneLink}=mod.exports;
test('phone links support domestic and formatted international numbers',()=>{
  assert.equal(phoneLink('13800000000'),'tel:13800000000');
  assert.equal(phoneLink('+44 (7700) 900-123'),'tel:+447700900123');
});
test('phone links never turn dial codes or untrusted schemes into call actions',()=>{
  for(const value of [undefined,'','*123#','javascript:alert(1)','tel:13800000000','13800000000;123','123','+1234567890123456']) assert.equal(phoneLink(value),undefined);
});
