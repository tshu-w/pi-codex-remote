import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';

export const toolPath = (path, cwd) => resolve(cwd, path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path);

export function toolItem(id, name, args, { cwd = '', namespace = null } = {}) {
  const fileQuery = ['read', 'grep', 'find', 'ls'].includes(name) && args && (name !== 'read' || typeof args.path === 'string');
  if ((['bash', 'powershell'].includes(name) && typeof args?.command === 'string') || fileQuery) {
    const positional = ['grep', 'find'].includes(name) ? ['pattern', 'path'] : ['path'];
    const command = fileQuery ? [name,
      ...positional.map(key => args[key] ?? (key === 'path' ? '.' : null))
        .filter(value => value != null).map(value => JSON.stringify(value)),
      ...Object.entries(args).filter(([key, value]) => !positional.includes(key) && value != null)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)].join(' ') : args.command;
    const path = fileQuery ? toolPath(args.path ?? '.', cwd) : null;
    const action = name === 'read' ? { type: 'read', command, name: basename(path), path }
      : name === 'grep' ? { type: 'search', command, query: args.pattern ?? null, path }
        : { type: 'listFiles', command, path };
    return {
      type: 'commandExecution', id, command, cwd, commandActions: fileQuery ? [action] : [],
      aggregatedOutput: null, durationMs: null, exitCode: null, processId: null,
      pluginId: null, scriptPath: null, source: 'agent', status: 'inProgress',
    };
  }
  return {
    type: 'dynamicToolCall', id, tool: name, arguments: args, namespace,
    contentItems: null, durationMs: null, status: 'inProgress', success: null,
  };
}

export function toolOutput(result) {
  return (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

// Wait/list intentionally use native, lossy presentation; other actions require
// standard acknowledgements. Identities always come from authoritative details.
function collabToolItem(id, name, args, result, senderThreadId) {
  if (name !== 'agent' || typeof senderThreadId !== 'string' || !senderThreadId ||
      result?.content?.length !== 1 || result.content[0].type !== 'text') return null;
  const details = result.details;
  if (!details || typeof details !== 'object') return null;
  const text = result.content[0].text;
  if (typeof text !== 'string') return null;
  const validId = value => typeof value === 'string' && value.length >= 8 && !/\s/.test(value);
  const knownKeys = keys => Object.keys(details).every(key => keys.includes(key));
  const labelMatches = (label, receiver, name) => {
    if (typeof label !== 'string' || /[\r\n,]/.test(label)) return false;
    for (let length = 8; length <= receiver.length; length++) {
      const prefix = receiver.slice(0, length);
      if (name !== undefined ? label === `${name} (${prefix})`
        : label === prefix || (label.endsWith(` (${prefix})`) && label.length > prefix.length + 3)) return true;
    }
    return false;
  };
  let receiverThreadIds;
  let tool;
  let agentsStates = {};
  if (args?.action === 'wait' && Array.isArray(details.results) && Array.isArray(details.pending) &&
      details.pending.every(validId) && details.results.every(entry => entry && validId(entry.id) &&
        typeof entry.name === 'string' && ['completed', 'failed', 'aborted'].includes(entry.state) &&
        typeof entry.history === 'boolean' && (entry.result === undefined || typeof entry.result === 'string'))) {
    receiverThreadIds = [...new Set([...details.results.map(entry => entry.id), ...details.pending])];
    tool = 'wait';
    // Input outcomes are not current Agent states; the native UI hides wait.
  } else if (args?.action === 'list' && Number.isSafeInteger(details.total) && details.total >= 0 &&
      Array.isArray(details.agents) && details.total >= details.agents.length &&
      details.agents.every(entry => entry && validId(entry.id) &&
        (entry.name === undefined || typeof entry.name === 'string') &&
        (entry.ownerId === undefined || validId(entry.ownerId)) && ['running', 'waiting', 'queued', 'idle'].includes(entry.state))) {
    receiverThreadIds = [...new Set(details.agents.map(entry => entry.id))];
    tool = 'listAgents';
    // Idle does not imply a completed input or a shut-down thread.
    agentsStates = Object.fromEntries(details.agents.filter(entry => entry.state !== 'idle')
      .map(entry => [entry.id, { status: 'running', message: null }]));
  } else if (args?.action === 'spawn' && validId(details.id) && typeof details.name === 'string' && details.name &&
      details.queued === false && knownKeys(['id', 'name', 'queued']) &&
      text.startsWith('Agent ') && text.endsWith(' started.') &&
      labelMatches(text.slice(6, -9), details.id, details.name)) {
    receiverThreadIds = [details.id];
    tool = 'spawnAgent';
    // A started Agent runs until its result arrives.
    agentsStates = { [details.id]: { status: 'running', message: null } };
  } else if (args?.action === 'send' && args.deliverAs === 'write' && knownKeys(['ids']) &&
      Array.isArray(details.ids) && details.ids.length && details.ids.every(validId) &&
      text.startsWith('Write accepted by ') && text.endsWith('.')) {
    const labels = text.slice(18, -1).split(', ');
    if (labels.length !== details.ids.length || !labels.every((label, index) => labelMatches(label, details.ids[index]))) return null;
    receiverThreadIds = details.ids;
    tool = 'sendMessage';
  } else if (args?.action === 'send' && ['followUp', 'steer', undefined].includes(args.deliverAs) &&
      validId(details.id) && details.queued === false && knownKeys(['id', 'queued']) &&
      text.startsWith('Input accepted by ') && text.endsWith('.') && labelMatches(text.slice(18, -1), details.id)) {
    receiverThreadIds = [details.id];
    tool = 'sendInput';
  } else if (args?.action === 'abort' && validId(details.id) && details.aborted === true && knownKeys(['id', 'aborted']) &&
      text.startsWith('Agent ') && text.endsWith(' aborted.') && labelMatches(text.slice(6, -9), details.id)) {
    receiverThreadIds = [details.id];
    tool = 'interruptAgent';
  } else return null;
  return {
    type: 'collabAgentToolCall', id, tool, status: 'inProgress', senderThreadId,
    receiverThreadIds, agentsStates,
    prompt: typeof args.message === 'string' ? args.message : null,
    model: args.action === 'spawn' ? args.model ?? null : null,
    reasoningEffort: args.action === 'spawn' ? args.thinkingLevel ?? null : null,
  };
}

export function updateToolItem(item, result, { complete = false, isError = false, durationMs, name, args, cwd = '', senderThreadId } = {}) {
  const details = result?.details;
  if (item.type === 'commandExecution' && item.commandActions[0]?.type === 'read' && result?.content?.some(block => block.type === 'image')) {
    const { id } = item;
    for (const key of Object.keys(item)) delete item[key];
    Object.assign(item, { type: 'dynamicToolCall', id, tool: 'read', arguments: args ?? null, namespace: null,
      contentItems: null, durationMs: null, status: 'inProgress', success: null });
  }
  // A write shows its new content; older Remote histories saved a diff in codexRemoteChange.
  const change = details?.codexRemoteChange ?? (name === 'edit' && typeof details?.patch === 'string' && typeof args?.path === 'string'
    ? { path: toolPath(args.path, cwd), kind: { type: 'update' }, diff: details.patch }
    : name === 'write' && typeof args?.path === 'string' && typeof args?.content === 'string'
      ? { path: toolPath(args.path, cwd), kind: { type: 'add' }, diff: args.content } : null);
  if (complete && !isError && ['edit', 'write'].includes(name) && change) {
    const { id } = item;
    for (const key of Object.keys(item)) delete item[key];
    Object.assign(item, { type: 'fileChange', id, changes: [change], status: 'inProgress' });
  }
  if (item.type === 'dynamicToolCall' && typeof details?.server === 'string' && typeof details?.tool === 'string') {
    const { id, arguments: input } = item;
    for (const key of Object.keys(item)) delete item[key];
    Object.assign(item, {
      type: 'mcpToolCall', id, server: details.server, tool: details.tool, arguments: input,
      result: null, error: null, durationMs: null, status: 'inProgress',
    });
  }
  if (complete && !isError && item.type === 'dynamicToolCall') {
    const collab = collabToolItem(item.id, name, args, result, senderThreadId);
    if (collab) {
      for (const key of Object.keys(item)) delete item[key];
      Object.assign(item, collab);
    }
  }
  if (item.type === 'commandExecution') {
    item.aggregatedOutput = toolOutput(result);
    if (complete) {
      const code = result?.structuredContent?.exit_code;
      // File tools have no process exit code; use their outcome for the client's status footer.
      item.exitCode = item.commandActions.length ? (isError ? 1 : 0) : Number.isInteger(code) ? code : null;
    }
  } else if (item.type === 'mcpToolCall') {
    // Keep Pi's post-hook (possibly redacted) output, not an unfiltered MCP payload.
    item.result = { content: result?.content ?? [] };
    if (isError) item.error = { message: toolOutput(result) || 'MCP tool failed' };
  } else if (item.type === 'dynamicToolCall') {
    item.contentItems = (result?.content ?? []).flatMap(block => {
      if (block.type === 'text') return [{ type: 'inputText', text: block.text }];
      if (block.type === 'image') return [{ type: 'inputImage', imageUrl: `data:${block.mimeType};base64,${block.data}` }];
      return [];
    });
    if (complete) item.success = !isError;
  }
  if (complete) {
    item.status = isError ? 'failed' : 'completed';
    if (!['fileChange', 'collabAgentToolCall'].includes(item.type)) item.durationMs = durationMs ?? null;
  }
}

// Extension notices such as pi-exec's `<bash-result>` and pi-agents' `<agent-result>` are tagged text for
// the model; as Markdown their tags render as HTML blocks, so they read as a header and their body.
export function noticeText({ customType, content, details }) {
  const text = typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const fenced = (value, language = '') => {
    const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(([run]) => run.length + 1)));
    return `${fence}${language}\n${value}\n${fence}`;
  };
  if (customType === 'bash-result' && typeof details?.command === 'string') {
    const output = (/\nOutput:\n\n([\s\S]*)\n<\/bash-result>$/.exec(text)?.[1] ?? text).replace(/\n+$/, '');
    const seconds = Number.isFinite(details.seconds) ? ` in ${details.seconds.toFixed(1)} s` : '';
    return [`Background command ${details.status}${seconds}`, fenced(details.command, 'sh'), ...(output ? [fenced(output)] : [])].join('\n\n');
  }
  const element = /^<([a-z][\w-]*)((?: [\w-]+="[^"]*")*)>\n([\s\S]*?)\n<\/\1>$/gm;
  return text.replace(element, (_, tag, attributes, body) => {
    const { name, id, status, note, ...rest } = Object.fromEntries([...attributes.matchAll(/ ([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    const agent = [name && `**${name}**`, id && `(${id})`].filter(Boolean).join(' ');
    const header = tag === 'agent-result' ? `Agent result from ${agent}${status ? `: ${status}` : ''}`
      : tag === 'agent-message' ? `Message from ${agent}`
        : [`**${tag}**`, agent, status, ...Object.entries(rest).map(([key, value]) => `${key}=${value}`)].filter(Boolean).join(' ');
    return `${header}\n\n${body}`;
  });
}

// Notices shown as the steps they report: pi-exec's finished background command as a command, and each
// pi-agents result as the Agent's completion with its result beside it. `agents` lists known { id, name }.
export function noticeItems(id, message, { cwd = '', agents = [] } = {}) {
  const { customType, details } = message;
  if (customType === 'bash-result' && typeof details?.command === 'string') {
    const text = typeof message.content === 'string' ? message.content : toolOutput(message);
    const output = /\nOutput:\n\n([\s\S]*)\n<\/bash-result>$/.exec(text)?.[1] ?? text;
    const code = details.status === 'completed' ? 0 : Number(/\n\nCommand exited with code (\d+)\n*$/.exec(output)?.[1]);
    return [{
      type: 'commandExecution', id, command: details.command, cwd, commandActions: [], aggregatedOutput: output,
      durationMs: Number.isFinite(details.seconds) ? Math.round(details.seconds * 1000) : null,
      exitCode: Number.isInteger(code) ? code : null, processId: null, pluginId: null, scriptPath: null,
      source: 'agent', status: details.status === 'completed' ? 'completed' : 'failed',
    }];
  }
  // As Codex keeps messages between Agents in the model's context only, one another Agent sent shows nothing.
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
  if (customType === 'pi-agents' && /^<agent-message [^>\n]*>\n[\s\S]*\n<\/agent-message>$/.test(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'))) return [];
  const results = customType === 'pi-agents' && Array.isArray(details?.results) ? details.results : [];
  const resolved = results.map(result => agents.findLast(agent => typeof result.id === 'string' && agent.id.startsWith(result.id) && agent.name === result.name));
  if (!results.length || resolved.some(agent => !agent)) return [{ type: 'agentMessage', id, text: noticeText(message), phase: 'commentary', delivery: null, memoryCitation: null }];
  // As Codex shows an Agent's completion: its name and outcome, opening its thread, where the result is.
  return results.map((result, index) => ({
    type: 'subAgentActivity', id: index ? `${id}:${index}` : id, kind: result.status === 'completed' ? 'completed' : 'interrupted',
    agentThreadId: resolved[index].id, agentPath: result.name, model: null, reasoningEffort: null,
  }));
}

// Pi emits cumulative snapshots. A rolling/truncated snapshot is not an append delta;
// in that case the completed item's authoritative aggregatedOutput replaces the preview.
export function commandOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : '';
}
