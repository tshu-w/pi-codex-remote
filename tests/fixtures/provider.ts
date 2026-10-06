
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
        : args.action === 'wait' ? details.results.map(result => '<agent-result name="' + result.name + '" id="' + result.id.slice(0, 8) + '" status="' + result.state + '">\n' + result.result + '\n</agent-result>').join('\n\n')
        : details.agents.map(agent => label(agent.id) + '  ' + agent.state + '  ' + ctx.cwd).join('\n');
      return { content: [{ type: 'text', text: output + (args.message === 'Hooked' ? '\nAdditional hook output' : '') }], details: args.message === 'Legacy' ? undefined : details };
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
          appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ prompt, images: images.map(image => image.data) }) + '\n');
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
