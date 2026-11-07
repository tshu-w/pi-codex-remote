// pi-agents hosts, with a fake RPC client standing in for `pd --mode rpc`.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { projectTurns } from '../src/history.mjs';
import { Protocol } from '../src/protocol.mjs';
import { phone, waitFor } from './harness.mjs';

const model = { provider: 'fixture', id: 'scripted', input: ['text'] };

class HostedRpc {
  constructor(id, sessionFile, cwd) {
    Object.assign(this, { cwd, entries: [], requests: [], listeners: new Set(), messageEnds: 0, messageEndsAt: new WeakMap(), child: { pid: -1 } });
    this.state = { sessionId: id, sessionFile, model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  }
  get id() { return this.state.sessionId; }
  get sessionFile() { return this.state.sessionFile; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) {
    if (event.type === 'message_end') this.messageEnds++;
    if (event.type === 'agent_start') this.state.isStreaming = true;
    if (event.type === 'agent_settled') this.state.isStreaming = false;
    for (const listener of this.listeners) listener(event);
  }
  // Another client's message: persisted as Pi does, right after its message_end.
  message(id, message) {
    this.emit({ type: 'message_end', message });
    this.entries.push({ type: 'message', id, parentId: this.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message });
  }
  async request(type) {
    this.requests.push(type);
    // Pi answers after the events already in flight, as through pd's relay.
    await tick();
    if (type === 'get_state') return structuredClone(this.state);
    if (type === 'get_entries') {
      const data = { entries: structuredClone(this.entries), leafId: this.entries.at(-1)?.id ?? null };
      this.messageEndsAt.set(data, this.messageEnds);
      return data;
    }
    if (type === 'abort' && this.state.isStreaming) setTimeout(() => {
      this.message('a-aborted', { role: 'assistant', content: [], stopReason: 'aborted', timestamp: Date.now() });
      this.emit({ type: 'agent_settled' });
    });
  }
  async refresh() { return this.request('get_state'); }
  async close() { this.closed = true; }
}

async function setup(t, { releaseDelayMs = 60_000, running } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-remote-hosted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '01a1a514-0000-7000-8000-000000000001';
  const path = join(root, 'session.jsonl');
  await writeFile(path, '');
  const rpc = new HostedRpc(id, path, root);
  if (running) {
    rpc.state.isStreaming = true;
    running(rpc);
  }
  const stateDir = join(root, 'state');
  const record = { id, path, cwd: root, created: new Date(), modified: new Date(), firstMessage: '', isSubAgent: false };
  const trash = {
    open: false, moved: [],
    async assertSessionNotOpen() { if (trash.open) throw new Error('Session is open in Pi'); },
    async sessionPids() { return trash.open ? [1] : []; },
    async trashSession(file) { trash.moved.push(file); return join(root, 'Trash.jsonl'); },
  };
  const protocol = new Protocol({
    sessions: { hosted: { command: 'pi-agents' }, persistedPaths: new Map([[path, rpc]]), open: async () => rpc, close: async () => {} },
    history: { listSessions: async () => [structuredClone(record)], readHistory: async () => ({ header: { type: 'session', version: 3, id }, entries: structuredClone(rpc.entries) }), readSearchText: async () => '', projectTurns },
    cwd: root, stateDir, trash, releaseDelayMs,
  });
  t.after(() => protocol.close());
  await protocol.ready;
  protocol.meta.owned = { [id]: true };
  const client = phone(protocol);
  await protocol.rpc(id);
  await client.request('thread/read', { threadId: id });
  return { protocol, rpc, trash, client, id };
}

test('a turn started in the terminal is shown live and matches its history', async t => {
  const { rpc, client, id } = await setup(t);
  rpc.emit({ type: 'agent_start' });
  // The prompt is persisted before Remote's snapshot of the entries arrives.
  rpc.message('u1', { role: 'user', content: 'from terminal', timestamp: Date.now() });
  const { params: { turn } } = await client.notification('turn/started');
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  await tick();
  rpc.message('a1', { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now() });
  rpc.emit({ type: 'agent_settled' });
  const completed = (await client.notification('turn/completed')).params.turn;
  assert.equal(completed.id, turn.id);
  assert.equal(completed.status, 'completed');
  const live = client.records.filter(record => record.method === 'item/completed').map(record => record.params.item);
  assert.deepEqual(live.map(item => item.type), ['userMessage', 'agentMessage']);
  const [history] = (await client.request('thread/turns/list', { threadId: id, itemsView: 'full' })).data;
  assert.equal(history.id, turn.id);
  assert.deepEqual(history.items.map(item => item.id), live.map(item => item.id));
});

test('Remote steers and interrupts a terminal turn without clearing Pi\'s queue', async t => {
  const { rpc, client, id } = await setup(t);
  rpc.emit({ type: 'agent_start' });
  const { params: { turn } } = await client.notification('turn/started');
  const input = [{ type: 'text', text: 'more', text_elements: [] }];
  assert.match((await client.raw('turn/start', { threadId: id, input })).error.message, /turn\/steer/);
  await client.request('turn/steer', { threadId: id, expectedTurnId: turn.id, input });
  await client.request('turn/interrupt', { threadId: id, turnId: turn.id });
  assert.equal((await client.notification('turn/completed')).params.turn.status, 'interrupted');
  assert.ok(rpc.requests.includes('steer') && rpc.requests.includes('abort'));
  assert.ok(!rpc.requests.some(type => ['clear_queue', 'abort_bash'].includes(type)), rpc.requests.join());
});

test('releasing a hosted thread disconnects after the delay and leaves the host alone', async t => {
  const { protocol, rpc, client, id } = await setup(t, { releaseDelayMs: 50 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(rpc.closed, undefined, 'a viewed thread stays connected');
  client.disconnect();
  await waitFor(() => rpc.closed, 'released');
  assert.equal(protocol.loaded.has(id), false);
  assert.ok(!rpc.requests.includes('prompt'), 'no release command is sent to the host');
});

test('archiving a session its host still holds moves it to Trash once the host exits', async t => {
  const { protocol, rpc, trash, client, id } = await setup(t, { releaseDelayMs: 50 });
  trash.open = true;
  rpc.emit({ type: 'agent_start' });
  await client.notification('turn/started');
  await client.request('thread/archive', { threadId: id });
  assert.ok(rpc.closed);
  assert.ok(!rpc.requests.includes('abort'), 'a terminal turn keeps running');
  assert.deepEqual((await client.request('thread/list', {})).data, []);
  await client.request('thread/unarchive', { threadId: id });
  trash.open = false;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(trash.moved, [], 'unarchiving cancels the move');
  trash.open = true;
  await client.request('thread/delete', { threadId: id });
  assert.deepEqual((await client.request('thread/list', {})).data, []);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(trash.moved, [], 'nothing moves while the host holds the session');
  trash.open = false;
  await waitFor(() => trash.moved.length, 'moved after the host exits');
  assert.deepEqual(trash.moved, [rpc.sessionFile]);
  await waitFor(() => !protocol.meta.trashPending?.[id], 'pending mark cleared');
  assert.equal(protocol.catalog.has(id), false);
});

test('joining a host mid-turn continues the turn its history shows', async t => {
  // Before joining, the terminal's turn wrote its prompt, and possibly a reply.
  for (const written of [[], ['a1:0']]) {
    const { rpc, client, id } = await setup(t, { running: rpc => {
      rpc.message('u1', { role: 'user', content: 'from terminal', timestamp: Date.now() });
      if (written.length) rpc.message('a1', { role: 'assistant', content: [{ type: 'text', text: 'working' }], stopReason: 'toolUse', timestamp: Date.now() });
    } });
    assert.equal((await client.request('thread/read', { threadId: id })).thread.status.type, 'active');
    // Remote joined after this message started.
    rpc.message('a2', { role: 'assistant', content: [{ type: 'text', text: 'calling' }], stopReason: 'toolUse', timestamp: Date.now() });
    rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    rpc.message('a3', { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now() });
    rpc.emit({ type: 'agent_settled' });
    assert.equal((await client.notification('turn/completed')).params.turn.id, 'u1');
    const history = (await client.request('thread/turns/list', { threadId: id, itemsView: 'full' })).data;
    assert.deepEqual(history.map(turn => turn.id), ['u1']);
    const live = client.records.filter(record => record.method === 'item/completed').map(record => record.params.item.id);
    assert.equal(new Set(live).size, 2);
    assert.deepEqual(history[0].items.map(item => item.id), ['u1', ...written, ...live]);
  }
});

test('a turn whose host stopped without events still finishes', async t => {
  const { rpc, client } = await setup(t, { releaseDelayMs: 50 });
  rpc.emit({ type: 'agent_start' });
  const { params: { turn } } = await client.notification('turn/started');
  // pd reopened the session: Pi is idle and no event or failed request reports it.
  rpc.state.isStreaming = false;
  assert.equal((await client.notification('turn/completed', params => params.turn.id === turn.id)).params.turn.id, turn.id);
});
