import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { model, setup } from './harness.mjs';

test('desktop can skip denied optional visualization setup without gaining filesystem access', async t => {
  const f = await setup(t);
  const { protocol, client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  const root = join(protocol.stateDir, 'visualizations');
  const path = join(root, '2026', '11', '07', thread.id);
  const denied = await client.raw('fs/createDirectory', { path, recursive: true });
  assert.equal(denied.error.code, -32000);
  // The desktop treats this OS error prefix as recoverable for optional writable roots.
  assert.match(denied.error.message, /^EACCES:/);
  await assert.rejects(stat(root), { code: 'ENOENT' });
  const turn = await client.turn(thread.id, 'plain text');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.items.at(-1).text, 'echo:plain text');

  for (const invalidPath of [join(root, '2026', '11', '07', '00000000-0000-0000-0000-000000000000'),
    join(root, '2026', '11', '07'), `${root}/../outside`, `${root}//2026/11/07/${thread.id}`,
    `${root}/2026/11/07/${thread.id}/child`, `${root}/%2e%2e/outside`, `${root}-other/2026/11/07/${thread.id}`,
    join(f.cwd, 'outside')]) {
    const result = await client.raw('fs/createDirectory', { path: invalidPath, recursive: true });
    assert.equal(result.error?.code, -32602, 'unrecognized paths retain the attachment-only rejection');
  }

  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, root);
  const throughSymlink = await client.raw('fs/createDirectory', { path, recursive: true });
  assert.equal(throughSymlink.error?.code, -32000);
  for (const method of ['fs/readFile', 'fs/writeFile', 'fs/readDirectory', 'fs/getMetadata', 'fs/remove']) {
    const result = await client.raw(method, { path, dataBase64: Buffer.from('not an image').toString('base64') });
    assert.equal(result.error?.code, -32602, `${method} must not gain visualization filesystem access`);
  }
  assert.deepEqual(await readdir(outside), ['sentinel']);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'unchanged');
});
