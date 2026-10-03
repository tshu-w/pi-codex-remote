import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { model, setup } from './harness.mjs';

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}

// A valid 2x2 RGBA PNG.
const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0);
header.writeUInt32BE(2, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);

test('a phone image upload reaches the Pi model, persists as image data and bad images are rejected', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const first = f.start();
  const phone = first.client;
  const { thread } = await phone.request('thread/start', { cwd: f.cwd, model });
  const upload = async (name, bytes) => {
    const path = join(f.root, 'remote-state', 'attachments', name, 'image.png');
    await phone.request('fs/createDirectory', { path: join(path, '..'), recursive: true });
    await phone.request('fs/writeFile', { path, dataBase64: bytes.toString('base64') });
    await assert.rejects(readFile(path), { code: 'ENOENT' }, 'uploads stay in the private cache');
    return path;
  };

  const path = await upload('good', png);
  const { turn } = await phone.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'look' }, { type: 'localImage', path }] });
  await phone.notification('turn/completed', params => params.turn.id === turn.id);
  assert.deepEqual((await f.calls()).at(-1).images, [png.toString('base64')]);
  const history = await readFile(thread.path, 'utf8');
  assert.ok(history.includes(png.toString('base64')) && !history.includes(path), 'history stores bytes, not the upload path');

  const damaged = await upload('damaged', png.subarray(0, 16));
  const callsBefore = (await f.calls()).length;
  const rejected = await phone.raw('turn/start', { threadId: thread.id, input: [{ type: 'localImage', path: damaged }] });
  assert.match(rejected.error?.message, /could not be decoded/);
  assert.equal((await f.calls()).length, callsBefore, 'a rejected image never reaches the model');
  await first.protocol.close();

  const restarted = f.start();
  const resumed = await restarted.client.request('thread/resume', { threadId: thread.id, excludeTurns: true, initialTurnsPage: { limit: 10, itemsView: 'full' } });
  const user = resumed.initialTurnsPage.data[0].items.find(item => item.type === 'userMessage');
  assert.deepEqual(user.content.filter(part => part.type === 'image'), [{ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` }]);
});
