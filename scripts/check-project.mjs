import { readFile, access } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mini = join(root, 'miniprogram');
let checked = 0;

async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.name.endsWith('.json')) {
      JSON.parse(await readFile(path, 'utf8'));
      checked += 1;
    }
  }
}

await walk(mini);
const config = JSON.parse(await readFile(join(root, 'project.config.json'), 'utf8'));
if (config.miniprogramRoot !== 'miniprogram/' || config.cloudfunctionRoot !== 'cloudfunctions/') {
  throw new Error('Root project.config.json must include mini-program and cloud-function roots');
}
const app = JSON.parse(await readFile(join(mini, 'app.json'), 'utf8'));
if (!Array.isArray(app.pages) || app.pages.length === 0) throw new Error('app.json has no pages');
for (const page of app.pages) {
  for (const extension of ['ts', 'wxml', 'wxss', 'json']) {
    await access(join(mini, `${page}.${extension}`));
  }
}
if (app.tabBar?.custom) {
  for (const extension of ['ts', 'wxml', 'wxss', 'json']) {
    await access(join(mini, `custom-tab-bar/index.${extension}`));
  }
  const component = JSON.parse(await readFile(join(mini, 'custom-tab-bar/index.json'), 'utf8'));
  if (!component.component) throw new Error('Custom tab bar must be a component');
  for (const tab of app.tabBar.list || []) {
    if (!app.pages.includes(tab.pagePath)) throw new Error(`Unregistered tab page: ${tab.pagePath}`);
  }
}
console.log(`Checked ${checked} mini-program JSON files and ${app.pages.length} complete pages`);
