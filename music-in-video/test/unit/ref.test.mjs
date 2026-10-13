// The catalog reference copy readers (src/ref.js): local files, and R2's S3
// API with a SigV4-signed GET (checked against AWS's published example).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRef, r2Ref, refKey, signGet } from '../../src/ref.js';

const pcm = (xs) => Buffer.from(Int16Array.from(xs).buffer);

test('SigV4: AWS\'s GET Object example signs to the published signature', () => {
  const h = signGet({
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    headers: { range: 'bytes=0-9' },
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(h.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('localRef reads a whole track as floats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms007-ref-'));
  await writeFile(join(dir, refKey('t-1')), pcm([0, 16384, -32768, 32767]));
  assert.deepEqual([...(await localRef(dir).track('t-1'))], [0, 0.5, -1, 32767 / 32768]);
});

test('r2Ref: one signed GET of <bucket>/<track_id>.s16le on the account endpoint', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return new Response(pcm([1, -2, 3]));
  };
  const ref = r2Ref({ endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'ms007-catalog-ref', accessKeyId: 'AK', secretAccessKey: 'SK', fetchFn });
  const t = await ref.track('abc');
  assert.deepEqual([...t], [1 / 32768, -2 / 32768, 3 / 32768]);
  assert.equal(calls[0].url, 'https://acct.r2.cloudflarestorage.com/ms007-catalog-ref/abc.s16le');
  assert.match(calls[0].auth, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  const missing = r2Ref({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK', fetchFn: async () => new Response('no', { status: 404 }) });
  await assert.rejects(missing.track('x'), /R2 404/);
});
