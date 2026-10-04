import { readFile } from 'node:fs/promises';
import { toolItem, toolPath, updateToolItem } from './items.mjs';

export function registerToolPresentation(pi, generateUnifiedPatch) {
  const writes = new Map();
  const nested = new Map();
  pi.on('tool_execution_start', (event) => {
    if (process.env.PI_CODEX_REMOTE_RPC === '1' && event.parentToolCallId) nested.set(event.toolCallId, event.args);
  });
  pi.on('tool_call', async (event, ctx) => {
    if (process.env.PI_CODEX_REMOTE_RPC !== '1' || event.toolName !== 'write' || typeof event.input.path !== 'string') return;
    const path = toolPath(event.input.path, ctx.cwd);
    try { writes.set(event.toolCallId, { path, before: await readFile(path, 'utf8'), kind: { type: 'update' } }); }
    catch (error) {
      if (error.code === 'ENOENT') writes.set(event.toolCallId, { path, before: '', kind: { type: 'add' } });
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (process.env.PI_CODEX_REMOTE_RPC !== '1') return;
    const snapshot = writes.get(event.toolCallId);
    writes.delete(event.toolCallId);
    let details = event.details;
    if (snapshot && !event.isError) {
      try {
        const after = await readFile(snapshot.path, 'utf8');
        if (after === event.input.content && !snapshot.before.includes('\0') && !after.includes('\0')) {
          details = { ...details, codexRemoteChange: { path: snapshot.path, kind: snapshot.kind,
            diff: generateUnifiedPatch(snapshot.path, snapshot.before, after) } };
        }
      } catch { /* Presentation must not turn a completed write into a tool failure. */ }
    }
    if (details !== event.details) return { details };
  });
  pi.on('tool_execution_end', (event, ctx) => {
    if (process.env.PI_CODEX_REMOTE_RPC !== '1' || !event.parentToolCallId) return;
    const args = nested.get(event.toolCallId);
    nested.delete(event.toolCallId);
    // Persist the final post-hook result; nestedCalls itself omits results from history.
    const senderThreadId = ctx.sessionManager.getSessionId();
    const item = toolItem(event.toolCallId, event.toolName, args, { cwd: ctx.cwd, senderThreadId });
    updateToolItem(item, event.result, { complete: true, isError: event.isError,
      name: event.toolName, args, cwd: ctx.cwd, senderThreadId });
    pi.appendEntry('codex-remote-tool', { parentToolCallId: event.parentToolCallId, item });
  });
  pi.on('agent_settled', () => { writes.clear(); nested.clear(); });
  pi.on('session_shutdown', () => { writes.clear(); nested.clear(); });
}
