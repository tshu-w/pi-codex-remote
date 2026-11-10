// Real pi-agents hosts; run with PI_CODEX_REMOTE_TEST_PD=1 when `pi-agents` is on PATH.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Sessions } from '../src/sessions.mjs';
import { sessionPids } from '../src/trash.mjs';
import { model, setup, waitFor } from './harness.mjs';

const executable = (process.env.PATH ?? '').split(':').map(dir => join(dir, 'pi-agents')).find(existsSync);
const skip = process.env.PI_CODEX_REMOTE_TEST_PD !== '1' ? 'set PI_CODEX_REMOTE_TEST_PD=1' : !executable && 'pi-agents is not on PATH';
// Hosts outlive their clients; a host's socket is named after its PID.
const killHosts = f => { for (const pid of readdirSync(join(f.state, 'pi/agents/runtime')).flatMap(file => /^h-(\d+)\.sock$/.exec(file)?.[1] ?? [])) process.kill(Number(pid)); };
const text = input => [{ type: 'text', text: input, text_elements: [] }];

test('Remote joins the host of a saved session and follows turns started by its other clients', { skip, timeout: 180000 }, async t => {
  const f = await setup(t, { hosted: dirname(dirname(realpathSync(executable))) });
  const { protocol, sessions, client } = f.start({ releaseDelayMs: 500 });
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  const first = await client.turn(thread.id, 'first');
  assert.equal(first.items[0].text, 'echo:first');
  // A second client of the host stands in for its terminal.
  const terminal = await new Sessions({ hosted: sessions.hosted, requestTimeoutMs: 30000, shutdownTimeoutMs: 1000 }).open({ cwd: f.cwd, sessionFile: thread.path });
  t.after(() => terminal.close());
  const completed = id => client.notification('turn/completed', params => params.turn.id === id);
  // The turn the terminal starts next, possibly already finished.
  const started = async prompt => {
    const seen = client.records.length;
    await terminal.request('prompt', { message: prompt });
    return waitFor(() => client.records.slice(seen).find(record => record.method === 'turn/started'), 'turn/started').then(record => record.params.turn);
  };

  const second = await started('second');
  assert.equal((await completed(second.id)).params.turn.status, 'completed');
  const live = client.records.filter(record => record.method === 'item/completed' && record.params.turnId === second.id).map(record => record.params.item);
  assert.deepEqual(live.map(item => item.text ?? item.content?.[0]?.text), ['second', 'echo:first|second']);
  const history = (await client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', sortDirection: 'asc' })).data;
  assert.deepEqual(history.map(turn => turn.id), [first.id, second.id]);
  assert.deepEqual(history[1].items.map(item => item.id), live.map(item => item.id));

  const held = await started('hold');
  assert.match((await client.raw('turn/start', { threadId: thread.id, input: text('blocked') })).error.message, /turn\/steer/);
  await client.request('turn/interrupt', { threadId: thread.id, turnId: held.id });
  assert.equal((await completed(held.id)).params.turn.status, 'interrupted');

  await client.request('thread/revert', { threadId: thread.id, beforeTurnId: second.id });
  assert.equal((await client.turn(thread.id, 'edited')).items[0].text, 'echo:first|edited');
  const fork = (await client.request('thread/fork', { threadId: thread.id })).thread;
  assert.equal((await client.turn(fork.id, 'forked')).items[0].text, 'echo:first|edited|forked');
  assert.equal((await terminal.refresh()).sessionId, thread.id, 'a fork moves only Remote');

  // Releasing only disconnects Remote; the host keeps the session for its other clients.
  const remote = protocol.loaded.get(fork.id);
  client.disconnect();
  await remote.exited;
  assert.equal(protocol.loaded.size, 0);
  assert.equal((await terminal.refresh()).sessionId, thread.id);

  // Archiving waits for the host to let go of the session file.
  await client.request('thread/archive', { threadId: thread.id });
  assert.deepEqual((await client.request('thread/list', {})).data.map(listed => listed.id), [fork.id]);
  assert.ok(existsSync(thread.path));
  await terminal.close();
  killHosts(f);
  await waitFor(() => protocol.meta.trashed?.[thread.id], 'moved to Trash', 30000);
  assert.equal(existsSync(thread.path), false);
});

test('Remote does not add a Pi to a session open outside pi-agents', { skip, timeout: 120000 }, async t => {
  const f = await setup(t, { hosted: dirname(dirname(realpathSync(executable))) });
  const { protocol, sessions, client } = f.start({ releaseDelayMs: 500 });
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  await client.turn(thread.id, 'first');
  const remote = protocol.loaded.get(thread.id);
  client.disconnect();
  await remote.exited;
  killHosts(f);
  await waitFor(async () => !(await sessionPids(thread.path)).length, 'hosted Pi exited');
  // A plain `pi` also loads pi-agents, which locks the session.
  const local = await new Sessions({ command: sessions.command, args: sessions.hosted.args.map(arg => arg === 'pi-agents' ? 'pi' : arg), shutdownTimeoutMs: 1000 }).open({ cwd: f.cwd, sessionFile: thread.path });
  t.after(() => local.close());
  // pi-agents takes its Session lock after startup.
  await waitFor(() => readdirSync(join(f.state, 'pi/agents/runtime/locks')).some(file => file.includes(`.${local.child.pid}-`)), 'local Pi locked the session');
  const resumed = await client.request('thread/resume', { threadId: thread.id });
  assert.equal(resumed.thread.canAcceptDirectInput, true);
  // pi-agents fails, joins that Pi, or starts a second Pi on the file; Remote never sends to a second Pi.
  const response = await client.raw('turn/start', { threadId: thread.id, input: text('second') });
  if (!response.error) {
    assert.deepEqual(await sessionPids(thread.path), [local.child.pid]);
    return;
  }
  assert.match(response.error.message, /Quit that Pi first/);
  await local.close();
  killHosts(f);
  await waitFor(async () => !(await sessionPids(thread.path)).length, 'every Pi left the session');
  assert.equal((await client.turn(thread.id, 'second')).items[0].text, 'echo:first|second');
});
