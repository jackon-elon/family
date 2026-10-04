import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Exercise exactly the dependency-free runtime folders copied into the API image.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "kin-deploy-check-"));
try {
  await mkdir(path.join(temporary, "backend"), { recursive: true });
  await cp(
    path.join(root, "backend/dist"),
    path.join(temporary, "backend/dist"),
    { recursive: true },
  );
  await cp(path.join(root, "server"), path.join(temporary, "server"), {
    recursive: true,
    filter: (source) =>
      !["data", "tests"].includes(
        path.relative(path.join(root, "server"), source).split(path.sep)[0],
      ),
  });
  const script = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { createApp } = require('./server/app.cjs');
    const { setupFamily } = require('./server/setup.cjs');
    (async () => {
      const env = {
        NODE_ENV: 'production', DATA_DIR: path.resolve('runtime-data'),
        FRONTEND_ORIGIN: 'https://kin.example.com'
      };
      const initialized = await setupFamily({ env, phone: '13912345678', password: 'TemporaryTest2026!', familyName: '部署验收家庭' });
      const app = createApp({ env });
      try {
        const address = await app.listen(0, '127.0.0.1');
        const url = 'http://127.0.0.1:' + address.port;
        const health = await fetch(url + '/api/health');
        assert.equal(health.status, 200);
        assert.equal((await health.json()).data.storage, 'sqlite');
        const registration = await fetch(url + '/api/auth/register', {
          method: 'POST', headers: { Origin: 'https://kin.example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({phone:'13912345679',password:'TemporaryTest2026!'})
        });
        assert.equal((await registration.json()).ok, false);
        assert.equal(registration.headers.get('set-cookie'), null);
        const login = await fetch(url + '/api/auth/login', {
          method: 'POST', headers: { Origin: 'https://kin.example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({phone:'13912345678',password:'TemporaryTest2026!',remember:true})
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Host-kin_session='));
        assert.match(cookie, /__Host-kin_session=.*; HttpOnly; SameSite=Lax;.*; Secure/);
        assert.match(cookie, /Max-Age=7776000/);
        const adminUser = (await login.json()).data.user;
        assert.equal(adminUser.phoneVerified, false);
        assert.equal(adminUser.access, 'member');
        await app.store.exclusive(db => {
          const saved = db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(initialized.accountId);
          db.prepare('INSERT INTO accounts VALUES(?, ?, ?, ?)').run('web_deploy_uninvited', '+8613912345677', saved.password_hash, Date.now());
        });
        const uninvited = await fetch(url + '/api/auth/login', {
          method: 'POST', headers: { Origin: 'https://kin.example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({phone:'13912345677',password:'TemporaryTest2026!'})
        });
        assert.equal(uninvited.status, 403);
        assert.equal((await uninvited.json()).error.code, 'ACCOUNT_NOT_INVITED');
        assert.equal(await app.store.exclusive(db => db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE account_id = ?').get('web_deploy_uninvited').total), 0);
        const creation = await fetch(url + '/api/rpc', {
          method: 'POST', headers: { Origin: 'https://kin.example.com', 'Content-Type': 'application/json', Cookie: cookie.split(';')[0] },
          body: JSON.stringify({action:'circle.create',payload:{name:'不可创建',type:'family',mode:'shared'}})
        });
        assert.equal((await creation.json()).ok, false);
        const guest = await fetch(url + '/api/guest/enter', {
          method: 'POST', headers: { Origin: 'https://kin.example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({familyName:'部署验收家庭'})
        });
        assert.equal(guest.status, 200);
        assert.equal((await guest.json()).data.family.id, initialized.familyId);
        const guestCookie = guest.headers.getSetCookie().find(value => value.startsWith('__Host-kin_guest='));
        assert.match(guestCookie, /HttpOnly; SameSite=Lax;.*; Secure/);
        const guestRead = await fetch(url + '/api/guest/family', {headers: {Cookie: guestCookie.split(';')[0]}});
        assert.equal(guestRead.status, 200);
        const guestSnapshot = (await guestRead.json()).data;
        assert.equal(guestSnapshot.family.id, initialized.familyId);
        assert.deepEqual(guestSnapshot.birthdays.events, []);
        assert.match(guestSnapshot.birthdays.asOf, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
        assert.ok(guestSnapshot.birthdays.refreshAt > guestSnapshot.serverTime);
        const guestWrite = await fetch(url + '/api/rpc', {
          method: 'POST', headers: { Origin: 'https://kin.example.com', 'Content-Type': 'application/json', Cookie: guestCookie.split(';')[0] },
          body: JSON.stringify({action:'account.profile.update',payload:{patch:{name:'不可写入'}}})
        });
        assert.equal(guestWrite.status, 401);
        assert.equal((await guestWrite.json()).error.code, 'UNAUTHENTICATED');
        console.log('Portable production API artifact: local setup, invitation-only registration and login eligibility, blocked creation, 90-day account cookie and read-only guest cookie passed.');
      } finally { await app.close(); }
    })().catch(error => {console.error(error); process.exitCode = 1;});
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: temporary,
      stdio: "inherit",
      env: { ...process.env, NODE_PATH: "" },
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Portable runtime check failed: ${code}`)),
    );
  });
} finally {
  const checked = path.resolve(temporary);
  const parent = path.resolve(os.tmpdir());
  if (
    path.dirname(checked) !== parent ||
    !path.basename(checked).startsWith("kin-deploy-check-")
  )
    throw new Error("Unexpected temporary target");
  await rm(checked, { recursive: true, force: true });
}
