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
  await first.protocol.close();
  const restarted = f.start();
  await restarted.client.request('thread/resume', { threadId: thread.id });
  const history = (await restarted.client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', sortDirection: 'asc' })).data;
  assert.equal(history.length, completed.length);
  for (let i = 0; i < history.length; i++) {
    const stable = items => items.map(({ durationMs, ...item }) => item).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(stable(history[i].items), stable(completed[i].items));
  }
  assert.equal(textPhase({ textSignature: 'legacy-id' }), null);
  assert.equal(textPhase({ textSignature: JSON.stringify({ v: 1, id: 'no-phase' }) }), null);
});
