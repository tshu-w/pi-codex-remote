import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { model, setup } from './harness.mjs';

test('editing an earlier message reverts Pi context, keeps the old branch on disk and survives a restart', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const first = f.start();
  const phone = first.client;
  const { thread } = await phone.request('thread/start', { cwd: f.cwd, model });
  const one = await phone.turn(thread.id, 'first');
  const two = await phone.turn(thread.id, 'second');
  assert.equal(two.items.at(-1).text, 'echo:first|second');
  const before = await readFile(thread.path, 'utf8');

  const reverted = await phone.request('thread/revert', { threadId: thread.id, beforeTurnId: two.id });
  assert.deepEqual(reverted.thread.turns, []);
  await phone.notification('thread/reverted', params => params.threadId === thread.id);
  const kept = await phone.request('thread/turns/list', { threadId: thread.id, cursor: reverted.turnsBackwardsCursor, sortDirection: 'desc' });
  assert.deepEqual(kept.data.map(turn => turn.id), [one.id]);

  const edited = await phone.turn(thread.id, 'edited');
  assert.equal(edited.items.at(-1).text, 'echo:first|edited', 'the reverted message is gone from Pi context');
  assert.ok((await readFile(thread.path, 'utf8')).startsWith(before), 'the abandoned branch stays in the session file');
  await first.protocol.close();

  const restarted = f.start();
  const resumed = await restarted.client.request('thread/resume', { threadId: thread.id, excludeTurns: true, initialTurnsPage: { limit: 10 } });
  assert.deepEqual(resumed.initialTurnsPage.data.map(turn => turn.id), [edited.id, one.id]);
  assert.equal((await restarted.client.raw('thread/revert', { threadId: thread.id, beforeTurnId: two.id })).error?.code, -32602);
});
