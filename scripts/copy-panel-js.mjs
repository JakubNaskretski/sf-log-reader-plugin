import { copyFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src', 'panel.js');
const dest = resolve(root, 'out', 'panel.js');

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`copied ${src} -> ${dest}`);
