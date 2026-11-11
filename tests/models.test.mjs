import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { paths, setEnabled } from '../src/daemon.mjs';
import { configHandlers } from '../src/handlers/config.mjs';
import { setup } from './harness.mjs';

test('model/list scopes defaults, retains client session models and paginates after filtering', async () => {
  const models = ['scoped', 'default', 'loaded', 'saved', 'other'].map(id => ({ provider: 'fixture', id, input: ['text'] }));
  const emit = () => {};
  const rpc = { modelScope: [models[0]], state: { model: models[1] }, request: async () => ({ models }) };
  const protocol = {
    probeRpc: async () => rpc,
    subscribers: new Map([['loaded', new Set([emit])], ['saved', new Set([emit])], ['other', new Set([() => {}])]]),
    loaded: new Map([['loaded', { state: { model: models[2] } }], ['other', { state: { model: models[4] } }]]),
    entries: async () => ({ entries: [{ id: 'model', parentId: null, type: 'model_change', provider: 'fixture', modelId: 'saved' }] }),
  };
  const list = params => configHandlers['model/list'].call(protocol, params, emit);
  const first = await list({ limit: 2 });
  const second = await list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual([...first.data, ...second.data].map(model => model.id), ['fixture/scoped', 'fixture/default', 'fixture/loaded', 'fixture/saved']);
  assert.equal(second.nextCursor, null);
  const hidden = await list({ includeHidden: true });
  assert.deepEqual(hidden.data.filter(model => model.hidden).map(model => model.id), ['fixture/other']);
  rpc.modelScope = [];
  assert.equal((await list({})).data.length, models.length, 'unconfigured scope keeps all available models');
});

test('Pi-side model and effort changes notify the app, whose next turn can retain the new selection', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const { protocol, client } = f.start();
  const p = paths();
  await mkdir(p.state, { recursive: true });
  await setEnabled(true);
  const controls = [];
  const server = createServer(socket => socket.once('data', bytes => {
    const request = JSON.parse(bytes.toString());
    controls.push(request);
    void (async () => {
      if (request.action === 'settingsChanged') await protocol.refreshThreadSettings(request.sessionId);
      socket.end(`${JSON.stringify({ result: {} })}\n`);
    })().catch(error => socket.end(`${JSON.stringify({ error: error.message })}\n`));
  }));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(p.socket, resolve));
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model: 'fixture/scripted' });
  const rpc = protocol.loaded.get(thread.id);
  await rpc.request('set_model', { provider: 'fixture', modelId: 'reasoning' });
  const changed = await client.notification('thread/settings/updated', params => params.threadSettings.model === 'fixture/reasoning');
  assert.equal(changed.params.threadId, thread.id);
  assert.equal(changed.params.threadSettings.collaborationMode.settings.model, 'fixture/reasoning');
  assert.deepEqual(controls.filter(request => request.action === 'settingsChanged'), [{ action: 'settingsChanged', sessionId: thread.id }]);
  await rpc.request('set_thinking_level', { level: 'high' });
  const thinking = await client.notification('thread/settings/updated', params => params.threadSettings.effort === 'high');
  assert.equal(thinking.params.threadSettings.model, 'fixture/reasoning');
  assert.equal(thinking.params.threadSettings.collaborationMode.settings.reasoning_effort, 'high');
  const resumed = await client.request('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(resumed.model, 'fixture/reasoning');
  assert.equal(resumed.reasoningEffort, 'high');
  const settings = thinking.params.threadSettings;
  await client.turn(thread.id, 'keep the selection', { model: settings.model, collaborationMode: settings.collaborationMode });
  const entries = (await readFile(thread.path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.findLast(entry => entry.message?.role === 'assistant').message.model, 'reasoning');
  await client.request('thread/settings/update', { threadId: thread.id, model: 'fixture/scripted', effort: 'none' });
  assert.equal((await client.request('thread/resume', { threadId: thread.id, excludeTurns: true })).model, 'fixture/scripted', 'an explicit app selection still changes Pi');
});

test('the Remote RPC extension publishes Pi-resolved enabledModels scope', async t => {
  const f = await setup(t);
  const path = join(f.config, 'settings.json');
  const settings = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...settings, enabledModels: ['fixture/scripted'] }));
  const { protocol, client } = f.start();
  const result = await client.request('model/list', {});
  const rpc = await protocol.probeRpc();
  assert.deepEqual(rpc.modelScope, [{ provider: 'fixture', id: 'scripted' }]);
  assert.deepEqual(result.data.map(model => model.id), ['fixture/scripted']);
});
