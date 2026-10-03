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

export function updateToolItem(item, result, { complete = false, isError = false, durationMs, name, args, cwd = '' } = {}) {
  const details = result?.details;
  if (item.type === 'commandExecution' && item.commandActions[0]?.type === 'read' && result?.content?.some(block => block.type === 'image')) {
    const { id } = item;
    for (const key of Object.keys(item)) delete item[key];
    Object.assign(item, { type: 'dynamicToolCall', id, tool: 'read', arguments: args ?? null, namespace: null,
      contentItems: null, durationMs: null, status: 'inProgress', success: null });
  }
  const change = details?.codexRemoteChange ?? (name === 'edit' && typeof details?.patch === 'string' && typeof args?.path === 'string'
    ? { path: toolPath(args.path, cwd), kind: { type: 'update' }, diff: details.patch } : null);
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
    if (item.type !== 'fileChange') item.durationMs = durationMs ?? null;
  }
}

// Pi emits cumulative snapshots. A rolling/truncated snapshot is not an append delta;
// in that case the completed item's authoritative aggregatedOutput replaces the preview.
export function commandOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : '';
}
