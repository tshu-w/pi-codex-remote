import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { model, setup } from './harness.mjs';
import { textPhase } from '../src/codex.mjs';

test('phone tool cards and message phases retain their contents after reopening history', { timeout: 120000 }, async t => {
  const f = await setup(t);
  await writeFile(join(f.cwd, 'input.txt'), 'fixture-data\n');
  const first = f.start();
  const phone = first.client;
  const { thread } = await phone.request('thread/start', { cwd: f.cwd, model });
  const completed = [];
  for (const prompt of ['read input.txt', 'grep fixture-data', 'find *.txt', 'ls .', 'write output.txt', 'edit output.txt', 'write output.txt replaced', 'mcp__fixture__lookup', 'nested', 'read missing.txt']) {
    const turn = await phone.turn(thread.id, prompt);
    assert.equal(turn.status, 'completed');
    turn.items = phone.records.filter(record => record.method === 'item/completed' && record.params.turnId === turn.id).map(record => record.params.item);
    const texts = turn.items.filter(item => item.type === 'agentMessage');
    assert.deepEqual(texts.map(item => item.phase), ['commentary', 'final_answer'], prompt);
    completed.push(turn);
  }
  for (const [index, action] of ['read', 'search', 'listFiles', 'listFiles'].entries()) {
    const item = completed[index].items.find(item => item.type === 'commandExecution');
    assert.equal(item.commandActions[0].type, action);
    assert.equal(item.exitCode, 0, `${item.command}: ${item.aggregatedOutput}`);
    assert.equal(item.status, 'completed');
    assert.equal(item.command, ['read "input.txt"', 'grep "fixture-data" "."', 'find "*.txt" "."', 'ls "."'][index]);
    assert.ok(item.aggregatedOutput.includes(index === 0 ? 'fixture-data' : 'input.txt'));
  }
  for (const [index, kind, text] of [[4, 'add', '+written'], [5, 'update', '+edited'], [6, 'update', '+replaced']]) {
    const item = completed[index].items.find(item => item.type === 'fileChange');
    assert.equal(item.status, 'completed');
    assert.equal(item.changes[0].kind.type, kind);
    assert.equal(item.changes[0].path, join(f.cwd, 'output.txt'));
    assert.ok(item.changes[0].diff.includes(text));
  }
  const mcp = completed[7].items.find(item => item.type === 'mcpToolCall');
  assert.equal(mcp.server, 'fixture-server');
  assert.equal(mcp.tool, 'lookup-original');
  assert.equal(mcp.result.content[0].text, 'lookup result');
  const nested = completed[8].items;
  assert.equal(nested.find(item => item.type === 'commandExecution').aggregatedOutput, 'fixture-data\n');
  assert.equal(nested.find(item => item.type === 'mcpToolCall').result.content[0].text, 'lookup result');
  const failed = completed[9].items.find(item => item.type === 'commandExecution');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.aggregatedOutput.includes('missing.txt'));
  // The provider simulates pi-agents at the tool boundary; projection and child history are production paths.
  const agentTurn = async args => {
    const turn = await phone.turn(thread.id, `agent ${JSON.stringify(args)}`);
    assert.equal(turn.status, 'completed');
    turn.items = phone.records.filter(record => record.method === 'item/completed' && record.params.turnId === turn.id).map(record => record.params.item);
    completed.push(turn);
    return turn.items;
  };
  const children = [];
  for (const name of ['researcher', 'reviewer']) {
    const items = await agentTurn({ action: 'spawn', name, message: `Inspect as ${name}` });
    const card = items.find(item => item.type === 'collabAgentToolCall');
    assert.ok(card, JSON.stringify(items));
    assert.equal(card.tool, 'spawnAgent');
    assert.equal(card.senderThreadId, thread.id);
    assert.equal(card.receiverThreadIds.length, 1);
    const id = card.receiverThreadIds[0];
    assert.notEqual(id, thread.id);
    children.push(id);
    const read = (await phone.request('thread/read', { threadId: id, includeTurns: true })).thread;
    assert.equal(read.agentNickname, name);
    assert.equal(read.source.subAgent.thread_spawn.parent_thread_id, thread.id);
    assert.equal(read.source.subAgent.thread_spawn.depth, 1);
    assert.equal(read.canAcceptDirectInput, false);
    assert.ok(read.turns.flatMap(turn => turn.items).some(item => item.type === 'agentMessage' && item.text === `child:${name}`));
    const resumed = await phone.request('thread/resume', { threadId: id });
    assert.equal(resumed.thread.canAcceptDirectInput, false);
    const blocked = await phone.raw('turn/start', { threadId: id, input: [{ type: 'text', text: 'must not run', text_elements: [] }] });
    assert.match(blocked.error?.message ?? '', /read.only/i);
  }
  assert.notEqual(children[0], children[1]);
  const forked = (await phone.request('thread/fork', { threadId: children[0] })).thread;
  assert.notEqual(forked.id, children[0]);
  assert.equal(forked.forkedFromId, children[0]);
  assert.equal(forked.agentNickname, null);
  assert.equal(forked.source?.subAgent, undefined);
  assert.equal(forked.canAcceptDirectInput, true);
  assert.equal((await phone.request('thread/read', { threadId: children[0] })).thread.canAcceptDirectInput, false);
  for (const [args, tool, receivers] of [
    [{ action: 'send', target: 'researcher', message: 'Continue' }, 'sendInput', [children[0]]],
    [{ action: 'send', target: ['researcher', 'reviewer'], message: 'Notice', deliverAs: 'write' }, 'sendMessage', children],
    [{ action: 'abort', target: 'reviewer' }, 'interruptAgent', [children[1]]],
  ]) {
    const items = await agentTurn(args);
    const card = items.find(item => item.type === 'collabAgentToolCall');
    assert.ok(card, JSON.stringify(items));
    assert.equal(card.tool, tool);
    assert.deepEqual(card.receiverThreadIds, receivers);
  }
  for (const action of ['wait', 'list']) {
    const items = await agentTurn({ action });
    const card = items.find(item => item.type === 'collabAgentToolCall');
    assert.ok(card, JSON.stringify(items));
    assert.equal(card.tool, action === 'wait' ? 'wait' : 'listAgents');
    assert.equal(card.senderThreadId, thread.id);
    assert.deepEqual(card.receiverThreadIds, action === 'wait' ? [children[0]] : children);
    // Result completion and an idle listing do not establish a child's current turn state.
    assert.deepEqual(card.agentsStates, {});
    assert.ok(!items.some(item => item.type === 'dynamicToolCall' && item.tool === 'agent'));
  }
  const legacy = await agentTurn({ action: 'list', message: 'Legacy' });
  assert.ok(!legacy.some(item => item.type === 'collabAgentToolCall'));
  assert.deepEqual(legacy.find(item => item.type === 'dynamicToolCall' && item.tool === 'agent')?.contentItems,
    [{ type: 'inputText', text: children.map((id, index) => `${['researcher', 'reviewer'][index]} (${id.slice(0, 8)})  idle  ${f.cwd}`).join('\n') }]);
  const hooked = await agentTurn({ action: 'send', target: 'researcher', message: 'Hooked' });
  assert.ok(!hooked.some(item => item.type === 'collabAgentToolCall'));
  assert.ok(JSON.stringify(hooked.find(item => item.type === 'dynamicToolCall')).includes('Additional hook output'));
  for (const card of completed.flatMap(turn => turn.items).filter(item => item.type === 'collabAgentToolCall')) {
    const started = phone.records.filter(record => record.method === 'item/started' && record.params.item.id === card.id);
    assert.equal(started.length, 1);
    assert.equal(started[0].params.item.type, card.type);
    assert.equal(started[0].params.item.tool, card.tool);
    assert.equal(started[0].params.item.senderThreadId, card.senderThreadId);
    assert.deepEqual(started[0].params.item.receiverThreadIds, card.receiverThreadIds);
    assert.deepEqual(started[0].params.item.agentsStates, {});
    assert.deepEqual(card.agentsStates, {});
    assert.equal(started[0].params.item.status, card.status);
    assert.equal(card.status, 'completed');
  }
  assert.ok(!(await f.calls()).some(call => call.prompt === 'must not run'));
  await first.protocol.close();
  const restarted = f.start();
  await restarted.client.request('thread/resume', { threadId: thread.id });
  for (const id of children) {
    const child = (await restarted.client.request('thread/resume', { threadId: id })).thread;
    assert.equal(child.canAcceptDirectInput, false);
    assert.equal(child.source.subAgent.thread_spawn.parent_thread_id, thread.id);
  }
  const history = (await restarted.client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', sortDirection: 'asc' })).data;
  assert.equal(history.length, completed.length);
  for (let i = 0; i < history.length; i++) {
    const stable = items => items.map(({ durationMs, ...item }) => item).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(stable(history[i].items), stable(completed[i].items));
  }
  assert.equal(textPhase({ textSignature: 'legacy-id' }), null);
  assert.equal(textPhase({ textSignature: JSON.stringify({ v: 1, id: 'no-phase' }) }), null);
});
