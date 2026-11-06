import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { model, setup, waitFor } from './harness.mjs';

test('a saved thread releases its Pi process after each turn, even while viewed, and reopens on the next turn', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const { protocol, client } = f.start({ releaseDelayMs: 300 });
  await client.request('initialize', { clientInfo: { name: 'e2e', version: '1' } });
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  const closed = () => client.notification('thread/closed', params => params.threadId === thread.id);
  const rpc = protocol.loaded.get(thread.id);
  let released = closed();
  await client.turn(thread.id, 'first');
  await released;
  await rpc.exited;
  assert.equal(protocol.loaded.has(thread.id), false, 'a subscribed thread is released once Pi is idle');

  const resumed = await client.request('thread/resume', { threadId: thread.id });
  assert.equal(protocol.loaded.has(thread.id), false, 'viewing does not open the session');
  assert.equal(resumed.thread.canAcceptDirectInput, true);
  assert.equal((await client.request('thread/read', { threadId: thread.id })).thread.status.type, 'notLoaded');

  await writeFile(join(f.cwd, 'fixture-busy'), '');
  const turn = await client.turn(thread.id, 'second');
  assert.equal(turn.items[0].text, 'echo:first|second');
  const reopened = protocol.loaded.get(thread.id);
  assert.ok(reopened);
  await delay(1500);
  assert.equal(protocol.loaded.get(thread.id), reopened, 'background work keeps Pi loaded');
  assert.equal(reopened.failure, undefined);

  released = closed();
  await rm(join(f.cwd, 'fixture-busy'));
  await released;
  await reopened.exited;
});

test('a thread with a drained queue still releases right after each turn', { timeout: 60000 }, async t => {
  const f = await setup(t);
  // A long delay keeps the periodic retry out of the window this test checks.
  const { protocol, client } = f.start({ releaseDelayMs: 60_000 });
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  await client.turn(thread.id, 'first');
  await waitFor(() => !protocol.loaded.has(thread.id), 'first turn releases');
  await client.request('thread/queue/add', { threadId: thread.id, input: [{ type: 'text', text: 'queued', text_elements: [] }], clientUserMessageId: 'queued' });
  await waitFor(async () => (await f.calls()).some(call => call.prompt === 'queued'), 'queued input runs');
  await waitFor(() => !protocol.loaded.has(thread.id) && !protocol.active.has(thread.id), 'drained queue releases');
  await client.turn(thread.id, 'after');
  await waitFor(() => !protocol.loaded.has(thread.id), 'later turn releases');
});
