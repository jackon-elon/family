// Local, disposable HTTP load test. No existing database, account or listener is used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { gzipSync } = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://loadtest.invalid';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function worker() {
  const { createApp } = require('../server/app.cjs');
  const { seedScale } = require('./family-scale-fixture.cjs');
  const { passwordHash } = require('../server/auth.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-loadtest-'));
  const env = { ...process.env, NODE_ENV: 'development', DATA_DIR: directory, FRONTEND_ORIGIN: ORIGIN, TRUST_PROXY_HOPS: '1' };
  let app = createApp({ env });
  const fixture = await seedScale(app, env);
  const password = crypto.randomBytes(24).toString('base64url');
  const saved = await passwordHash(password);
  const accounts = Array.from({ length: 50 }, (_, i) => ({ id: `load_member_${i}`, phone: `1389000${String(i).padStart(4, '0')}` }));
  for (const [i, account] of accounts.entries()) {
    await app.store.exclusive(db => db.prepare('INSERT INTO accounts(id,phone,password_hash,created_at) VALUES(?,?,?,?)').run(account.id, `+86${account.phone}`, saved, Date.now()));
    const person = fixture.persons[i < 14 ? i : i + 2];
    await app.store.atomic(async tx => {
      const current = await tx.get('persons', person.id);
      current.claimedBy = account.id;
      await tx.put('persons', current);
      await tx.put('members', {
        id: `${fixture.familyId}_${crypto.createHash('sha256').update(account.id).digest('hex').slice(0, 40)}`,
        circleId: fixture.familyId, userId: account.id, personId: person.id,
        role: 'member', status: 'active', joinedAt: Date.now(),
      });
    });
  }
  await app.close();
  // Use real production auth/cookie behavior after seeding disposable data.
  app = createApp({ env: { ...env, NODE_ENV: 'production' } });
  const address = await app.listen(0, '127.0.0.1');
  let sample, start, cpu, baseline, peak;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  process.send({ ready: true, port: address.port, accounts, password, familyId: fixture.familyId });
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'begin') {
        baseline = process.memoryUsage().rss;
        peak = baseline; start = performance.now(); cpu = process.cpuUsage();
        lag.reset(); lag.enable();
        sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
      } else if (message.command === 'end') {
        clearInterval(sample); lag.disable();
        const usage = process.cpuUsage(cpu), elapsedMs = performance.now() - start;
        peak = Math.max(peak, process.memoryUsage().rss);
        result = {
          elapsedMs, baselineRssMB: baseline / 1048576, peakRssMB: peak / 1048576,
          cpuSingleCorePercent: (usage.user + usage.system) / elapsedMs / 10,
          eventLoopP95Ms: lag.percentile(95) / 1e6, eventLoopMaxMs: lag.max / 1e6,
        };
      } else if (message.command === 'clearLimits') {
        // Only this worker's disposable SQLite file is reachable here.
        await app.store.exclusive(db => db.prepare('DELETE FROM rate_limits').run());
      } else if (message.command === 'stop') {
        clearInterval(sample); await app.close();
        const resolved = fs.realpathSync(directory), tempRoot = fs.realpathSync(os.tmpdir());
        if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('kin-loadtest-')) throw Error('Unsafe fixture cleanup path');
        fs.rmSync(resolved, { recursive: true });
        process.send({ reply: message.id, result: { cleaned: true } });
        process.disconnect();
        return;
      }
      process.send({ reply: message.id, result });
    } catch (error) { process.send({ reply: message.id, error: error.message }); }
  });
}

const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : 0;
async function main() {
  const child = fork(__filename, ['--worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map(); let id = 0, meta;
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message.ready) { meta = message; resolve(message); }
      else {
        const request = pending.get(message.reply);
        if (request) { pending.delete(message.reply); message.error ? request.reject(Error(message.error)) : request.resolve(message.result); }
      }
    });
    child.once('error', reject);
    child.once('exit', code => { if (!meta) reject(Error(`Worker exited ${code}`)); for (const r of pending.values()) r.reject(Error(`Worker exited ${code}`)); });
  });
  const command = command => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); child.send({ id: key, command }); });
  const report = { recordedAt: new Date().toISOString(), hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramGB: os.totalmem() / 1073741824, platform: process.platform, node: process.version }, fixture: { people: 100, generations: 4, cities: 40, distinctMemberAccounts: 50 }, scenarios: [] };
  try {
    await ready;
    const url = `http://127.0.0.1:${meta.port}`;
    let records = null;
    async function request(route, body, cookie, ip = '198.18.0.1', check) {
      const start = performance.now();
      try {
        const response = await fetch(url + route, {
          method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30000),
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const raw = await response.arrayBuffer(), json = JSON.parse(Buffer.from(raw).toString());
        const valid = response.status === 200 && json.ok === true && (!check || check(json.data));
        records?.push({ ms: performance.now() - start, status: response.status, ok: valid, code: json.error?.code || (valid ? '' : 'RESPONSE_MISMATCH'), bytes: raw.byteLength });
        return { status: response.status, json, cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
      } catch (error) {
        records?.push({ ms: performance.now() - start, status: 0, ok: false, code: error.name, bytes: 0 });
        return { status: 0, json: { error: { code: error.name } } };
      }
    }
    const ipFor = i => `198.18.0.${i + 1}`;
    const login = i => request('/api/auth/login', { phone: meta.accounts[i].phone, password: meta.password, remember: true }, undefined, ipFor(i));
    async function scenario(name, work) {
      await command('clearLimits');
      records = [];
      await command('begin');
      const started = performance.now();
      await work();
      const elapsedMs = performance.now() - started, resources = await command('end');
      const statuses = {}, errors = {};
      for (const row of records) { statuses[row.status] = (statuses[row.status] || 0) + 1; if (!row.ok) errors[row.code] = (errors[row.code] || 0) + 1; }
      const success = records.filter(row => row.ok);
      const result = {
        name, requests: records.length, success: success.length, statuses, errors,
        p50Ms: percentile(records.map(x => x.ms), .5), p95Ms: percentile(records.map(x => x.ms), .95), maxMs: Math.max(...records.map(x => x.ms)),
        successP95Ms: percentile(success.map(x => x.ms), .95), elapsedMs, requestsPerSecond: records.length / elapsedMs * 1000,
        responseMB: records.reduce((sum, x) => sum + x.bytes, 0) / 1048576, ...resources,
      };
      report.scenarios.push(result); records = null;
      console.log(JSON.stringify(result));
      const allowed = [];
      if (Object.keys(errors).some(code => !allowed.includes(code))) throw Error(`Unexpected responses in ${name}: ${JSON.stringify(errors)}`);
    }
    const cookies = [];
    // Prepare genuine independent sessions with bounded setup concurrency, outside measurements.
    for (let i = 0; i < 50; i += 3) {
      const group = await Promise.all(meta.accounts.slice(i, i + 3).map((_, offset) => login(i + offset)));
      for (const result of group) { if (!result.cookie || !result.json.ok) throw Error(`Session setup failed: ${JSON.stringify(result.json)}`); cookies.push(result.cookie); }
    }
    const rpc = (i, action, payload = {}, check) => request('/api/rpc', { action, payload }, cookies[i], ipFor(i), check);
    const familyPayload = { circleId: meta.familyId };
    async function visit(i) {
      await Promise.all([request('/api/auth/me', undefined, cookies[i], ipFor(i)), rpc(i, 'circle.list')]);
      await Promise.all([
        rpc(i, 'circle.detail', familyPayload), rpc(i, 'person.list', familyPayload, data => data.persons.length === 100),
        rpc(i, 'relation.list', familyPayload), rpc(i, 'member.list', familyPayload),
        rpc(i, 'person.remark.list', familyPayload), rpc(i, 'birthday.upcoming', { ...familyPayload, days: 30 }),
      ]);
    }
    await scenario('member_browse_30', () => Promise.all(Array.from({ length: 30 }, async (_, i) => { await sleep(i * 20); for (let n = 0; n < 5; n++) { await visit(i); if (n < 4) await sleep(1000); } })));
    await scenario('member_browse_50', () => Promise.all(Array.from({ length: 50 }, async (_, i) => { await sleep(i * 20); for (let n = 0; n < 5; n++) { await visit(i); if (n < 4) await sleep(1000); } })));
    await scenario('member_refresh_burst_50', () => Promise.all(Array.from({ length: 50 }, (_, i) => visit(i))));
    const guests = [];
    for (let i = 0; i < 50; i++) {
      const r = await request('/api/guest/enter', { familyName: '四代百人验收家庭' }, undefined, ipFor(i));
      if (!r.cookie || !r.json.ok) throw Error('Guest setup failed');
      guests.push(r.cookie);
    }
    await scenario('guest_browse_50', () => Promise.all(guests.map(async (cookie, i) => { await sleep(i * 20); for (let n = 0; n < 5; n++) { await request('/api/guest/family', undefined, cookie, ipFor(i), data => data.persons.length === 100); if (n < 4) await sleep(1000); } })));
    await scenario('login_burst_50', () => Promise.all(meta.accounts.map((_, i) => login(i))));
    await scenario('login_burst_50_same_ip', () => Promise.all(meta.accounts.map(account => request('/api/auth/login', { phone: account.phone, password: meta.password, remember: true }, undefined, '198.18.1.1'))));
    await scenario('login_spread_50_over_10_seconds', () => Promise.all(meta.accounts.map(async (_, i) => { await sleep(i * 200); await login(i); })));
    await scenario('guest_entry_50_same_ip', () => Promise.all(meta.accounts.map(() => request('/api/guest/enter', { familyName: '四代百人验收家庭' }, undefined, '198.18.1.1'))));
    const assets = path.join(ROOT, 'frontend/dist/assets');
    report.assets = fs.readdirSync(assets).filter(name => /\.(js|css)$/.test(name)).map(name => {
      const bytes = fs.readFileSync(path.join(assets, name));
      return { name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    });
    report.limitations = [
      'Loopback on the developer PC, not a 2-core/2GB server; API and load generator are separate processes.',
      'Production API configuration and default security limits; trusted-proxy IPs simulate distinct clients on loopback only.',
      'Resource samples cover API process only (20ms RSS samples); CPU percentage uses one logical core = 100%.',
      'This file measures API only. Actual Caddy static-file load is recorded separately in performance-static-loadtest.json; no Docker limit, WAN/TLS or mobile rendering measurement.',
      '100 synthetic people without portraits; photo downloads, uploads and write contention are not covered.',
    ];
    const output = path.join(ROOT, 'docs/performance-loadtest.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${output}`);
  } finally {
    if (child.connected) await command('stop');
  }
}

(process.argv.includes('--worker') ? worker() : main()).catch(error => { console.error(error); process.exitCode = 1; });
