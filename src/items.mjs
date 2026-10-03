export function toolItem(id, name, args, { cwd = '', namespace = null } = {}) {
  if (name === 'bash' && typeof args?.command === 'string') {
    return {
      type: 'commandExecution', id, command: args.command, cwd, commandActions: [],
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

export function updateToolItem(item, result, { complete = false, isError = false, durationMs } = {}) {
  if (item.type === 'commandExecution') {
    item.aggregatedOutput = toolOutput(result);
    if (complete) {
      const code = result?.structuredContent?.exit_code;
      item.exitCode = Number.isInteger(code) ? code : null;
    }
  } else {
    item.contentItems = (result?.content ?? []).flatMap(block => {
      if (block.type === 'text') return [{ type: 'inputText', text: block.text }];
      if (block.type === 'image') return [{ type: 'inputImage', imageUrl: `data:${block.mimeType};base64,${block.data}` }];
      return [];
    });
    if (complete) item.success = !isError;
  }
  if (complete) {
    item.status = isError ? 'failed' : 'completed';
    item.durationMs = durationMs ?? null;
  }
}

// Pi emits cumulative snapshots. A rolling/truncated snapshot is not an append delta;
// in that case the completed item's authoritative aggregatedOutput replaces the preview.
export function commandOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : '';
}
