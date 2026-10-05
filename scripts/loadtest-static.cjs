// Windows local Caddy benchmark. Supply an official, checksum-verified binary path.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const p95 = rows => [...rows].sort((a, b) => a - b)[Math.ceil(rows.length * .95) - 1];

async function main() {
  if (process.platform !== 'win32' || !process.argv[2]) throw Error('Usage on Windows: node scripts/loadtest-static.cjs <verified-caddy.exe>');
  const binary = path.resolve(process.argv[2]);
  const dist = path.join(ROOT, 'frontend/dist');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-static-loadtest-'));
  const config = path.join(directory, 'Caddyfile');
  fs.writeFileSync(config, `{
  admin off
  auto_https off
  persist_config off
}
http://127.0.0.1:${port} {
  bind 127.0.0.1
  encode zstd gzip
  root * "${dist.replaceAll('\\', '/')}"
  @assets path /assets/*
  header @assets Cache-Control "public, max-age=31536000, immutable"
  file_server
}
`);
  const caddy = spawn(binary, ['run', '--config', config, '--adapter', 'caddyfile'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '', monitor;
  caddy.stderr.on('data', chunk => { log += chunk; });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 400 });
  function request(route, etag) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const req = http.get({ hostname: '127.0.0.1', port, path: route, agent, headers: { 'Accept-Encoding': 'gzip', ...(etag ? { 'If-None-Match': etag } : {}) } }, response => {
        let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; });
        response.on('end', () => resolve({ ms: performance.now() - start, status: response.statusCode, bytes, encoding: response.headers['content-encoding'], etag: response.headers.etag }));
        response.on('error', reject);
      });
      req.setTimeout(30000, () => req.destroy(Error('HTTP timeout')));
      req.on('error', reject);
    });
  }
  try {
    let started = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await request('/')).status === 200) { started = true; break; } } catch {}
      if (caddy.exitCode !== null) throw Error(log);
      await sleep(100);
    }
    if (!started) throw Error(`Caddy did not start: ${log}`);
    let currentSample, phaseSamples;
    monitor = spawn('powershell.exe', ['-NoProfile', '-Command', `$p=Get-Process -Id ${caddy.pid}; while(!$p.HasExited){ $p.Refresh(); @{rssMB=$p.WorkingSet64/1MB;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;peakRssMB=$p.PeakWorkingSet64/1MB} | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 50 }`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    createInterface({ input: monitor.stdout }).on('line', line => { try { currentSample = JSON.parse(line); phaseSamples?.push(currentSample); } catch {} });
    for (let i = 0; !currentSample && i < 50; i++) await sleep(100);
    if (!currentSample) throw Error('Caddy process sampling unavailable');
    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const home = ['/', ...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]))];
    const maps = fs.readdirSync(path.join(dist, 'assets')).filter(name => /^(PersonMap-|map-)/.test(name) && /\.(js|css)$/.test(name)).map(name => `/assets/${name}`);
    if (home.length < 3 || maps.length < 2) throw Error('Missing production assets; build frontend first');
    const scenarios = [];
    async function scenario(name, routes, cached = false) {
      const tags = {};
      if (cached) for (const route of routes) { tags[route] = (await request(route)).etag; if (!tags[route]) throw Error('Missing ETag'); }
      const baseline = currentSample;
      phaseSamples = [baseline];
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: 50 }, () => Promise.all(routes.map(route => request(route, tags[route])))));
      const elapsedMs = performance.now() - start;
      await sleep(120); // Let the independent OS sampler report the last CPU accounting interval.
      const samples = phaseSamples; phaseSamples = null;
      const all = results.flat(), last = currentSample;
      const statuses = {};
      for (const result of all) statuses[result.status] = (statuses[result.status] || 0) + 1;
      const result = {
        name, clients: 50, routes, requests: all.length, statuses,
        success: all.filter(row => cached ? row.status === 304 : row.status === 200 && row.bytes > 0 && row.encoding === 'gzip').length,
        requestP95Ms: p95(all.map(row => row.ms)), clientP95Ms: p95(results.map(rows => Math.max(...rows.map(row => row.ms)))),
        elapsedMs, wireMB: all.reduce((sum, row) => sum + row.bytes, 0) / 1048576,
        baselineRssMB: baseline.rssMB, sampledPeakRssMB: Math.max(...samples.map(row => row.rssMB)),
        cpuSingleCorePercent: (last.cpuMs - baseline.cpuMs) / elapsedMs * 100,
      };
      scenarios.push(result); console.log(JSON.stringify(result));
    }
    await scenario('homepage_cold_cache_50', home);
    await scenario('map_cold_cache_50', maps);
    await scenario('map_etag_revalidation_50', maps, true);
    fs.writeFileSync(path.join(ROOT, 'docs/performance-static-loadtest.json'), JSON.stringify({ recordedAt: new Date().toISOString(), server: 'Official Caddy v2.11.7 Windows amd64; SHA512 release checksum verified before execution', transport: 'Loopback HTTP/1.1 with real gzip; same encode/cache rules as deployment; no WAN/TLS/container limit', sampleIntervalMs: 50, scenarios }, null, 2) + '\n');
  } finally {
    agent.destroy(); monitor?.kill();
    const exited = new Promise(resolve => caddy.once('exit', resolve));
    if (caddy.exitCode === null) { caddy.kill(); await exited; }
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('kin-static-loadtest-')) throw Error('Unsafe fixture cleanup path');
    fs.rmSync(resolved, { recursive: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
