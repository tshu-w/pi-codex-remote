// The catalog of saved sessions: read once, refreshed when a watcher sees the session directory change.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as history from '../src/history.mjs';
import { Protocol } from '../src/protocol.mjs';
import { phone, waitFor } from './harness.mjs';

test('reads use the catalog until a session is added, renamed or removed', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-remote-catalog-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  const session = (id, ...entries) => [{ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: root }, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join('');
  const user = { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello', timestamp: Date.now() } };
  const a = '01a1a514-0000-7000-8000-00000000000a';
  const b = '01a1a514-0000-7000-8000-00000000000b';
  await writeFile(join(root, 'a.jsonl'), session(a, user));
  let lists = 0;
  const protocol = new Protocol({
    sessions: { persistedPaths: new Map(), open: async () => { throw new Error('no Pi'); }, close: async () => {} },
    history: { ...history, listSessions: options => { lists++; return history.listSessions(options); } },
    cwd: root, stateDir: join(root, '.state'),
  });
  t.after(() => protocol.close());
  await protocol.ready;
  const client = phone(protocol);
  const names = async () => (await client.request('thread/list', {})).data.map(thread => [thread.id, thread.name]);
  assert.deepEqual(await names(), [[a, null]]);
  // The watcher may still report writing the session it was started after.
  await new Promise(resolve => setTimeout(resolve, 300));
  await names();
  const read = lists;
  await client.request('thread/read', { threadId: a, includeTurns: true });
  await names();
  assert.equal(lists, read, 'a known thread and an unchanged directory need no refresh');
  await writeFile(join(root, 'b.jsonl'), session(b, user));
  await waitFor(async () => (await names()).length === 2, 'added session listed');
  await appendFile(join(root, 'a.jsonl'), `${JSON.stringify({ type: 'session_info', id: 'n1', parentId: 'u1', timestamp: new Date().toISOString(), name: 'renamed' })}\n`);
  await waitFor(async () => (await names()).some(([id, name]) => id === a && name === 'renamed'), 'renamed session listed');
  await rm(join(root, 'b.jsonl'));
  await waitFor(async () => (await names()).length === 1, 'removed session unlisted');
});
