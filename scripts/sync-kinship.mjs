import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'packages/kinship/src/index.ts');
const targetDir = resolve(root, 'miniprogram/vendor');
await mkdir(targetDir, { recursive: true });
await copyFile(source, resolve(targetDir, 'kinship.ts'));
console.log('Synced kinship engine into miniprogram/vendor/kinship.ts');
