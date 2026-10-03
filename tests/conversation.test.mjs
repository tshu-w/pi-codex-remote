import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { model, setup } from './harness.mjs';

test('a phone conversation runs native tools, keeps Pi permissions and survives a restart', { timeout: 120000 }, async t => {
  const f = await setup(t);
  await writeFile(join(f.cwd, 'input.txt'), 'fixture-data\n');
  const first = f.start();
  const phone = first.client;
  await phone.request('initialize', { clientInfo: { name: 'e2e', version: '1' } });
  assert.ok((await phone.request('model/list', {})).data.some(entry => entry.model === model));
  const { thread } = await phone.request('thread/start', { cwd: f.cwd, model, historyMode: 'paginated', dynamicTools: [] });
  assert.equal(thread.historyMode, 'paginated');
  assert.ok(thread.path.startsWith(f.sessions));

  const read = await phone.turn(thread.id, 'read input.txt', { clientUserMessageId: 'phone-1' });
  assert.equal(read.status, 'completed');
  assert.equal(read.items.at(-1).text, 'done:read');
  const readTool = phone.records.find(record => record.method === 'item/completed' && record.params.item.type === 'commandExecution');
  assert.equal(readTool.params.item.status, 'completed');
  assert.equal(readTool.params.item.commandActions[0].type, 'read');
  assert.equal(readTool.params.item.commandActions[0].path, join(f.cwd, 'input.txt'));
  assert.equal(readTool.params.item.aggregatedOutput, 'fixture-data\n');
  const users = phone.records.filter(record => record.method === 'item/completed' && record.params.item.type === 'userMessage');
  assert.deepEqual(users.map(record => record.params.item.clientId), ['phone-1']);
  assert.ok(phone.records.indexOf(users[0]) < phone.records.indexOf(readTool), 'user item precedes tool output');

  const bash = await phone.turn(thread.id, 'bash printf native-bash');
  assert.equal(bash.status, 'completed');
  const command = phone.records.find(record => record.method === 'item/completed' && record.params.item.type === 'commandExecution' && record.params.item.commandActions.length === 0);
  assert.equal(command.params.item.aggregatedOutput, 'native-bash');
  assert.equal(command.params.item.exitCode, 0);
  assert.equal(phone.records.filter(record => record.method === 'item/commandExecution/outputDelta' && record.params.itemId === command.params.item.id).map(record => record.params.delta).join(''), 'native-bash');

  // The fixture's permission hook asks for confirmation; Remote cancels Pi dialogs.
  const write = await phone.turn(thread.id, 'write blocked.txt');
  assert.equal(write.status, 'completed');
  assert.ok(phone.records.some(record => record.method === 'error' && /Fixture permission/.test(record.params.error.message)));
  await assert.rejects(readFile(join(f.cwd, 'blocked.txt')), { code: 'ENOENT' });

  const page = await phone.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', sortDirection: 'asc' });
  assert.deepEqual(page.data.map(turn => turn.id), [read.id, bash.id, write.id]);
  const persisted = await readFile(thread.path, 'utf8');
  await first.protocol.close();

  const restarted = f.start();
  const resumed = await restarted.client.request('thread/resume', { threadId: thread.id, excludeTurns: true, initialTurnsPage: { limit: 10, itemsView: 'full' } });
  assert.deepEqual(resumed.initialTurnsPage.data.map(turn => turn.id), [write.id, bash.id, read.id]);
  assert.deepEqual(resumed.initialTurnsPage.data.at(-1).items, page.data[0].items, 'item identities survive a restart');
  const echo = await restarted.client.turn(thread.id, 'continue');
  assert.equal(echo.items.at(-1).text, 'echo:read input.txt|bash printf native-bash|write blocked.txt|continue', 'Pi context is restored');
  assert.ok((await readFile(thread.path, 'utf8')).startsWith(persisted), 'history is appended, never rewritten');
});

test('a held turn streams to a reconnecting phone, accepts steering and can be interrupted', { timeout: 120000 }, async t => {
  const f = await setup(t);
  const { protocol, sessions, client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  const rpc = await sessions.open({ cwd: f.cwd, sessionFile: thread.path });

  const { turn } = await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hold' }] });
  const delta = await client.notification('item/agentMessage/delta', params => params.turnId === turn.id);
  assert.equal(client.records.findIndex(record => record.result?.turn?.id === turn.id) < client.records.indexOf(delta), true, 'response precedes notifications');
  client.disconnect();
  const active = await client.request('thread/resume', { threadId: thread.id, excludeTurns: true, initialTurnsPage: { limit: 1, itemsView: 'full' } });
  const live = active.initialTurnsPage.data[0];
  assert.equal(live.status, 'inProgress');
  assert.equal(live.items.find(item => item.type === 'agentMessage').text, 'held');
  assert.deepEqual(await client.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: 'text', text: 'also this' }] }), { turnId: turn.id });
  await rpc.request('prompt', { message: '/fixture-release' });
  const done = await client.notification('turn/completed', params => params.turn.id === turn.id);
  assert.equal(done.params.turn.status, 'completed');
  const items = (await client.request('thread/items/list', { threadId: thread.id, turnId: turn.id })).data.map(entry => entry.item);
  assert.deepEqual(items.filter(item => item.type === 'userMessage').map(item => item.content[0].text), ['hold', 'also this']);
  assert.deepEqual(items.filter(item => item.type === 'agentMessage').map(item => item.text), ['held:released', 'echo:hold|also this']);

  const { turn: stopped } = await client.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'hold' }] });
  await client.notification('item/agentMessage/delta', params => params.turnId === stopped.id);
  await client.request('turn/interrupt', { threadId: thread.id, turnId: stopped.id });
  assert.equal((await client.notification('turn/completed', params => params.turn.id === stopped.id)).params.turn.status, 'interrupted');
  assert.equal(protocol.active.has(thread.id), false);
});

test('manual compaction appears as a turn and persists in history', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const { client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  await client.turn(thread.id, 'first');
  assert.deepEqual(await client.request('thread/compact/start', { threadId: thread.id }), {});
  const item = await client.notification('item/completed', params => params.item.type === 'contextCompaction');
  const completed = await client.notification('turn/completed', params => params.turn.id === item.params.turnId);
  assert.equal(completed.params.turn.status, 'completed');
  const turns = (await client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', sortDirection: 'asc' })).data;
  assert.deepEqual(turns.at(-1).items, [{ type: 'contextCompaction', id: item.params.item.id }]);
});
