import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listSessions, readHistory, readSearchText } from '../src/history.mjs';

const header = { type: 'session', id: 'session', cwd: '/project', timestamp: '2026-01-01T00:00:00Z' };
const message = (text, id = 'user', parentId = null) => ({ type: 'message', id, parentId, message: { role: 'user', content: text } });
const jsonl = (...records) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'history-cache-'));
  const originalDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  const readFile = fs.readFile;
  let reads = 0;
  t.mock.method(fs, 'readFile', (...args) => { reads++; return readFile(...args); });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalDir;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, reads: () => reads };
}

test('history caches reuse reads and invalidate external edits, branches, moves and directory switches', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'session.jsonl');
  await fs.writeFile(file, jsonl(header, message('first')));
  const sessions = await listSessions();
  assert.equal(f.reads(), 1);
  sessions[0].created.setFullYear(2000);
  const history = await readHistory(file);
  history.entries[0].message.content = 'mutated';
  assert.equal((await readHistory(file)).entries[0].message.content, 'first');
  assert.equal((await listSessions())[0].created.getFullYear(), 2026);
  assert.equal(await readSearchText(file), 'first');
  assert.equal(f.reads(), 1, 'warm list/history/search do not read file contents');
  assert.deepEqual(await listSessions({ cwd: '/elsewhere' }), []);

  await fs.appendFile(file, jsonl(message('second', 'second', 'user')));
  assert.equal(await readSearchText(file), 'first\nsecond');
  await fs.appendFile(file, jsonl(message('edited', 'edited', 'user')));
  assert.equal(await readSearchText(file), 'first\nedited', 'abandoned branch is not searchable');
  const previous = await fs.stat(file);
  await fs.writeFile(file, jsonl(header, message('other')));
  await fs.utimes(file, previous.atime, previous.mtime);
  assert.equal((await listSessions())[0].firstMessage, 'other');
  const sameSize = await fs.stat(file);
  await fs.writeFile(file, jsonl(header, message('third')));
  await fs.utimes(file, sameSize.atime, sameSize.mtime);
  assert.equal(await readSearchText(file), 'third', 'ctime detects same-size replacements with restored mtime');

  const moved = join(f.root, 'moved.jsonl');
  await fs.rename(file, moved);
  await assert.rejects(readHistory(file), { code: 'ENOENT' });
  assert.equal((await listSessions())[0].path, moved);
  const other = join(f.root, 'other');
  await fs.mkdir(other);
  process.env.PI_CODING_AGENT_SESSION_DIR = other;
  assert.deepEqual(await listSessions(), []);
  await fs.writeFile(join(other, 'session.jsonl'), jsonl({ ...header, id: 'other' }, message('new directory')));
  assert.equal((await listSessions())[0].id, 'other');

  await fs.writeFile(moved, jsonl(header, message('valid')) + '{"type":');
  assert.equal((await readHistory(moved)).entries.length, 1);
  const before = f.reads();
  await readHistory(moved);
  assert.equal(f.reads(), before + 1, 'incomplete tails are not cached');
  await fs.appendFile(moved, '"session_info","id":"name","parentId":"user","name":"completed"}\n');
  assert.equal(await readSearchText(moved), 'valid\ncompleted');
  await fs.writeFile(moved, jsonl(header) + 'invalid\n');
  await assert.rejects(readHistory(moved), /Invalid Pi history/);
  await assert.rejects(readHistory(moved), /Invalid Pi history/);
  await fs.writeFile(moved, jsonl(header, message('fixed')));
  assert.equal(await readSearchText(moved), 'fixed');
});

test('compact search survives history LRU eviction and oversized images bypass the history cache', async t => {
  const f = await fixture(t);
  const files = [];
  for (let i = 0; i < 130; i++) {
    const file = join(f.root, `${i}.jsonl`);
    files.push(file);
    await fs.writeFile(file, jsonl({ ...header, id: String(i) }, message(`text ${i}`)));
  }
  await listSessions();
  assert.equal(f.reads(), 130);
  await listSessions();
  for (let i = 0; i < files.length; i++) assert.equal(await readSearchText(files[i]), `text ${i}`);
  assert.equal(f.reads(), 130, 'list plus repeated search stays warm beyond history entry capacity');

  const file = join(f.root, 'large.jsonl');
  const image = 'a'.repeat(9 * 1024 * 1024);
  await fs.writeFile(file, jsonl(header, message([{ type: 'text', text: 'caption' }, { type: 'image', mimeType: 'image/png', data: image }])));
  assert.equal((await readHistory(file)).entries[0].message.content[1].data, image);
  const before = f.reads();
  assert.equal((await readHistory(file)).entries[0].message.content[1].data.length, image.length);
  assert.equal(f.reads(), before + 1, 'oversized history is read in full but not retained');
  assert.equal(await readSearchText(file), 'caption');
  assert.equal(await readSearchText(file), 'caption');
  assert.equal(f.reads(), before + 2, 'compact search remains cached without the image');
});
