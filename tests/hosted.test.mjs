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
  async request(type, params = {}) {
    this.requests.push(params.since === undefined ? type : `${type} since ${params.since}`);
    this.onRequest?.(type);
    // Pi answers after the events already in flight, as through pd's relay.
    await tick();
    if (type === 'get_state') return structuredClone(this.state);
    if (type === 'get_entries') {
      // As Pi: the entries after `since`, and the leaf, which navigating the tree moves.
      const index = params.since === undefined ? -1 : this.entries.findIndex(entry => entry.id === params.since);
      if (params.since !== undefined && index === -1) throw new Error(`Entry not found: ${params.since}`);
      const data = { entries: structuredClone(this.entries.slice(index + 1)), leafId: this.leafId ?? this.entries.at(-1)?.id ?? null };
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

async function setup(t, { releaseDelayMs = 60_000, running, children = 0 } = {}) {
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
  // Agents the session started, the first least recently active.
  const agents = Array.from({ length: children }, (_, index) => ({ id: `01a1a516-0000-7000-8000-${String(index).padStart(12, '0')}`, path: join(root, `child-${index}.jsonl`), cwd: root,
    created: new Date(index * 1000), modified: new Date(index * 1000), firstMessage: '', name: `agent-${index}`, isSubAgent: true, agentOwnerId: id }));
  const trash = {
    open: false, moved: [],
    async assertSessionNotOpen() { if (trash.open) throw new Error('Session is open in Pi'); },
    async sessionPids() { return trash.open ? [1] : []; },
    async trashSession(file) { trash.moved.push(file); return join(root, 'Trash.jsonl'); },
  };
  const protocol = new Protocol({
    sessions: { hosted: { command: 'pi-agents' }, persistedPaths: new Map([[path, rpc]]), open: async () => rpc, close: async () => {} },
    history: { listSessions: async () => structuredClone([record, ...agents]), readHistory: async file => file === path ? { header: { type: 'session', version: 3, id }, entries: structuredClone(rpc.entries) } : { header: { type: 'session', version: 3, id: agents.find(agent => agent.path === file).id }, entries: [] }, readSearchText: async () => '', projectTurns },
    cwd: root, stateDir, trash, releaseDelayMs,
  });
  t.after(() => protocol.close());
  await protocol.ready;
  protocol.meta.owned = { [id]: true };
  const client = phone(protocol);
  await protocol.rpc(id);
  await client.request('thread/read', { threadId: id });
  return { protocol, rpc, trash, client, id, agents };
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

test('an Agent result that starts a host turn after an answer shows the Agent completion live and in history', async t => {
  // Whether or not Remote read the Agent's record before its result arrives.
  for (const read of [true, false]) {
    const { rpc, client, id } = await setup(t);
    const worker = '01a1a515-0000-7000-8000-000000000002';
    const reviewer = '01a1a516-0000-7000-8000-000000000003';
    rpc.entries.push(
      { type: 'custom', id: 's0', parentId: null, timestamp: new Date().toISOString(), customType: 'pi-agents-agent', data: { id: worker, name: 'worker' } },
      { type: 'custom', id: 's1', parentId: 's0', timestamp: new Date().toISOString(), customType: 'pi-agents-agent', data: { id: reviewer, name: 'reviewer' } },
      { type: 'message', id: 'u0', parentId: 's1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'earlier', timestamp: Date.now() } },
      { type: 'message', id: 'a0', parentId: 'u0', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }], stopReason: 'stop', timestamp: Date.now() } },
    );
    if (read) await client.request('thread/turns/list', { threadId: id });
    rpc.emit({ type: 'agent_start' });
    const { params: { turn } } = await client.notification('turn/started');
    const message = { role: 'custom', customType: 'pi-agents', content: '<agent-result name="worker" id="01a1a515" status="completed">\ndone\n</agent-result>', display: true, timestamp: Date.now(),
      details: { delivery: 'steer', results: [{ name: 'worker', id: '01a1a515', status: 'completed', body: 'done' }, { name: 'reviewer', id: '01a1a516', status: 'aborted', body: 'stopped' }] } };
    rpc.emit({ type: 'message_end', message });
    rpc.entries.push({ type: 'custom_message', id: 'n1', parentId: 'a0', timestamp: new Date().toISOString(), customType: message.customType, content: message.content, display: true, details: message.details });
    rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await tick();
    rpc.message('a1', { role: 'assistant', content: [{ type: 'text', text: 'reported' }], stopReason: 'stop', timestamp: Date.now() });
    rpc.emit({ type: 'agent_settled' });
    await client.notification('turn/completed');
    const live = client.records.filter(record => record.method === 'item/completed').map(record => record.params.item);
    // Unread, the result is shown once Remote has read the Agent's record, after the reply's first events.
    const activities = live.filter(item => item.type === 'subAgentActivity').map(item => [item.kind, item.agentThreadId, item.agentPath]);
    assert.deepEqual(activities, [['completed', worker, 'worker'], ['interrupted', reviewer, 'reviewer']]);
    assert.deepEqual(live.filter(item => item.type === 'agentMessage').map(item => item.phase), ['final_answer']);
    const history = (await client.request('thread/turns/list', { threadId: id, itemsView: 'full' })).data;
    const shown = history.find(value => value.id === turn.id);
    assert.equal(history.length, 2);
    if (read) assert.deepEqual(shown.items.map(item => item.id), live.map(item => item.id));
    else assert.deepEqual(shown.items.map(item => item.id).sort(), live.map(item => item.id).sort());
  }
});

test('an owned Agent thread is active from its input until its result, while its owner is connected', async t => {
  const { rpc, client, id } = await setup(t);
  const worker = '01a1a515-0000-7000-8000-000000000002';
  const status = () => client.records.filter(record => record.method === 'thread/status/changed' && record.params.threadId === worker).map(record => record.params.status.type);
  const entry = (customType, data) => rpc.entries.push({ type: 'custom', id: `e${rpc.entries.length}`, parentId: rpc.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), customType, data });
  entry('pi-agents-agent', { id: worker, name: 'worker' });
  entry('pi-agents-input', { agentId: worker, id: 'i1', state: 'running' });
  rpc.emit({ type: 'tool_execution_end', toolCallId: 's1', toolName: 'agent', result: { content: [], details: { id: worker, name: 'worker', queued: false } }, isError: false });
  await waitFor(() => status().length === 1, 'active');
  entry('pi-agents-input', { agentId: worker, id: 'i1', state: 'completed' });
  rpc.emit({ type: 'message_end', message: { role: 'custom', customType: 'pi-agents', content: '<agent-result name="worker" id="01a1a515" status="completed">\ndone\n</agent-result>', display: true, timestamp: Date.now() } });
  await waitFor(() => status().length === 2, 'idle');
  // History read on reconnect shows the Agent running again, until its owner's Pi exits.
  entry('pi-agents-input', { agentId: worker, id: 'i2', state: 'queued' });
  await client.request('thread/turns/list', { threadId: id });
  rpc.emit({ type: 'process_exit' });
  assert.deepEqual(status(), ['active', 'notLoaded', 'active', 'notLoaded']);
});

test('a thread lists its running Agents and the 50 last active, and opens any other by ID', async t => {
  const { rpc, client, id, agents } = await setup(t, { children: 55 });
  rpc.entries.push({ type: 'custom', id: 'e0', parentId: null, timestamp: new Date().toISOString(), customType: 'pi-agents-agent', data: { id: agents[0].id, name: 'agent-0', inputs: [{ id: 'i1', state: 'running' }] } });
  // An old session rewritten today keeps its place: recency is its last entry's time.
  agents[5].lastActive = new Date(4000);
  agents[2].lastActive = new Date(100_000);
  await client.request('thread/turns/list', { threadId: id });
  const listed = (await client.request('thread/list', { ancestorThreadId: id, sourceKinds: ['subAgentThreadSpawn'], limit: 200, sortKey: 'created_at' })).data;
  assert.deepEqual(listed.map(thread => thread.id), [...agents.slice(6).reverse(), agents[2], agents[0]].map(agent => agent.id));
  assert.equal(listed.at(-1).status.type, 'active');
  // A page's cursor continues the list after another Agent becomes the 50th last active.
  const first = await client.request('thread/list', { ancestorThreadId: id, sourceKinds: ['subAgentThreadSpawn'], limit: 2, sortKey: 'created_at', sortDirection: 'asc' });
  assert.deepEqual(first.data.map(thread => thread.id), [agents[0].id, agents[2].id]);
  agents[2].lastActive = new Date(0);
  agents[1].lastActive = new Date(200_000);
  const next = await client.request('thread/list', { ancestorThreadId: id, sourceKinds: ['subAgentThreadSpawn'], limit: 1, sortKey: 'created_at', sortDirection: 'asc', cursor: first.nextCursor });
  assert.deepEqual(next.data.map(thread => thread.id), [agents[6].id]);
  // A card in the owner's history still opens an Agent the list leaves out.
  const hidden = agents[3].id;
  assert.equal((await client.request('thread/read', { threadId: hidden, includeTurns: true })).thread.id, hidden);
  assert.deepEqual((await client.request('thread/turns/list', { threadId: hidden })).data, []);
  assert.equal((await client.request('thread/resume', { threadId: hidden })).thread.id, hidden);
});

test('a history is read again from its last known entry, and in full on another branch or session', async t => {
  const { rpc, client, id } = await setup(t);
  const message = (entryId, parentId, role) => rpc.entries.push({ type: 'message', id: entryId, parentId, timestamp: new Date().toISOString(),
    message: role === 'user' ? { role, content: entryId, timestamp: Date.now() } : { role, content: [{ type: 'text', text: entryId }], stopReason: 'stop', timestamp: Date.now() } });
  const list = async () => (await client.request('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'asc' })).data.map(turn => turn.items.map(item => item.id));
  message('u1', null, 'user'); message('a1', 'u1', 'assistant');
  assert.deepEqual(await list(), [['u1', 'a1:0']]);
  message('u2', 'a1', 'user'); message('a2', 'u2', 'assistant');
  rpc.requests.length = 0;
  assert.deepEqual(await list(), [['u1', 'a1:0'], ['u2', 'a2:0']]);
  assert.deepEqual(rpc.requests.filter(request => request.startsWith('get_entries')), ['get_entries since a1']);
  // Navigating the tree to the first turn and continuing there replaces the later turns.
  rpc.leafId = 'a3'; message('u3', 'a1', 'user'); message('a3', 'u3', 'assistant');
  assert.deepEqual(await list(), [['u1', 'a1:0'], ['u3', 'a3:0']]);
  // Another session has none of the entries known.
  rpc.entries = []; rpc.leafId = undefined; message('n1', null, 'user');
  rpc.requests.length = 0;
  assert.deepEqual(await list(), [['n1']]);
  assert.deepEqual(rpc.requests.filter(request => request.startsWith('get_entries')), ['get_entries since a3', 'get_entries']);
});

test('the app scans a parent from its latest 300 turns, and other reads start at its first', async t => {
  const { rpc, client, id } = await setup(t);
  for (let index = 0; index < 305; index++) {
    rpc.entries.push({ type: 'message', id: `u${index}`, parentId: rpc.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'ask', timestamp: Date.now() } });
    rpc.entries.push({ type: 'message', id: `a${index}`, parentId: `u${index}`, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now() } });
  }
  const scan = [];
  let cursor = null;
  do {
    const page = await client.request('thread/turns/list', { threadId: id, sortDirection: 'asc', limit: 100, itemsView: 'notLoaded', cursor });
    scan.push(...page.data.map(turn => turn.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual([scan.length, scan[0], scan.at(-1)], [300, 'u5', 'u304']);
  assert.equal((await client.request('thread/turns/list', { threadId: id, sortDirection: 'asc', limit: 1, itemsView: 'notLoaded' })).data[0].id, 'u0');
  assert.equal((await client.request('thread/turns/list', { threadId: id, sortDirection: 'asc', limit: 100, itemsView: 'full' })).data[0].id, 'u0');
  // Scrolling back still reaches the first turn.
  let back = await client.request('thread/turns/list', { threadId: id, sortDirection: 'desc', limit: 5, itemsView: 'notLoaded', cursor: null });
  const seen = [...back.data];
  while (back.nextCursor) seen.push(...(back = await client.request('thread/turns/list', { threadId: id, sortDirection: 'desc', limit: 5, itemsView: 'notLoaded', cursor: back.nextCursor })).data);
  assert.equal(seen.at(-1).id, 'u0');
});

test('a message from another Agent shows nothing live or in history, and the reply it prompts is its turn', async t => {
  const { rpc, client, id } = await setup(t);
  rpc.entries.push(
    { type: 'message', id: 'u0', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'earlier', timestamp: Date.now() } },
    { type: 'message', id: 'a0', parentId: 'u0', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }], stopReason: 'stop', timestamp: Date.now() } },
  );
  rpc.emit({ type: 'agent_start' });
  const { params: { turn } } = await client.notification('turn/started');
  const message = { role: 'custom', customType: 'pi-agents', content: '<agent-message name="pi-storage-audit" id="01a1a515" note="Reply with send">\nfound it\n</agent-message>', display: true, timestamp: Date.now(),
    details: { delivery: 'followUp', sender: { id: '01a1a515', name: 'pi-storage-audit' } } };
  rpc.emit({ type: 'message_end', message });
  rpc.entries.push({ type: 'custom_message', id: 'n1', parentId: 'a0', timestamp: new Date().toISOString(), customType: message.customType, content: message.content, display: true, details: message.details });
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  await tick();
  rpc.message('a1', { role: 'assistant', content: [{ type: 'text', text: 'replied' }], stopReason: 'stop', timestamp: Date.now() });
  rpc.emit({ type: 'agent_settled' });
  await client.notification('turn/completed');
  const live = client.records.filter(record => record.method === 'item/completed').map(record => record.params.item);
  assert.deepEqual(live.map(item => [item.type, item.text]), [['agentMessage', 'replied']]);
  const history = (await client.request('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'asc' })).data;
  assert.deepEqual(history.map(value => [value.id, value.items.map(item => item.id)]), [['u0', ['u0', 'a0:0']], [turn.id, live.map(item => item.id)]]);
});

test('a turn started elsewhere while Remote sets up its own keeps the thread and still completes', async t => {
  const { rpc, client, id } = await setup(t);
  // The terminal starts a run while Remote switches the model for its turn.
  rpc.onRequest = type => { if (type === 'set_model') rpc.emit({ type: 'agent_start' }); };
  const response = await client.raw('turn/start', { threadId: id, model: 'fixture/scripted', input: [{ type: 'text', text: 'mine', text_elements: [] }] });
  assert.match(response.error.message, /already running/);
  const { params: { turn } } = await client.notification('turn/started');
  rpc.emit({ type: 'agent_settled' });
  assert.equal((await client.notification('turn/completed', params => params.turn.id === turn.id)).params.turn.id, turn.id);
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
