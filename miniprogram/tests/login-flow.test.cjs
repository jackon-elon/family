const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('invite login follows the active cloud mode and returns to the invitation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../pages/login/index.ts'), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  let definition;
  let demo = true;
  const calls = [];
  const destinations = [];
  vm.runInNewContext(output, {
    exports: {}, module: {exports: {}},
    require: name => {
      assert.equal(name, '../../services/api');
      return {
        isDemoMode: () => demo,
        showApiError: () => undefined,
        invoke: async request => {
          calls.push(request);
          return request.action === 'account.sync' ? {ok: true, data: {hasVerifiedPhone: false}} : {ok: true, data: {hasVerifiedPhone: true}};
        }
      };
    },
    Page: page => {definition = page;},
    wx: {reLaunch: options => destinations.push(options.url), switchTab: options => destinations.push(options.url)},
    decodeURIComponent
  });
  const page = {...definition, data: {...definition.data}, setData(patch) {Object.assign(this.data, patch);}};
  assert.equal(page.data.demo, true);
  demo = false; // The invitation switched from local preview to a real cloud record.
  page.onLoad({next: encodeURIComponent('/pages/apply/index?token=abc%2Fdef')});
  await page.onShow();
  assert.equal(page.data.demo, false);
  assert.equal(page.data.loading, false);
  await page.verify('real-wechat-code');
  assert.equal(calls.at(-1).payload.code, 'real-wechat-code');
  assert.deepEqual(destinations, ['/pages/apply/index?token=abc%2Fdef']);
  const person = {...definition, data: {...definition.data}, setData(patch) {Object.assign(this.data, patch);}};
  person.onLoad({next: '/pages/person/index?circleId=c%26one&personId=p%26name'});
  person.enter();
  assert.equal(destinations.at(-1), '/pages/person/index?circleId=c%26one&personId=p%26name');
  const ownCard = {...definition, data: {...definition.data}, setData(patch) {Object.assign(this.data, patch);}};
  ownCard.onLoad({next: '/pages/profile/index?circleId=c%26one&purpose=self'});
  ownCard.enter();
  assert.equal(destinations.at(-1), '/pages/profile/index?circleId=c%26one&purpose=self');
});
