// A local stand-in for an R2 bucket binding (put / get / head / delete /
// list), backed by a folder, for the harness and the scored run. No Cloudflare
// call of any kind. Keys map to file names with '/' -> '__'.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const file = (dir, key) => join(dir, key.replaceAll('/', '__'));
const keyOf = (name) => name.replaceAll('__', '/');

export async function r2StandIn(dir) {
  await mkdir(dir, { recursive: true });
  const object = async (key) => {
    const p = file(dir, key);
    const st = await stat(p).catch(() => null);
    return st ? { key, size: st.size, uploaded: st.mtime, p } : null;
  };
  return {
    dir,
    async put(key, value) {
      let bytes;
      if (value instanceof ReadableStream) bytes = Buffer.from(await new Response(value).arrayBuffer());
      else bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      await writeFile(file(dir, key), bytes);
      return { key, size: bytes.length };
    },
    async head(key) {
      const o = await object(key);
      return o && { key: o.key, size: o.size, uploaded: o.uploaded };
    },
    async get(key) {
      const o = await object(key);
      if (!o) return null;
      const bytes = await readFile(o.p);
      return {
        key, size: o.size, uploaded: o.uploaded,
        get body() { return new Response(bytes).body; },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      };
    },
    async delete(keys) {
      for (const k of [].concat(keys)) await rm(file(dir, k), { force: true });
    },
    async list({ prefix = '' } = {}) {
      const objects = [];
      for (const name of await readdir(dir)) {
        const key = keyOf(name);
        if (key.startsWith(prefix)) objects.push(await object(key));
      }
      return { objects: objects.filter(Boolean).map(({ key, size, uploaded }) => ({ key, size, uploaded })), truncated: false };
    },
  };
}
