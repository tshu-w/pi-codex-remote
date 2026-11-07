// Steered input and notices from extensions such as pi-exec and pi-agents, in history and live.
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTurns, runningAgents } from '../src/history.mjs';
import { model, setup, waitFor } from './harness.mjs';

const timestamp = new Date(0).toISOString();
const user = (id, content) => ({ type: 'message', id, timestamp, message: { role: 'user', content } });
const assistant = (id, stopReason, content) => ({ type: 'message', id, timestamp, message: { role: 'assistant', stopReason, content } });
const text = value => ({ type: 'text', text: value });
const call = id => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'true' } });
const result = id => ({ type: 'message', id: `r-${id}`, timestamp, message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: [text('ok')], isError: false } });
const notice = (id, content, customType = 'pi-agents', details) => ({ type: 'custom_message', id, timestamp, customType, content, display: true, details });
const bashResult = (id, status, output) => notice(id, `<bash-result pgid="7" status="${status}">\nCommand: make\nWall time 2.0 seconds\nOutput:\n\n${output}\n</bash-result>`, 'bash-result', { pgid: 7, command: 'make\ncheck', status, seconds: 2 });
// Pi links each entry to the previous one on the branch.
const chain = entries => entries.map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null }));
const view = turns => turns.map(turn => [turn.id, turn.status, turn.items.map(item => item.type === 'agentMessage' ? `${item.id}:${item.phase}` : item.id)]);
const agentResult = (name, status, body) => `<agent-result name="${name}" id="0${name}" status="${status}">\n${body}\n</agent-result>`;
// pi-agents records each Agent it starts, and its notices carry their results.
const spawned = name => ({ type: 'custom', id: `s-${name}`, timestamp, customType: 'pi-agents-agent', data: { id: `0${name}-full`, name } });
const results = (id, ...values) => notice(id, values.map(([name, status, body]) => agentResult(name, status, body)).join('\n\n'), 'pi-agents',
  { delivery: 'steer', results: values.map(([name, status, body]) => ({ name, id: `0${name}`, status, body })) });

test('input steered into a running turn stays in that turn', () => {
  const turns = projectTurns(chain([
    user('u1', 'first'), assistant('a1', 'toolUse', [text('looking'), call('c1')]), result('c1'),
    user('u2', 'steered'), assistant('a2', 'stop', [text('answer')]),
    user('u3', 'next'), assistant('a3', 'stop', [text('again')]),
  ]));
  assert.deepEqual(view(turns), [
    ['u1', 'completed', ['u1', 'a1:0:commentary', 'c1', 'u2', 'a2:0:final_answer']],
    ['u3', 'completed', ['u3', 'a3:0:final_answer']],
  ]);
});

test('input Remote saw start another turn opens it after a run Pi never finished', () => {
  const entries = chain([
    user('u1', 'first'), assistant('a1', 'toolUse', [call('c1')]),
    user('u2', 'after restart'), user('u3', 'steered'), assistant('a2', 'stop', [text('answer')]),
  ]);
  const entryMappings = { u1: { turnId: 't1' }, u2: { turnId: 't2' }, u3: { turnId: 't2' } };
  assert.deepEqual(view(projectTurns(entries, { entryMappings })), [
    ['u1', 'inProgress', ['u1', 'c1']],
    ['u2', 'completed', ['u2', 'u3', 'a2:0:final_answer']],
  ]);
});

test('notices join a running turn and open their own turn after an answer', () => {
  const turns = projectTurns(chain([
    spawned('a'), spawned('b'), user('u1', 'first'), assistant('a1', 'toolUse', [call('c1')]), result('c1'),
    bashResult('n1', 'completed', 'ok\n'), assistant('a2', 'stop', [text('answer')]),
    results('n2', ['a', 'completed', 'done']), results('n3', ['b', 'completed', 'done']),
    assistant('a3', 'stop', [text('reported')]),
    notice('n4', '<agent-message name="a" id="0a">\nhi\n</agent-message>'),
    user('u2', 'next'), assistant('a4', 'stop', [text('done')]),
  ]));
  assert.deepEqual(view(turns), [
    ['u1', 'completed', ['u1', 'c1', 'n1', 'a2:0:final_answer']],
    ['n2', 'completed', ['n2', 'n2:1', 'n3', 'n3:1', 'a3:0:final_answer']],
    // A notice delivered while idle without a run still precedes the next prompt's turn.
    ['n4', 'completed', ['n4:commentary']],
    ['u2', 'completed', ['u2', 'a4:0:final_answer']],
  ]);
});

test('notices show as the steps they report, or as a header and their body', () => {
  const turns = projectTurns(chain([
    spawned('a'), spawned('b'), user('u1', 'go'), assistant('a1', 'toolUse', [call('c1')]), result('c1'),
    bashResult('n1', 'completed', 'ok\n'), bashResult('n2', 'failed', 'oops\n\nCommand exited with code 2'),
    results('n3', ['a', 'completed', '**first**'], ['b', 'aborted', 'second']),
    // Without a record of the Agent, the result reads as text.
    results('n4', ['c', 'completed', 'third']),
    notice('n5', '<agent-message name="a" id="0a" note="Reply with send">\nhi\n</agent-message>', 'pi-agents', { delivery: 'followUp', sender: { id: '0a', name: 'a' } }),
    // Without its details, a message reads as text.
    notice('n7', '<agent-message name="a" id="0a">\nbye\n</agent-message>'),
    notice('n6', [text('Ran `/program x`'), { type: 'image', mimeType: 'image/png', data: 'AA==' }], 'pi-agents-program'),
  ]), { cwd: '/work' });
  const items = turns[0].items.slice(2);
  assert.deepEqual(items.slice(0, 2), [
    { type: 'commandExecution', id: 'n1', command: 'make\ncheck', cwd: '/work', commandActions: [], aggregatedOutput: 'ok\n',
      durationMs: 2000, exitCode: 0, processId: null, pluginId: null, scriptPath: null, source: 'agent', status: 'completed' },
    { type: 'commandExecution', id: 'n2', command: 'make\ncheck', cwd: '/work', commandActions: [], aggregatedOutput: 'oops\n\nCommand exited with code 2',
      durationMs: 2000, exitCode: 2, processId: null, pluginId: null, scriptPath: null, source: 'agent', status: 'failed' },
  ]);
  const step = (id, name, status, body) => ({ type: 'dynamicToolCall', id, tool: 'agent', namespace: null, arguments: { action: 'result', target: name, status },
    contentItems: [{ type: 'inputText', text: body }], durationMs: null, status: status === 'completed' ? 'completed' : 'failed', success: status === 'completed' });
  assert.deepEqual(items.slice(2, 6), [
    { type: 'subAgentActivity', id: 'n3', kind: 'completed', agentThreadId: '0a-full', agentPath: 'a', model: null, reasoningEffort: null },
    step('n3:1', 'a', 'completed', '**first**'),
    { type: 'subAgentActivity', id: 'n3:2', kind: 'interrupted', agentThreadId: '0b-full', agentPath: 'b', model: null, reasoningEffort: null },
    step('n3:3', 'b', 'aborted', 'second'),
  ]);
  assert.deepEqual(items[7], { type: 'dynamicToolCall', id: 'n5', tool: 'agent', namespace: null, arguments: { action: 'message', from: 'a' },
    contentItems: [{ type: 'inputText', text: 'hi' }], durationMs: null, status: 'completed', success: true });
  assert.deepEqual(items.filter((_, index) => index !== 7).slice(6).map(item => [item.type, item.phase, item.text]), [
    ['agentMessage', 'commentary', 'Agent result from **c** (0c): completed\n\nthird'],
    ['agentMessage', 'commentary', 'Message from **a** (0a)\n\nbye'],
    ['agentMessage', 'commentary', 'Ran `/program x`'],
  ]);
});

test('an Agent runs while its latest input is queued or running', () => {
  const agent = (id, inputs) => ({ type: 'custom', customType: 'pi-agents-agent', data: { id, name: id, ...(inputs && { inputs }) } });
  const input = (agentId, id, state) => ({ type: 'custom', customType: 'pi-agents-input', data: { agentId, id, state } });
  assert.deepEqual([...runningAgents([
    // Older Sessions record every input with the Agent.
    agent('old', [{ id: 'i1', state: 'completed' }, { id: 'i2', state: 'running' }]),
    agent('done'), input('done', 'i1', 'running'), input('done', 'i1', 'completed'),
    agent('busy'), input('busy', 'i1', 'completed'), input('busy', 'i2', 'queued'),
    input('unknown', 'i1', 'running'),
  ])], ['old', 'busy']);
});

test('a notice that starts a turn in an idle Pi is shown live and matches its history', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const { protocol, client } = f.start();
  const { thread } = await client.request('thread/start', { cwd: f.cwd, model });
  // A saved thread's Pi is released once idle, so the notice arrives in a new thread's Pi.
  const rpc = protocol.loaded.get(thread.id);
  await rpc.request('prompt', { message: '/fixture-notify make check' });
  const { params: { turn } } = await waitFor(() => client.records.filter(record => record.method === 'turn/started')[0], 'notice turn started');
  await client.notification('turn/completed', params => params.turn.id === turn.id);
  const live = client.records.filter(record => record.method === 'item/completed' && record.params.turnId === turn.id).map(record => record.params.item);
  assert.deepEqual(live.map(item => [item.type, item.phase]), [['commandExecution', undefined], ['agentMessage', 'final_answer']]);
  assert.deepEqual([live[0].command, live[0].cwd, live[0].aggregatedOutput, live[0].exitCode, live[0].durationMs, live[0].status], ['make check', f.cwd, 'ok\n', 0, 1500, 'completed']);
  const history = (await client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full' })).data;
  const shown = history.find(value => value.id === turn.id);
  assert.ok(shown, JSON.stringify(history.map(value => value.id)));
  assert.deepEqual(shown.items.map(item => item.id), live.map(item => item.id));
});
