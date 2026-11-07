import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
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
