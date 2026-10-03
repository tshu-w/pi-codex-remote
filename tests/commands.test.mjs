import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { model, setup } from './harness.mjs';

test('command/exec runs the phone git checks inside the official Codex sandbox', { timeout: 60000 }, async t => {
  const f = await setup(t);
  execFileSync('git', ['init', '-q'], { cwd: f.cwd });
  await writeFile(join(f.cwd, 'tracked.txt'), 'x\n');
  const { client } = f.start();
  const run = (command, extra = {}) => client.raw('command/exec', { command, cwd: f.cwd, ...extra });

  const status = await run(['bash', '-lc', 'git status --porcelain'], { sandboxPolicy: { type: 'workspaceWrite' } });
  assert.deepEqual(status.result, { exitCode: 0, stdout: '?? tracked.txt\n', stderr: '' });
  const readOnly = await run(['sh', '-c', `echo x > ${join(f.cwd, 'denied.txt')}`], { sandboxPolicy: { type: 'readOnly' } });
  assert.notEqual(readOnly.result.exitCode, 0);
  const escape = join(homedir(), `codex-remote-escape-${process.pid}`);
  const outside = await run(['sh', '-c', `echo x > ${escape}`], { sandboxPolicy: { type: 'workspaceWrite' } });
  assert.notEqual(outside.result.exitCode, 0);
  await assert.rejects(readFile(escape), { code: 'ENOENT' });
  assert.equal((await run(['true'], { sandboxPolicy: { type: 'dangerFullAccess' } })).error?.code, -32602);
  assert.equal((await run(['sleep', '5'], { timeoutMs: 100 })).result.exitCode, 124);

  // Streaming with stdin, then terminate.
  const pending = run(['cat'], { processId: 'cat', streamStdin: true, streamStdoutStderr: true });
  await client.request('command/exec/write', { processId: 'cat', deltaBase64: Buffer.from('ping').toString('base64') });
  const delta = await client.notification('command/exec/outputDelta', params => params.processId === 'cat');
  assert.equal(Buffer.from(delta.params.deltaBase64, 'base64').toString(), 'ping');
  await client.request('command/exec/terminate', { processId: 'cat' });
  assert.notEqual((await pending).result.exitCode, 0);
});

test('a ! command runs through Pi, streams output and enters the model context', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const { client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  assert.deepEqual(await client.request('thread/shellCommand', { threadId: thread.id, command: 'printf shell-out' }), {});
  const item = await client.notification('item/completed', params => params.item.type === 'commandExecution');
  assert.equal(item.params.item.source, 'userShell');
  assert.equal(item.params.item.aggregatedOutput, 'shell-out');
  assert.equal(item.params.item.exitCode, 0);
  assert.equal(client.records.filter(record => record.method === 'item/commandExecution/outputDelta').map(record => record.params.delta).join(''), 'shell-out');
  await client.notification('turn/completed', params => params.turn.id === item.params.turnId);
  const turns = (await client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full', sortDirection: 'asc' })).data;
  assert.deepEqual(turns.map(turn => turn.id), [item.params.turnId]);
  assert.equal(turns[0].items[0].id, item.params.item.id, 'the shell item keeps its identity in history');
  const reply = await client.turn(thread.id, 'next');
  assert.equal(reply.items.at(-1).text, 'echo:Ran `printf shell-out`\n```\nshell-out\n```|next', 'Pi adds the output to the model context');
});

test('search finds message text, and delete moves the session to Trash and removes the thread', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const { client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  await client.turn(thread.id, 'remember the walrus');
  const other = (await client.request('thread/start', { cwd: f.cwd, model })).thread;
  await client.turn(other.id, 'unrelated');

  const found = await client.request('thread/search', { searchTerm: 'WALRUS' });
  assert.deepEqual(found.data.map(hit => hit.thread.id), [thread.id]);
  assert.match(found.data[0].snippet, /walrus/);

  assert.deepEqual(await client.request('thread/delete', { threadId: thread.id }), {});
  await client.notification('thread/deleted', params => params.threadId === thread.id);
  await assert.rejects(readFile(thread.path), { code: 'ENOENT' });
  for (const archived of [false, true]) {
    const listed = await client.request('thread/list', { archived });
    assert.equal(listed.data.some(entry => entry.id === thread.id), false);
  }
  assert.deepEqual((await client.request('thread/search', { searchTerm: 'walrus' })).data, []);
});
