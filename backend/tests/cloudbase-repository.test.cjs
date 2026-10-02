const test = require('node:test');
const assert = require('node:assert/strict');
const {CloudBaseRepository} = require('../dist/cloudbase-repository.js');
const {QueryResultLimitError} = require('../dist/repository.js');
const {ApiService} = require('../dist/service.js');

function databaseWithRows(count) {
  const rows = Array.from({length: count}, (_, i) => ({id: String(i), userId: 'reader'}));
  return {
    startTransaction: async () => ({commit: async () => {}, rollback: async () => {}}),
    collection: () => ({where: () => ({orderBy: () => ({skip: offset => ({
      limit: limit => ({get: async () => ({data: rows.slice(offset, offset + limit)})})
    })})})})
  };
}

test('CloudBase 查询完整返回上限内结果，超过上限时明确失败', async () => {
  const within = new CloudBaseRepository(databaseWithRows(5000));
  const rows = await within.atomic(tx => tx.find('applications', {userId: 'reader'}));
  assert.equal(rows.length, 5000);

  const beyond = new CloudBaseRepository(databaseWithRows(5001));
  await assert.rejects(
    beyond.atomic(tx => tx.find('applications', {userId: 'reader'})),
    error => error instanceof QueryResultLimitError && error.collection === 'applications'
  );
  const response = await new ApiService(beyond).invoke({action: 'join.mine'}, 'reader');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'DATA_LIMIT');
});
