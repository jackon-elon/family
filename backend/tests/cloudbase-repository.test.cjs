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

test('CloudBase explicit-ID reads use small external queries and never document transaction reads or a full table scan', async () => {
  const queries = [];
  const ids = Array.from({length: 101}, (_, index) => `profile-${index}`);
  const db = {
    command: {in: values => ({values})},
    startTransaction: async () => ({
      collection() {throw new Error('bulk reads must not use transaction doc operations');},
      commit: async () => {}, rollback: async () => {}
    }),
    collection: collection => ({where: condition => {
      const batch = condition._id.values;
      assert.ok(batch.length > 0 && batch.length <= 20);
      queries.push({collection, batch});
      return {limit: limit => {
        assert.equal(limit, batch.length);
        return {get: async () => ({data: [...batch.map(id => ({id, userId: id})), {id: 'outside-request', userId: 'other'}]})};
      }};
    }})
  };
  const repo = new CloudBaseRepository(db);
  const rows = await repo.atomic(tx => tx.findByIds('userProfiles', [...ids, ids[0]]));
  assert.equal(queries.length, 6);
  assert.equal(rows.length, 101);
  assert.deepEqual(rows.map(row => row.id), ids);
  assert.deepEqual(await repo.atomic(tx => tx.findByIds('userProfiles', [])), []);
  await assert.rejects(repo.atomic(tx => tx.findByIds('userProfiles', Array.from({length: 5001}, (_, i) => String(i)))), QueryResultLimitError);
});
