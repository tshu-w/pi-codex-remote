import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { model, setup, waitFor } from './harness.mjs';

test('an idle unsubscribed thread releases its Pi process and reopens on the next turn', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const { protocol, client } = f.start({ releaseDelayMs: 300 });
  await client.request('initialize', { clientInfo: { name: 'e2e', version: '1' } });
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  await client.turn(thread.id, 'first');
  const rpc = protocol.loaded.get(thread.id);
  await client.request('config/read', {});
  await waitFor(() => protocol.probes.size === 0, 'idle probe closes');

  await delay(1000);
  assert.equal(protocol.loaded.get(thread.id), rpc, 'a subscribed thread stays loaded');

  await writeFile(join(f.cwd, 'fixture-busy'), '');
  await client.request('thread/unsubscribe', { threadId: thread.id });
  await delay(1500);
  assert.equal(protocol.loaded.get(thread.id), rpc, 'background work keeps Pi loaded');
  assert.equal(rpc.failure, undefined);

  await rm(join(f.cwd, 'fixture-busy'));
  await client.notification('thread/closed', params => params.threadId === thread.id);
  await rpc.exited;
  assert.equal((await client.request('thread/read', { threadId: thread.id })).thread.status.type, 'notLoaded');

  const turn = await client.turn(thread.id, 'second');
  assert.equal(turn.items[0].text, 'echo:first|second');
});
