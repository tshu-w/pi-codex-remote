import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { realpathSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { noticeItems, toolItem, updateToolItem } from './items.mjs';
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
    // The value whatever its version, to extend.
    peek(key) { return entries.get(key)?.value; },
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

const histories = boundedCache(128, 64 * 1024 * 1024);
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

// The cached history, shared: callers must not change it.
export async function loadSession(sessionFile) {
  const path = resolve(sessionFile);
  return (await loadHistory(path, await stat(path))).history;
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

function parseLines(text, sessionFile, firstLine) {
  const lines = text.split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { records.push(JSON.parse(lines[i])); }
    catch (error) {
      if (i === lines.length - 1 && !text.endsWith('\n')) return { records, complete: false };
      throw new Error(`Invalid Pi history at ${sessionFile}:${firstLine + i}: ${error.message}`);
    }
  }
  // A line still being written ends without a newline; the file is read again once it has one.
  return { records, complete: !text || text.endsWith('\n') };
}

// Pi appends to a session file; a file that grew is read from where it ended, and one rewritten or moved is read again.
async function loadHistory(sessionFile, metadata) {
  const version = fileVersion(metadata);
  const previous = histories.peek(sessionFile);
  const cached = histories.get(sessionFile, version);
  if (cached) return { history: cached.history, cacheable: true };
  let history;
  let complete;
  let lines;
  let appended;
  if (previous && previous.dev === metadata.dev && previous.ino === metadata.ino && metadata.size > previous.size) {
    // The bytes it ended with, read again, tell an append from a rewrite of the same file.
    const start = Math.max(0, previous.size - previous.ending.length);
    const file = await open(sessionFile, 'r');
    try {
      const buffer = Buffer.alloc(metadata.size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      if (buffer.subarray(0, previous.size - start).equals(previous.ending)) appended = buffer.subarray(previous.size - start, bytesRead).toString('utf8');
    } finally { await file.close(); }
  }
  let ending;
  if (appended !== undefined) {
    const text = appended;
    const parsed = parseLines(text, sessionFile, previous.lines + 1);
    ({ complete } = parsed);
    lines = previous.lines + text.split('\n').length - 1;
    history = { header: previous.history.header, entries: previous.history.entries.concat(parsed.records) };
    ending = Buffer.concat([previous.ending, Buffer.from(text)]).subarray(-64);
  } else {
    const buffer = await readFile(sessionFile);
    ending = buffer.subarray(Math.max(0, buffer.length - 64));
    const text = buffer.toString('utf8');
    const parsed = parseLines(text, sessionFile, 1);
    ({ complete } = parsed);
    lines = text.split('\n').length - 1;
    const header = parsed.records.shift();
    if (header?.type !== 'session' || !header.id) throw new Error(`Invalid Pi session header: ${sessionFile}`);
    history = { header, entries: parsed.records };
  }
  const cacheable = complete && version === fileVersion(await stat(sessionFile));
  if (cacheable) histories.set(sessionFile, version, { history, dev: metadata.dev, ino: metadata.ino, size: metadata.size, lines, ending }, metadata.size * 2 + history.entries.length * 256);
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

const sessionRoot = () => process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir(), 'sessions');

// Calls `onChange` when a session file is added, written, moved or removed, or a directory of them is moved;
// `onClose` when that can no longer be told. Other files there, such as logs, do not count.
export function watchSessions(onChange, onClose) {
  try {
    const watcher = watch(realpathSync(sessionRoot()), { recursive: true, persistent: false }, (type, file) => {
      if (file == null || file.endsWith('.jsonl') || (type === 'rename' && !basename(file).includes('.'))) onChange();
    });
    watcher.on('error', () => { watcher.close(); onClose(); });
    return watcher;
  } catch { return null; }
}

export async function listSessions({ cwd } = {}) {
  const root = sessionRoot();
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
        // Rewriting a file, as slimming a session does, changes its mtime but not when it was last used.
        lastActive: new Date(entries.findLast(entry => entry.timestamp)?.timestamp ?? metadata.mtime),
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

// Agents a session started, which its notices name by a short ID.
export const sessionAgents = entries => entries.flatMap(entry => entry.type === 'custom' && entry.customType === 'pi-agents-agent' && typeof entry.data?.id === 'string' ? [{ id: entry.data.id, name: entry.data.name }] : []);

// Agents with an input queued or running: their metadata, then input changes; older records carry all inputs.
export function runningAgents(entries) {
  const inputs = new Map();
  for (const entry of entries) {
    if (entry.type !== 'custom' || typeof entry.data !== 'object' || !entry.data) continue;
    if (entry.customType === 'pi-agents-agent' && Array.isArray(entry.data.inputs)) inputs.set(entry.data.id, new Map(entry.data.inputs.map(input => [input.id, input.state])));
    else if (entry.customType === 'pi-agents-agent' && !inputs.has(entry.data.id)) inputs.set(entry.data.id, new Map());
    else if (entry.customType === 'pi-agents-input') inputs.get(entry.data.agentId)?.set(entry.data.id, entry.data.state);
  }
  return new Set([...inputs].filter(([, states]) => [...states.values()].some(state => ['queued', 'running'].includes(state))).map(([id]) => id));
}

export const projectTurns = (entries, options) => projectHistory(entries, options).turns;

// `previous`, a projection of the same session with the same options, is extended: while its branch only grows,
// the turns before its last are final and only the last is projected again, from the entry that began it.
export function projectHistory(entries, options = {}) {
  const { leafId, clientIds = {}, entryMappings = {}, cwd = '', senderThreadId, imageMapper = block => ({ type: 'image', url: `data:${block.mimeType};base64,${block.data}` }), previous } = options;
  const branch = activeBranch(entries, leafId);
  const agents = sessionAgents(branch);
  // The same entry objects tell an extended history from one reread or rewritten; a new Agent record can name the Agent of an earlier notice.
  const resume = previous?.branch?.length > 0 && previous.agents === agents.length && previous.branch.length <= branch.length
    && branch[previous.branch.length - 1] === previous.branch.at(-1);
  if (resume && previous.branch.length === branch.length) return previous;
  const turns = resume ? previous.turns.slice(0, previous.frozen) : [];
  const final = turns.length;
  let start = resume ? previous.start : 0;
  let turn;
  const tools = new Map();
  const inputs = resume ? previous.inputs : new Map();
  let unphased = [];
  // A turn has ended once Pi's run stops; until then steered input joins it.
  let ended = false;
  // Notices that open a turn stay together until Pi replies; a prompt after them starts its own turn.
  let notices = false;
  // Unsigned assistant text is commentary unless it is the turn's last reply.
  const settle = () => {
    unphased.forEach(({ item, toolUse }, index) => { item.phase = toolUse || index < unphased.length - 1 ? 'commentary' : 'final_answer'; });
    unphased = [];
  };
  const nestedItems = new Map(branch.filter(entry => entry.type === 'custom' && entry.customType === 'codex-remote-tool')
    .map(entry => [entry.data.item.id, entry.data]));
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type === 'custom' && entry.customType === 'codex-remote-tool') {
      const saved = entry.data;
      let parent = saved.parentToolCallId;
      while (nestedItems.has(parent)) parent = nestedItems.get(parent).parentToolCallId;
      const owner = [...turns, turn].find(candidate => candidate?.items.some(item => item.id === parent));
      // A nested call recorded after its turn changes a turn taken as final.
      if (resume && turns.indexOf(owner) !== -1 && turns.indexOf(owner) < final) return projectHistory(entries, { ...options, previous: undefined });
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
    const notice = visibleCustom || (role === 'custom' && message.display !== false);
    if (!message && !visibleCustom && entry.type !== 'compaction' && entry.type !== 'branch_summary') continue;
    const compactionMapping = entry.type === 'compaction' ? entryMappings[entry.id] : undefined;
    const separateCompaction = compactionMapping?.turnId && (compactionMapping.compactionTurn || compactionMapping.turnId !== (entryMappings[turn?.id]?.turnId ?? turn?.id));
    // Unmapped or idle shell commands start a turn; one run during a turn is mapped without a turnId.
    const shellTurn = role === 'bashExecution' && !(entryMappings[entry.id] && !entryMappings[entry.id].turnId);
    // Input Remote saw start another turn opens it even after a run Pi never finished.
    const mappedTurn = (role === 'user' || notice) && entryMappings[entry.id]?.turnId;
    const otherTurn = mappedTurn && mappedTurn !== (entryMappings[turn?.id]?.turnId ?? turn?.id);
    if ((role === 'user' && (ended || notices)) || (notice && ended) || otherTurn || shellTurn || !turn || separateCompaction) {
      settle();
      ended = role !== 'user' && !notice;
      notices = notice;
      if (turn?.items.length) turns.push(turn);
      start = index;
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
        if (block.type === 'text') {
          const item = agentItem(id, block.text, textPhase(block));
          if (!item.phase) unphased.push({ item, toolUse: message.stopReason === 'toolUse' });
          turn.items.push(item);
        }
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
      ended = !['toolUse', 'pending'].includes(message.stopReason);
      notices = false;
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
    } else if (notice) turn.items.push(...noticeItems(entry.id, visibleCustom ? entry : message, { cwd, agents }));
    else if (entry.type === 'compaction') turn.items.push({ type: 'contextCompaction', id: entry.id });
    else if (entry.type === 'branch_summary') turn.items.push(agentItem(entry.id, entry.summary));
    turn.completedAt = Math.floor(Date.parse(entry.timestamp) / 1000);
    turn.durationMs = (turn.completedAt - turn.startedAt) * 1000;
  }
  settle();
  const frozen = turns.length;
  if (turn?.items.length) turns.push(turn);
  return { turns, branch, start, frozen, inputs, agents: agents.length };
}
