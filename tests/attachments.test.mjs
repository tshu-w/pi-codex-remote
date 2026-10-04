import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectTurns } from '../src/history.mjs';
import { ImagePreviews } from '../src/image-previews.mjs';
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

function imageFileEntries(text) {
  const boundary = text.indexOf('\n## My request:\n');
  if (!text.startsWith('# Files mentioned by the user:\n') || boundary === -1) return [];
  return text.slice(0, boundary).match(/^## .+: .+\.(?:jpe?g|png|gif|webp)$/gmi) || [];
}

test('duplicate image entries are removed only from generated upload headers', () => {
  const path = `/tmp/codex-remote-attachments/${randomUUID()}/${randomUUID()}/Photo 1.jpg`;
  const header = `# Files mentioned by the user:\n\n## Photo 1.jpg: ${path}`;
  const body = `\n\n## My request:\n用户正文\n## Photo 1.jpg: ${path}\n`;
  const text = header + body;
  const marked = `${header}\nImage attachment: true${body}`;
  const request = body.slice('\n\n## My request:\n'.length);
  const otherImage = `## Other.PNG: ${path.replace('Photo 1.jpg', 'Other.PNG')}`;
  const file = '## Notes.txt: /tmp/notes.txt';
  for (const [label, input, hasImage, expected] of [
    ['generated upload', text, true, request],
    ['multiple images', `${header}\n\n${otherImage}${body}`, true, request],
    ['mixed files', `${header}\n\n${file}${body}`, true, `# Files mentioned by the user:\n\n\n${file}${body}`],
    ['already removed', request, true, request],
    ['no image', text, false, text],
    ['already marked', marked, true, request],
    ['marker after blank line', `${header}\n\nImage attachment: true${body}`, true, request],
    ['multiple marked images', `${header}\nImage attachment: true\n\n${otherImage}\nImage attachment: true${body}`, true, request],
    ['ordinary markdown', `User wrote:\n${text}`, true, `User wrote:\n${text}`],
    ['no request boundary', header, true, header],
    ['other namespace', text.replaceAll('/tmp/codex-remote-attachments/', '/tmp/uploads/'), true, text.replaceAll('/tmp/codex-remote-attachments/', '/tmp/uploads/')],
    ['invalid upload shape', text.replaceAll(path, '/tmp/codex-remote-attachments/thread/upload/photo.jpg'), true, text.replaceAll(path, '/tmp/codex-remote-attachments/thread/upload/photo.jpg')],
    ['ordinary file', text.replaceAll('.jpg', '.txt'), true, text.replaceAll('.jpg', '.txt')],
  ]) {
    const content = [{ type: 'text', text: input }, ...(hasImage ? [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] : [])];
    const entries = [{ type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content } }];
    const original = structuredClone(entries);
    const projected = projectTurns(entries)[0].items[0].content[0].text;
    assert.equal(projected, expected, label);
    if (input !== expected) assert.deepEqual(imageFileEntries(projected), [], `${label}: no parseable image file entries`);
    assert.deepEqual(entries, original, `${label}: projection does not mutate history`);
    const again = structuredClone(entries);
    again[0].message.content[0].text = projected;
    assert.equal(projectTurns(again)[0].items[0].content[0].text, projected, `${label}: idempotent`);
  }
});

test('loaded images avoid session reads and evicted images are recovered from their source session', async () => {
  const first = randomUUID();
  const second = randomUUID();
  const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
  const loads = [];
  const previews = new ImagePreviews({ stateDir: '/virtual', maxBytes: image.data.length * 2, loadEntries: async threadId => {
    loads.push(threadId);
    return threadId === first || threadId === second ? [{ message: { role: 'user', content: [image] } }] : [];
  } });
  const a = previews.image(image, first);
  assert.deepEqual(await previews.readFile(a), { dataBase64: image.data });
  assert.deepEqual(loads, [], 'already loaded image data is directly readable');
  previews.image(image, second);
  assert.deepEqual(await previews.readFile(a), { dataBase64: image.data });
  assert.deepEqual(loads, [first], 'eviction reloads only the source session');
  await previews.getMetadata(a);
  assert.deepEqual(loads, [first], 'recovered data is cached');
  await assert.rejects(previews.readFile({ path: a.path.replace(first, randomUUID()) }), /Image not found/);
});

test('a phone image upload reaches the Pi model, persists as image data and bad images are rejected', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const first = f.start();
  const phone = first.client;
  const { thread } = await phone.request('thread/start', { cwd: f.cwd, model });
  const upload = async (name, bytes) => {
    const path = `/tmp/codex-remote-attachments/${thread.id}/${randomUUID()}/${name}.png`;
    await phone.request('fs/createDirectory', { path: join(path, '..'), recursive: true });
    await phone.request('fs/writeFile', { path, dataBase64: bytes.toString('base64') });
    await assert.rejects(readFile(path), { code: 'ENOENT' }, 'uploads stay in the private cache');
    return path;
  };

  const path = await upload('good', png);
  const text = `# Files mentioned by the user:\n\n## Photo 1.png: ${path}\n\n## Notes.txt: /tmp/notes.txt\n\n## My request:\nlook\n## Photo 1.png: ${path}\n`;
  const displayText = text.replace(`## Photo 1.png: ${path}\n`, '');
  const { turn } = await phone.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }, { type: 'localImage', path }] });
  await phone.notification('turn/completed', params => params.turn.id === turn.id);
  const live = (await phone.notification('item/started', params => params.turnId === turn.id && params.item.type === 'userMessage')).params.item;
  assert.equal(live.content.find(part => part.type === 'text').text, displayText);
  assert.deepEqual(imageFileEntries(displayText), [], 'live projection has no image file entries');
  const preview = live.content.find(part => part.type === 'localImage');
  assert.ok(preview, 'live user images use a local preview path');
  assert.ok(preview.path.includes(thread.id), 'the virtual path identifies its source session');
  await assert.rejects(readFile(preview.path), { code: 'ENOENT' }, 'previews do not create a second disk copy');
  assert.deepEqual(await phone.request('fs/readFile', { path: preview.path }), { dataBase64: png.toString('base64') });
  assert.equal((await phone.request('fs/getMetadata', { path: preview.path })).isFile, true);
  assert.deepEqual((await f.calls()).at(-1).images, [png.toString('base64')]);
  const history = await readFile(thread.path, 'utf8');
  assert.equal((await f.calls()).at(-1).prompt, text, 'display metadata never changes the model prompt');
  const savedUser = history.split('\n').filter(Boolean).map(JSON.parse).find(entry => entry.message?.role === 'user');
  assert.equal(savedUser.message.content.find(part => part.type === 'text').text, text);
  assert.ok(history.includes(png.toString('base64')), 'history stores image bytes');
  assert.ok(!history.includes('Image attachment: true'), 'display metadata is not persisted');

  const damaged = await upload('damaged', png.subarray(0, 16));
  const callsBefore = (await f.calls()).length;
  const rejected = await phone.raw('turn/start', { threadId: thread.id, input: [{ type: 'localImage', path: damaged }] });
  assert.match(rejected.error?.message, /could not be decoded/);
  assert.equal((await f.calls()).length, callsBefore, 'a rejected image never reaches the model');
  await first.protocol.close();

  const restarted = f.start();
  assert.deepEqual(await restarted.client.request('fs/readFile', { path: preview.path }), { dataBase64: png.toString('base64') });
  assert.equal((await restarted.client.request('fs/getMetadata', { path: preview.path })).isFile, true);
  const restored = await restarted.client.request('thread/read', { threadId: thread.id, includeTurns: true });
  const user = restored.thread.turns[0].items.find(item => item.type === 'userMessage');
  assert.equal(user.content.find(part => part.type === 'text').text, displayText);
  assert.deepEqual(imageFileEntries(user.content.find(part => part.type === 'text').text), [], 'history projection has no image file entries');
  assert.deepEqual(user.content.filter(part => part.type === 'localImage'), [preview]);
  assert.deepEqual(await restarted.client.request('fs/readFile', { path: preview.path }), { dataBase64: png.toString('base64') });
  await assert.rejects(readFile(preview.path), { code: 'ENOENT' });
  assert.ok(!(await readdir(join(f.root, 'remote-state'))).some(name => /image|preview/.test(name)), 'no image cache directory is created');
  const privatePath = join(f.root, 'remote-state', 'private.txt');
  await writeFile(privatePath, 'private');
  for (const denied of [privatePath, `${preview.path}/../../private.txt`, `${preview.path}.other`, preview.path.replace(thread.id, randomUUID()), preview.path.replace(/[^/]+$/, `${'0'.repeat(64)}.png`)]) {
    for (const method of ['fs/readFile', 'fs/getMetadata']) assert.ok((await restarted.client.raw(method, { path: denied })).error, `${method} rejects ${denied}`);
  }
});
