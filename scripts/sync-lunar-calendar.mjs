import {copyFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'packages/lunar-calendar/src/index.ts');
const targets = [
  resolve(root, 'backend/src/lunar-calendar.ts'),
  resolve(root, 'miniprogram/utils/lunar-calendar.ts')
];
const content = readFileSync(source, 'utf8');
if (!content.includes('[20270206, 2027, 1]')) throw new Error('Official 2027 lunar calendar data missing');
for (const target of targets) {
  mkdirSync(dirname(target), {recursive: true});
  copyFileSync(source, target);
}
console.log('Synced official lunar calendar to backend and mini program');
