import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'backend', 'src');
const compiled = join(root, 'backend', 'dist');
const packaged = join(root, 'cloudfunctions', 'api', 'lib');

async function modules(dir, suffix) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await modules(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix) && !entry.name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

const sourceModules = await modules(source, '.ts');
if (!sourceModules.length) throw new Error('No backend TypeScript modules found');

const expected = new Set(sourceModules.map(path => relative(source, path).replace(/\.ts$/, '.js')));
for (const name of expected) {
  let built;
  let cloud;
  try {
    [built, cloud] = await Promise.all([
      readFile(join(compiled, name)),
      readFile(join(packaged, name))
    ]);
  } catch {
    throw new Error(`Cloud function is missing ${name}; run npm run build:cloud`);
  }
  if (!built.equals(cloud)) throw new Error(`Cloud function has an outdated ${name}; run npm run build:cloud`);
}

const actual = (await modules(packaged, '.js')).map(path => relative(packaged, path));
for (const name of actual) {
  if (!expected.has(name)) throw new Error(`Cloud function contains an obsolete ${name}; remove it before deployment`);
}

console.log(`Verified ${expected.size} compiled backend modules in cloudfunctions/api/lib`);
