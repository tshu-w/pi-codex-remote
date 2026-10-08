import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { toolItem, updateToolItem } from './items.mjs';
import { agentItem, textPhase } from './codex.mjs';

// Budgets account for retained payloads; entry limits also bound Map/object overhead.
function boundedCache(maxEntries, maxBytes) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  return {
    get(key, version) {
      const entry = entries.get(key);
      if (!entry) return;
      remove(key);
      if (entry.version !== version) return;
      entries.set(key, entry);
      bytes += entry.bytes;
      return entry.value;
    },
    set(key, version, value, size) {
      remove(key);
      if (size > maxBytes) return;
      while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
      entries.set(key, { version, value, bytes: size });
      bytes += size;
    },
  };
}

const histories = boundedCache(128, 16 * 1024 * 1024);
const summaries = boundedCache(2048, 4 * 1024 * 1024);
const searchTexts = boundedCache(2048, 8 * 1024 * 1024);

function fileVersion(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':');
}

function agentDir() {
  const path = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export async function historyPath(file) {
  const absolute = resolve(file);
  try { return await realpath(absolute); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { return join(await realpath(dirname(absolute)), basename(absolute)); }
  catch (error) { if (error.code === 'ENOENT') return absolute; throw error; }
}

export async function readHistory(sessionFile) {
  const path = resolve(sessionFile);
  const { history } = await loadHistory(path, await stat(path));
  // Callers previously owned freshly parsed objects, including nested message content.
  return structuredClone(history);
}

export async function readSearchText(sessionFile) {
  const path = resolve(sessionFile);
  const metadata = await stat(path);
  const cached = searchTexts.get(path, fileVersion(metadata));
  if (cached !== undefined) return cached;
  const { history, cacheable } = await loadHistory(path, metadata);
  const text = searchableText(history.entries);
  if (cacheable) searchTexts.set(path, fileVersion(metadata), text, text.length * 2 + 256);
  return text;
}

async function loadHistory(sessionFile, metadata) {
  const version = fileVersion(metadata);
  const cached = histories.get(sessionFile, version);
  if (cached) return { history: cached, cacheable: true };
  const text = await readFile(sessionFile, 'utf8');
  let complete = true;
  const lines = text.split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { records.push(JSON.parse(lines[i])); }
    catch (error) {
      if (i === lines.length - 1 && !text.endsWith('\n')) { complete = false; break; }
      throw new Error(`Invalid Pi history at ${sessionFile}:${i + 1}: ${error.message}`);
    }
  }
  const header = records.shift();
  if (header?.type !== 'session' || !header.id) throw new Error(`Invalid Pi session header: ${sessionFile}`);
  const history = { header, entries: records };
  const cacheable = complete && version === fileVersion(await stat(sessionFile));
  if (cacheable) histories.set(sessionFile, version, history, text.length * 2 + records.length * 256);
  return { history, cacheable };
}

function activeBranch(entries, leafId = entries.at(-1)?.id) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  let entry = byId.get(leafId);
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.push(entry);
    entry = byId.get(entry.parentId);
  }
  return branch.reverse();
}

export function sessionSettings(entries) {
  const branch = activeBranch(entries);
  const model = branch.findLast(entry => entry.type === 'model_change');
  const assistant = branch.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')?.message;
  return {
    model: model ? { provider: model.provider, id: model.modelId } : assistant?.provider && assistant?.model ? { provider: assistant.provider, id: assistant.model } : undefined,
    thinkingLevel: branch.findLast(entry => entry.type === 'thinking_level_change')?.thinkingLevel ?? assistant?.thinkingLevel,
  };
}

export async function listSessions({ cwd } = {}) {
  const root = process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir(), 'sessions');
  const files = [];
  async function collect(dir) {
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const child of children) {
      const path = join(dir, child.name);
      if (child.isDirectory()) await collect(path);
      else if (child.isFile() && child.name.endsWith('.jsonl')) files.push(path);
    }
  }
  await collect(root);
  const sessions = [];
  for (const path of files) {
    try {
      const key = resolve(path);
      const metadata = await stat(key);
      const version = fileVersion(metadata);
      const cached = summaries.get(key, version);
      if (cached) {
        if (!cwd || resolve(cached.cwd) === resolve(cwd)) sessions.push({ ...structuredClone(cached), path });
        continue;
      }
      const { history: { header, entries }, cacheable } = await loadHistory(key, metadata);
      const branch = activeBranch(entries);
      const first = branch.find(entry => entry.type === 'message' && entry.message.role === 'user');
      const info = branch.findLast(entry => entry.type === 'session_info');
      const tree = entries.find(entry => entry.type === 'custom' && entry.customType === 'pi-agents-tree' && typeof entry.data?.rootId === 'string')?.data;
      const summary = {
        id: header.id,
        path,
        cwd: header.cwd,
        parentSession: header.parentSession ?? null,
        isSubAgent: basename(dirname(path)) === 'subagents',
        agentOwnerId: typeof tree?.ownerId === 'string' ? tree.ownerId : null,
        name: info?.name,
        created: new Date(header.timestamp),
        modified: metadata.mtime,
        firstMessage: textContent(first?.message.content),
      };
      if (cacheable) {
        summaries.set(key, version, summary, JSON.stringify(summary).length * 2 + 256);
        const searchText = searchableText(entries);
        searchTexts.set(key, version, searchText, searchText.length * 2 + 256);
      }
      if (!cwd || resolve(header.cwd) === resolve(cwd)) sessions.push(structuredClone(summary));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return sessions.sort((a, b) => b.modified - a.modified);
}

// Session name and message text on the active branch, for thread/search.
export function searchableText(entries) {
  return activeBranch(entries).flatMap(entry => {
    if (entry.type === 'session_info') return entry.name ? [entry.name] : [];
    const role = entry.message?.role;
    return role === 'user' || role === 'assistant' ? [textContent(entry.message.content)] : [];
  }).filter(Boolean).join('\n');
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function imageAttachmentText(text) {
  if (!text?.startsWith('# Files mentioned by the user:\n')) return text;
  const boundary = text.indexOf('\n## My request:\n');
  if (boundary === -1) return text;
  const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  const attachment = new RegExp(`^## [^\\r\\n]+: /tmp/codex-remote-attachments/${uuid}/${uuid}/[^/\\r\\n]+\\.(?:[jJ][pP][eE]?[gG]|[pP][nN][gG]|[gG][iI][fF]|[wW][eE][bB][pP])$`, 'gm');
  // Remove duplicate file cards only in the upload header, never in the request body.
  const original = text.slice(0, boundary);
  const entry = new RegExp(`${attachment.source}(?:\\n(?:[ \\t]*\\n)*[ \\t]*Image attachment: true(?=\\n|$))?(?:\\n|$)`, 'gm');
  const header = original.replace(entry, '');
  if (header !== original && header.trim() === '# Files mentioned by the user:') {
    return text.slice(boundary + '\n## My request:\n'.length);
  }
  return header + text.slice(boundary);
}

function userContent(content, imageMapper) {
  if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }];
  const hasImage = content?.some(block => block.type === 'image');
  return (content || []).map(block => block.type === 'image'
    ? imageMapper(block)
    : { type: 'text', text: hasImage ? imageAttachmentText(block.text) : block.text, text_elements: [] });
}

export function projectTurns(entries, { leafId, clientIds = {}, entryMappings = {}, cwd = '', senderThreadId, imageMapper = block => ({ type: 'image', url: `data:${block.mimeType};base64,${block.data}` }) } = {}) {
  const turns = [];
  let turn;
  const tools = new Map();
  const inputs = new Map();
  const branch = activeBranch(entries, leafId);
  const nestedItems = new Map(branch.filter(entry => entry.type === 'custom' && entry.customType === 'codex-remote-tool')
    .map(entry => [entry.data.item.id, entry.data]));
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'codex-remote-tool') {
      const saved = entry.data;
      let parent = saved.parentToolCallId;
      while (nestedItems.has(parent)) parent = nestedItems.get(parent).parentToolCallId;
      const owner = [...turns, turn].find(candidate => candidate?.items.some(item => item.id === parent));
      if (owner && !owner.items.some(item => item.id === saved.item.id)) {
        const item = structuredClone(saved.item);
        owner.items.push(item);
        tools.set(item.id, item);
      }
      continue;
    }
    const message = entry.type === 'message' ? entry.message : undefined;
    const role = message?.role;
    if (role === 'system') continue;
    const visibleCustom = entry.type === 'custom_message' && entry.display;
    if (!message && !visibleCustom && entry.type !== 'compaction' && entry.type !== 'branch_summary') continue;
    const compactionMapping = entry.type === 'compaction' ? entryMappings[entry.id] : undefined;
    const separateCompaction = compactionMapping?.turnId && (compactionMapping.compactionTurn || compactionMapping.turnId !== (entryMappings[turn?.id]?.turnId ?? turn?.id));
    // Unmapped or idle shell commands start a turn; one run during a turn is mapped without a turnId.
    const shellTurn = role === 'bashExecution' && !(entryMappings[entry.id] && !entryMappings[entry.id].turnId);
    if (role === 'user' || shellTurn || !turn || separateCompaction) {
      if (turn?.items.length) turns.push(turn);
      tools.clear();
      turn = {
        id: entry.id, items: [], itemsView: 'full', status: 'completed', error: null,
        startedAt: Math.floor(Date.parse(entry.timestamp) / 1000), completedAt: null, durationMs: null,
      };
    }
    if (role === 'user') {
      turn.items.push({ type: 'userMessage', id: entry.id, clientId: clientIds[entry.id] ?? message.clientId ?? null, content: userContent(message.content, imageMapper) });
    } else if (role === 'assistant') {
      for (const [index, block] of (message.content || []).entries()) {
        const id = `${entry.id}:${index}`;
        if (block.type === 'text') turn.items.push(agentItem(id, block.text, textPhase(block)));
        else if (block.type === 'thinking') turn.items.push({ type: 'reasoning', id, content: [block.thinking], summary: [] });
        else if (block.type === 'toolCall') {
          const item = toolItem(block.id, block.name, block.arguments, { cwd, namespace: block.namespace, senderThreadId });
          tools.set(block.id, item);
          inputs.set(block.id, { name: block.name, args: block.arguments });
          turn.items.push(item);
        }
      }
      if (message.stopReason === 'error') {
        turn.status = 'failed';
        turn.error = { message: message.errorMessage || 'Pi model request failed', codexErrorInfo: null, additionalDetails: null };
      } else if (message.stopReason === 'aborted') turn.status = 'interrupted';
      else if (message.stopReason === 'toolUse' || message.stopReason === 'pending') turn.status = 'inProgress';
      else { turn.status = 'completed'; turn.error = null; }
    } else if (role === 'toolResult') {
      let item = tools.get(message.toolCallId);
      if (!item) {
        item = toolItem(message.toolCallId, message.toolName, null, { cwd, senderThreadId });
        tools.set(message.toolCallId, item);
        turn.items.push(item);
      }
      updateToolItem(item, message, { complete: true, isError: message.isError, durationMs: message.durationMs, cwd, senderThreadId, ...inputs.get(message.toolCallId) });
      for (const call of message.nestedCalls?.calls ?? []) {
        if (tools.has(call.id)) continue;
        const saved = nestedItems.get(call.id);
        const nested = saved ? structuredClone(saved.item) : toolItem(call.id, call.name, call.arguments ?? null, { cwd, senderThreadId });
        if (call.status !== 'unfinished') {
          nested.status = call.status === 'ok' ? 'completed' : 'failed';
          if (!['fileChange', 'collabAgentToolCall'].includes(nested.type)) nested.durationMs = call.durationMs ?? null;
          if (nested.type === 'dynamicToolCall') nested.success = call.status === 'ok';
        }
        tools.set(call.id, nested);
        turn.items.push(nested);
      }
    } else if (role === 'bashExecution') {
      turn.items.push({
        type: 'commandExecution', id: entry.id, command: message.command,
        aggregatedOutput: message.output, commandActions: [], cwd: message.cwd || '',
        durationMs: null, exitCode: message.exitCode ?? null, pluginId: null, processId: null,
        scriptPath: null, source: 'userShell', status: message.cancelled || message.exitCode !== 0 ? 'failed' : 'completed',
      });
    } else if (visibleCustom) turn.items.push(agentItem(entry.id, textContent(entry.content)));
    else if (role === 'custom' && message.display !== false) turn.items.push(agentItem(entry.id, textContent(message.content)));
    else if (entry.type === 'compaction') turn.items.push({ type: 'contextCompaction', id: entry.id });
    else if (entry.type === 'branch_summary') turn.items.push(agentItem(entry.id, entry.summary));
    turn.completedAt = Math.floor(Date.parse(entry.timestamp) / 1000);
    turn.durationMs = (turn.completedAt - turn.startedAt) * 1000;
  }
  if (turn?.items.length) turns.push(turn);
  return turns;
}
