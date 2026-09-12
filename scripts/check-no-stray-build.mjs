#!/usr/bin/env node
/**
 * Fail if compiled output is sitting next to the TypeScript it was built from.
 *
 * A stray `packages/*\/src/*.js` shadows its `.ts` sibling for anything that imports
 * with a `.js` specifier, which is every file in this repo. It happened once: a `tsc`
 * run without a project emitted into src, and the whole unit suite then ran against
 * a snapshot of the code rather than the code, passing while the source was wrong.
 * Cheap to check, invisible when it happens, so it is checked.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const STRAY = /\.(js|js\.map|d\.ts|d\.ts\.map)$/;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (STRAY.test(entry.name)) out.push(path);
  }
  return out;
}

const packages = await readdir('packages', { withFileTypes: true });
const found = [];
for (const pkg of packages) {
  if (!pkg.isDirectory()) continue;
  try {
    found.push(...(await walk(join('packages', pkg.name, 'src'))));
  } catch {
    // No src directory. Nothing to check.
  }
}

if (found.length > 0) {
  console.error('compiled output found inside src, which shadows the source it came from:');
  for (const f of found) console.error(`  ${f}`);
  console.error('\nremove it, and build with `npm run build` so output lands in dist.');
  process.exit(1);
}
