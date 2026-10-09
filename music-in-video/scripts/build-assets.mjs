// Builds the Worker's static assets: clearance-check/public (served as
// before, at /) and music-in-video/public (/music/ and /v/) merged into
// music-in-video/dist. Fails if the two ever ship the same path, so neither
// experiment can shadow the other. Run by the root package.json "build"
// script (root wrangler.jsonc build.command) before every deploy.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

const here = new URL('..', import.meta.url).pathname;
const SOURCES = [join(here, '../clearance-check/public'), join(here, 'public')];
const DIST = join(here, 'dist');

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

const seen = new Map();
for (const src of SOURCES) {
  for (const f of await files(src)) {
    const rel = relative(src, f);
    if (seen.has(rel)) throw new Error(`asset collision: ${rel} is in both ${seen.get(rel)} and ${src}`);
    seen.set(rel, src);
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const src of SOURCES) await cp(src, DIST, { recursive: true });
console.log(`dist: ${seen.size} files from ${SOURCES.map((s) => relative(here, s)).join(' + ')}`);
