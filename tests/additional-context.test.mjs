import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { model, setup } from './harness.mjs';

const additionalContext = {
  selected_page: { kind: 'untrusted', value: 'Desktop-only selected Page text' },
  arbitrary_source: { kind: 'application', value: 'Desktop-only application instructions' },
};
const annotatedInput = "\n# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index=\"N\"}`, where N is its one-based array position (for example, `:codex-annotation{index=\"1\"}`). Do not use unstructured annotation labels.\n<response-annotations>\n[{\"text\":\"你好呀！\",\"source\":{\"messageId\":\"fixture-response\",\"startOffset\":0,\"endOffset\":4}}]\n</response-annotations>\n\n## My request:\n你是谁？\n";
const collaborationMode = { mode: 'default', settings: { model, reasoning_effort: 'none', developer_instructions: null } };

test('desktop context is ignored on start and steer; default collaboration maps model and effort', async t => {
  const f = await setup(t);
  const extension = join(f.root, 'provider.ts');
  const source = await readFile(extension, 'utf8');
  await writeFile(extension, source.replace("models: [{ id: 'scripted'", "models: [{ id: 'reasoning', name: 'Reasoning fixture', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { id: 'scripted'"));
  const { protocol, client } = f.start({ releaseDelayMs: 60000 });
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  const params = { threadId: thread.id, turnTrigger: 'composer', additionalContext,
    input: [{ type: 'text', text: 'hold', text_elements: [] }], cwd: null, permissions: null,
    runtimeWorkspaceRoots: null, model: null, serviceTier: null, effort: null, multiAgentMode: 'explicitRequestOnly',
    summary: null, personality: null, outputSchema: null, sandboxPolicy: null, approvalPolicy: null, approvalsReviewer: null,
    collaborationMode: { mode: 'default', settings: { model: 'fixture/reasoning', reasoning_effort: 'medium', developer_instructions: null } },
    responsesapiClientMetadata: {} };
  const original = structuredClone(params);
  const { turn } = await client.request('turn/start', params);
  await client.notification('item/agentMessage/delta', value => value.turnId === turn.id);
  const rpc = protocol.loaded.get(thread.id);
  assert.equal(rpc.state.model.id, 'reasoning');
  assert.equal(rpc.state.thinkingLevel, 'medium');
  await client.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, additionalContext,
    input: [{ type: 'text', text: 'also this' }] });
  await rpc.request('prompt', { message: '/fixture-release' });
  const completed = await client.notification('turn/completed', value => value.turn.id === turn.id);
  assert.equal(completed.params.turn.items.at(-1).text, 'echo:hold|also this');
  assert.deepEqual((await f.calls()).map(call => call.prompt), ['hold', 'also this']);
  assert.deepEqual(params, original);
  const annotated = await client.turn(thread.id, annotatedInput, { additionalContext, disabledPluginIds: [],
    collaborationMode: { mode: 'default', settings: { model: null, reasoning_effort: null, developer_instructions: null } } });
  assert.equal(annotated.status, 'completed');
  assert.equal(rpc.state.model.id, 'reasoning');
  assert.equal(rpc.state.thinkingLevel, 'medium');
  assert.equal((await f.calls()).at(-1).prompt, annotatedInput);
  const history = await readFile(thread.path, 'utf8');
  for (const entry of Object.values(additionalContext)) assert.ok(!history.includes(entry.value), 'desktop context is never injected into history');
});

test('collaboration conflicts and unsupported instructions, modes, permissions and effort remain rejected', async t => {
  const f = await setup(t);
  const { client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  const params = { threadId: thread.id, input: [{ type: 'text', text: 'plain text' }], additionalContext, collaborationMode };
  const mode = patch => ({ ...collaborationMode, ...patch });
  const settings = patch => mode({ settings: { ...collaborationMode.settings, ...patch } });
  for (const patch of [
    { collaborationMode: mode({ mode: 'plan' }) },
    { collaborationMode: settings({ developer_instructions: 'Custom instructions' }) },
    { collaborationMode: settings({ extra: true }) },
    { collaborationMode: settings({ model: 'unqualified' }) },
    { collaborationMode: settings({ model: '' }) },
    { disabledPluginIds: ['some-plugin'] }, { disabledPluginIds: 'some-plugin' },
    { collaborationMode: settings({ reasoning_effort: 'ultra' }) },
    { collaborationMode: settings({ reasoning_effort: 'medium' }) },
    { model: 'fixture/other' }, { effort: 'high' }, { reasoningEffort: 'low' },
    { config: { model_reasoning_effort: 'medium' } },
    { approvalPolicy: 'on-request' }, { permissions: ':read-only' }, { sandboxPolicy: { type: 'readOnly' } },
    { developerInstructions: 'Custom top-level instructions' },
  ]) {
    const response = await client.raw('turn/start', { ...params, ...patch });
    assert.equal(response.error?.code, -32602, JSON.stringify(patch));
  }
  assert.deepEqual(await f.calls(), []);
  for (const context of [undefined, null, {}, additionalContext]) {
    const turn = await client.turn(thread.id, 'plain text', { additionalContext: context, collaborationMode,
      model: 'fixture/%73cripted', effort: 'off', reasoningEffort: 'none', config: { model_reasoning_effort: 'off' } });
    assert.equal(turn.status, 'completed');
  }
  assert.deepEqual((await f.calls()).map(call => call.prompt), Array(4).fill('plain text'));
});
