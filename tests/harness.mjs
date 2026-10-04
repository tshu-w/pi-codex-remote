// End-to-end fixture: the installed Pi CLI in RPC mode with the production extension,
// an offline scripted provider, and a phone client speaking app-server JSON-RPC.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Protocol } from '../src/protocol.mjs';
import { Sessions } from '../src/sessions.mjs';
import * as trash from '../src/trash.mjs';

export const model = 'fixture/scripted';
const remoteExtension = fileURLToPath(new URL('../index.ts', import.meta.url));

// Replies depend on the latest user prompt:
//   "read <file>" / "write <file>" / "bash <command>" call that Pi tool, then answer "done:<tool>"
//   "hold" streams "held" and waits for `/fixture-release` before finishing with "held:released"
//   anything else answers "echo:" plus every user text in context, joined by "|"
const providerSource = `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const text = content => typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('');

export default function (pi) {
  let release;
  pi.registerCommand('fixture-release', { description: 'Release a held reply', handler: async () => release?.() });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'write' && event.input.path === 'blocked.txt' && !(await ctx.ui.confirm('Fixture permission', 'Allow write?'))) return { block: true, reason: 'Fixture write denied' };
  });
  pi.on('session_before_compact', async event => ({ compaction: {
    summary: 'Fixture compaction', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
  } }));
  pi.registerTool({ name: 'mcp__fixture__lookup', label: 'Fixture lookup', description: 'Fixture MCP result',
    parameters: { type: 'object', properties: {} },
    async execute() { return { content: [{ type: 'text', text: 'lookup result' }], details: { server: 'fixture-server', tool: 'lookup-original' } }; },
  });
  pi.registerTool({ name: 'nested', label: 'Nested fixture', description: 'Exercise nested calls',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      await ctx.executeTool('read', { path: 'input.txt' });
      await ctx.executeTool('mcp__fixture__lookup', {});
      return { content: [{ type: 'text', text: 'nested done' }] };
    },
  });
  const children = new Map();
  pi.registerTool({ name: 'agent', label: 'Fixture agent', description: 'Offline pi-agents contract fixture',
    parameters: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' }, target: {}, message: { type: 'string' }, deliverAs: { type: 'string' } }, required: ['action'] },
    async execute(_id, args, _signal, _update, ctx) {
      let details;
      if (args.action === 'spawn') {
        const child = SessionManager.create(ctx.cwd, join(ctx.sessionManager.getSessionDir(), 'subagents'), { parentSession: ctx.sessionManager.getSessionFile() });
        const ownerId = ctx.sessionManager.getSessionId();
        child.appendCustomEntry('pi-agents-tree', { rootId: ownerId, ownerId, scopeId: ownerId });
        child.appendSessionInfo(args.name);
        child.appendModelChange('fixture', 'scripted');
        child.appendMessage({ role: 'user', content: args.message, timestamp: Date.now() });
        child.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'child:' + args.name }], api: 'fixture-api', provider: 'fixture', model: 'scripted', stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        children.set(args.name, child.getSessionId());
        details = { id: child.getSessionId(), name: args.name, queued: false };
      } else {
        const ids = [args.target].flat().map(target => children.get(target) ?? target);
        details = args.action === 'abort' ? { id: ids[0], aborted: true }
          : args.action === 'send' ? (args.deliverAs === 'write' ? { ids } : { id: ids[0], queued: false })
          : args.action === 'wait' ? { results: ['First result', 'Second result'].map(result => ({ id: children.get('researcher'), name: 'researcher', state: 'completed', history: false, result })), pending: [] }
          : { total: children.size, agents: [...children].map(([name, id]) => ({ id, name, ownerId: ctx.sessionManager.getSessionId(), state: 'idle' })) };
      }
      const label = id => [...children].find(([, value]) => value === id)?.[0] + ' (' + id.slice(0, 8) + ')';
      const output = args.action === 'spawn' ? 'Agent ' + label(details.id) + ' started.'
        : args.action === 'abort' ? 'Agent ' + label(details.id) + ' aborted.'
        : args.action === 'send' ? (args.deliverAs === 'write' ? 'Write accepted by ' + details.ids.map(label).join(', ') : 'Input accepted by ' + label(details.id)) + '.'
        : args.action === 'wait' ? details.results.map(result => '<agent-result name="' + result.name + '" id="' + result.id.slice(0, 8) + '" status="' + result.state + '">\\n' + result.result + '\\n</agent-result>').join('\\n\\n')
        : details.agents.map(agent => label(agent.id) + '  ' + agent.state + '  ' + ctx.cwd).join('\\n');
      return { content: [{ type: 'text', text: output + (args.message === 'Hooked' ? '\\nAdditional hook output' : '') }], details: args.message === 'Legacy' ? undefined : details };
    },
  });
  pi.registerProvider('fixture', {
    api: 'fixture-api', apiKey: 'fixture-only', baseUrl: 'https://invalid.invalid',
    models: [{ id: 'scripted', name: 'Scripted fixture', reasoning: false, input: ['text', 'image'],
      contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options = {}) {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'pending', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const push = event => stream.push(structuredClone(event));
      const say = async (...parts) => {
        message.content.push({ type: 'text', text: '' });
        push({ type: 'text_start', contentIndex: 0, partial: message });
        for (const part of parts) {
          if (typeof part === 'function') { await part(); continue; }
          message.content[0].text += part;
          push({ type: 'text_delta', contentIndex: 0, delta: part, partial: message });
        }
        message.content[0].textSignature = JSON.stringify({ v: 1, id: 'fixture-answer', phase: 'final_answer' });
        push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
        message.stopReason = 'stop';
      };
      void (async () => {
        try {
          const users = context.messages.filter(value => value.role === 'user');
          const last = context.messages.findLastIndex(value => value.role === 'user');
          const prompt = text(users.at(-1).content);
          const images = users.flatMap(value => typeof value.content === 'string' ? [] : value.content.filter(b => b.type === 'image'));
          appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ prompt, images: images.map(image => image.data) }) + '\\n');
          const result = context.messages.slice(last + 1).find(value => value.role === 'toolResult');
          const [tool, ...rest] = prompt.split(' ');
          push({ type: 'start', partial: message });
          if (['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'mcp__fixture__lookup', 'nested', 'agent'].includes(tool) && !result) {
            const args = tool === 'agent' ? JSON.parse(rest.join(' ')) : tool === 'bash' ? { command: rest.join(' ') }
              : tool === 'write' ? { path: rest[0], content: rest.slice(1).join(' ') || 'written' }
              : tool === 'edit' ? { path: rest[0], edits: [{ oldText: 'written', newText: 'edited' }] }
              : tool === 'grep' ? { pattern: rest[0], path: '.' }
              : tool === 'find' ? { pattern: rest[0], path: '.' }
              : ['read', 'ls'].includes(tool) ? { path: rest[0] || '.' } : {};
            const call = { type: 'toolCall', id: 'fixture-' + Date.now(), name: tool, arguments: args };
            message.content.push({ type: 'text', text: 'Working on it.', textSignature: JSON.stringify({ v: 1, id: 'fixture-comment', phase: 'commentary' }) });
            push({ type: 'text_start', contentIndex: 0, partial: message });
            push({ type: 'text_end', contentIndex: 0, content: 'Working on it.', partial: message });
            message.content.push(call);
            push({ type: 'toolcall_start', contentIndex: 1, partial: message });
            push({ type: 'toolcall_end', contentIndex: 1, toolCall: call, partial: message });
            message.stopReason = 'toolUse';
          } else if (result) await say('done:' + tool);
          else if (prompt === 'hold') await say('held', () => new Promise(resolve => {
            release = resolve;
            options.signal?.addEventListener('abort', resolve, { once: true });
          }).then(() => options.signal?.throwIfAborted()), ':released');
          else await say('echo:', users.map(value => text(value.content)).join('|'));
          push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = error.message;
          push({ type: 'error', reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
}
`;

export async function waitFor(predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  assert.fail(`Timed out: ${description}`);
}

export function phone(protocol) {
  const records = [];
  const emit = record => records.push(structuredClone(record));
  let nextId = 0;
  const raw = async (method, params = {}) => {
    const id = ++nextId;
    await protocol.handle({ id, method, params }, emit);
    return records.find(record => record.id === id);
  };
  return {
    records, raw,
    disconnect: () => protocol.disconnect(emit),
    async request(method, params) {
      const response = await raw(method, params);
      assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    notification: (method, predicate = () => true) => waitFor(() => records.find(record => record.method === method && predicate(record.params)), method),
    async turn(threadId, text, extra = {}) {
      const { turn } = await this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...extra });
      const completed = await this.notification('turn/completed', params => params.turn.id === turn.id);
      return completed.params.turn;
    },
  };
}

// One isolated Pi home per test file. `start()` creates a fresh Protocol, like a daemon restart.
export async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-remote-e2e-')));
  const dirs = { cwd: join(root, 'workspace'), config: join(root, 'config'), sessions: join(root, 'sessions'),
    home: join(root, 'home'), state: join(root, 'xdg-state'), trash: join(root, 'Trash') };
  await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true })));
  const extension = join(root, 'provider.ts');
  const calls = join(root, 'calls.jsonl');
  await Promise.all([
    writeFile(extension, providerSource), writeFile(calls, ''),
    writeFile(join(dirs.config, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'scripted', defaultThinkingLevel: 'off',
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false,
    })),
  ]);
  // History discovery and the live-session guard run in this process; node:test isolates files.
  Object.assign(process.env, { PI_CODING_AGENT_DIR: dirs.config, PI_CODING_AGENT_SESSION_DIR: dirs.sessions, XDG_STATE_HOME: dirs.state });
  const protocols = [];
  t.after(async () => {
    await Promise.allSettled(protocols.map(protocol => protocol.close()));
    await rm(root, { recursive: true, force: true });
  });
  // Archive moves files into a fixture directory instead of the user's Trash.
  const fixtureTrash = { ...trash, trashSession: async path => {
    const target = join(dirs.trash, `${Date.now()}-${basename(path)}`);
    await rename(path, target);
    return target;
  } };
  const start = () => {
    const sessions = new Sessions({
      command: '/usr/bin/env',
      args: ['-i', `PATH=${process.env.PATH}`, `HOME=${dirs.home}`, `XDG_STATE_HOME=${dirs.state}`,
        `PI_CODING_AGENT_DIR=${dirs.config}`, `PI_CODING_AGENT_SESSION_DIR=${dirs.sessions}`, `FIXTURE_CALLS=${calls}`,
        'PI_OFFLINE=1', 'PI_SKIP_VERSION_CHECK=1', 'PI_TELEMETRY=0', 'PI_CODEX_REMOTE_RPC=1',
        'pi', '--tools', 'read,bash,edit,write,grep,find,ls,mcp__fixture__lookup,nested,agent', '--no-extensions', '-e', remoteExtension, '-e', extension, '--no-skills', '--no-prompt-templates',
        '--no-themes', '--no-context-files', '--session-dir', dirs.sessions],
      requestTimeoutMs: 30000, shutdownTimeoutMs: 1000,
    });
    const protocol = new Protocol({ sessions, cwd: dirs.cwd, stateDir: join(root, 'remote-state'), trash: fixtureTrash });
    protocols.push(protocol);
    return { protocol, sessions, client: phone(protocol) };
  };
  return {
    root, ...dirs, start,
    calls: async () => (await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
  };
}
