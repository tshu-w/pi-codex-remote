import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { historyPath, listSessions, readHistory, readSearchText, projectTurns } from './history.mjs';
import * as sessionTrash from './trash.mjs';
import { Attachments } from './attachments.mjs';
import { ImagePreviews } from './image-previews.mjs';
import { schemaViolation } from './schema.mjs';
import { seconds, modelKey, invalid } from './codex.mjs';
import { historyCursor } from './pages.mjs';
import { configHandlers } from './handlers/config.mjs';
import { execHandlers } from './handlers/exec.mjs';
import { filesHandlers } from './handlers/files.mjs';
import { historyHandlers } from './handlers/history.mjs';
import { queueHandlers, queueMethods } from './handlers/queue.mjs';
import { turnsHandlers, turnsMethods } from './handlers/turns.mjs';
import { threadsHandlers, threadsMethods } from './handlers/threads.mjs';

// Production logs violations; `npm test` turns this warning into a failure.
function checkSchema(message, requestMethod) {
  const problem = schemaViolation(message, requestMethod);
  if (problem) process.emitWarning(problem, 'CodexSchemaWarning');
}

const handlers = { ...configHandlers, ...execHandlers, ...filesHandlers, ...turnsHandlers, ...threadsHandlers, ...historyHandlers, ...queueHandlers };

export class Protocol {
  constructor({ sessions, cwd = process.cwd(), stateDir, history = { listSessions, readHistory, readSearchText, projectTurns }, trash = sessionTrash, onResponse = () => {} }) {
    this.sessions = sessions;
    this.trash = trash;
    this.previews = new ImagePreviews({ stateDir, loadEntries: async threadId => {
      if (!this.catalog.has(threadId)) await this.discover();
      return (await this.entries(threadId)).entries;
    } });
    this.history = { ...history, projectTurns: (entries, options) => history.projectTurns(entries, {
      ...options, imageMapper: options?.senderThreadId ? block => this.previews.image(block, options.senderThreadId) : undefined,
    }) };
    this.cwd = resolve(cwd);
    this.stateDir = stateDir;
    this.attachments = new Attachments({ stateDir });
    this.onResponse = onResponse;
    this.loaded = new Map();
    this.opening = new Map();
    this.catalog = new Map();
    this.diskIds = new Set();
    this.probes = new Map();
    this.inputEligibility = new Map();
    this.subscribers = new Map();
    this.notificationFilters = new Map();
    this.notificationBarriers = new Map();
    this.mutating = new Set();
    this.mutationQueues = new Map();
    this.active = new Map();
    this.execProcesses = new Map();
    this.meta = { archives: {}, entries: {}, parents: {} };
    this.ready = this.loadMetadata();
    this.saving = Promise.resolve();
  }

  async loadMetadata() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try { this.meta = JSON.parse(await readFile(join(this.stateDir, 'threads.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  saveMetadata() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      const file = join(this.stateDir, 'threads.json');
      await writeFile(`${file}.tmp`, `${JSON.stringify(this.meta)}\n`, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return this.saving;
  }

  notify(threadId, method, params) {
    const listeners = threadId == null ? new Set([...this.notificationFilters.keys(), ...[...this.subscribers.values()].flatMap(listeners => [...listeners])]) : this.subscribers.get(threadId) ?? [];
    const barrier = this.notificationBarriers.get(threadId);
    checkSchema({ method, params });
    for (const emit of listeners) {
      if (this.notificationFilters.get(emit)?.has(method)) continue;
      const message = { method, params: structuredClone(params) };
      if (barrier) {
        barrier.pending.push({ emit, message });
        continue;
      }
      try { emit(message); }
      catch { this.disconnect(emit); }
    }
  }

  unsubscribe(threadId, emit) {
    const listeners = this.subscribers.get(threadId);
    listeners?.delete(emit);
    if (!listeners?.size) this.subscribers.delete(threadId);
    for (const packet of this.notificationBarriers.get(threadId)?.pending ?? []) {
      if (packet.emit === emit) { packet.emit = null; packet.message = null; }
    }
  }

  disconnect(emit) {
    this.attachments.disconnect(emit);
    for (const { kill } of this.execProcesses.get(emit)?.values() ?? []) kill();
    this.execProcesses.delete(emit);
    this.notificationFilters.delete(emit);
    for (const threadId of new Set([...this.subscribers.keys(), ...this.notificationBarriers.keys()])) this.unsubscribe(threadId, emit);
  }

  subscribe(threadId, emit) {
    let listeners = this.subscribers.get(threadId);
    if (!listeners) this.subscribers.set(threadId, listeners = new Set());
    listeners.add(emit);
  }

  async discover() {
    if (this.discovery) return this.discovery;
    this.discovery = this.refreshCatalog();
    try { await this.discovery; this.catalogReady = true; }
    finally { this.discovery = undefined; }
  }

  async refreshCatalog() {
    const records = await this.history.listSessions();
    const found = new Map(records.map(record => [record.id, record]));
    const ids = new Set(found.keys());
    for (const id of new Set([...this.diskIds, ...this.loaded.keys()])) {
      const rpc = this.loaded.get(id);
      const current = found.get(id);
      if (rpc?.sessionFile && !current && !this.diskIds.has(id) && !this.active.has(id) && !rpc.state.isStreaming && !rpc.state.isCompacting) {
        try { await rpc.refresh(); }
        catch (error) {
          if (!rpc.failure) throw error;
          this.loaded.delete(id);
          this.catalog.delete(id);
          continue;
        }
      }
      const moved = rpc?.sessionFile && current && await historyPath(current.path) !== await historyPath(rpc.sessionFile);
      if (this.meta.trashed?.[id] || (!moved && (!this.diskIds.has(id) || ids.has(id)))) continue;
      if (this.active.has(id) || rpc?.state.isStreaming || rpc?.state.isCompacting) { ids.add(id); continue; }
      this.catalog.delete(id);
      this.loaded.delete(id);
      if (rpc) await rpc.close();
    }
    this.diskIds = ids;
    for (const record of records) this.catalog.set(record.id, record);
    for (const [id, archived] of Object.entries(this.meta.trashed ?? {})) this.catalog.set(id, { ...archived.record, path: archived.trashPath });
    for (const [id, rpc] of this.loaded) {
      const existing = this.catalog.get(id);
      this.catalog.set(id, { ...existing, id, path: rpc.sessionFile, cwd: rpc.cwd, name: rpc.state.sessionName ?? existing?.name, created: existing?.created ?? new Date(), modified: existing?.modified ?? new Date(), firstMessage: existing?.firstMessage ?? '' });
    }
    const paths = new Map(await Promise.all([...this.catalog.values()].filter(record => record.path).map(async record => [await historyPath(this.meta.trashed?.[record.id]?.originalPath ?? record.path), record.id])));
    for (const record of this.catalog.values()) record.parentSessionId = (record.parentSession ? paths.get(await historyPath(record.parentSession)) : null) ?? (record.isSubAgent ? record.agentOwnerId : null) ?? null;
  }

  async rpc(threadId) {
    await this.discover();
    if (this.catalog.get(threadId)?.isSubAgent) throw invalid('Sub-agent threads are read-only in Remote.');
    if (this.meta.trashed?.[threadId]) throw invalid('Session is in Trash. Unarchive it before resuming or sending tasks.');
    const cached = this.loaded.get(threadId);
    if (cached && !cached.failure) {
      await this.discover();
      if (this.loaded.get(threadId) === cached) {
        try { await cached.refresh(); }
        catch (error) {
          if (cached.failure) { this.loaded.delete(threadId); this.catalog.delete(threadId); }
          throw error;
        }
        return cached;
      }
    }
    if (cached) this.loaded.delete(threadId);
    if (this.opening.has(threadId)) return this.opening.get(threadId);
    const opening = (async () => {
      await this.discover();
      const record = this.catalog.get(threadId);
      if (!record) throw invalid(`Thread not found: ${threadId}`);
      const { header } = await this.history.readHistory(record.path);
      if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Remote can resume it.');
      if (header.id !== threadId) throw invalid('Session history identity changed. Refresh the list before resuming.');
      await this.trash.assertSessionNotOpen(record.path);
      const rpc = await this.sessions.open({ cwd: record.cwd, sessionFile: record.path });
      if (rpc.id !== threadId || await historyPath(rpc.sessionFile) !== await historyPath(record.path)) {
        await rpc.close();
        throw invalid('Pi opened a different session. Refresh the list before retrying.');
      }
      this.register(rpc);
      return rpc;
    })();
    this.opening.set(threadId, opening);
    try { return await opening; }
    finally { this.opening.delete(threadId); }
  }

  register(rpc) {
    if (!this.loaded.has(rpc.id)) rpc.onEvent(event => this.event(rpc, event));
    this.loaded.set(rpc.id, rpc);
    this.inputEligibility.delete(rpc.id);
    const existing = this.catalog.get(rpc.id);
    this.catalog.set(rpc.id, { ...existing, id: rpc.id, path: rpc.sessionFile, cwd: rpc.cwd, name: rpc.state.sessionName ?? existing?.name, created: existing?.created ?? new Date(), modified: existing?.modified ?? new Date(), firstMessage: existing?.firstMessage ?? '' });
  }

  async entries(threadId) {
    const rpc = this.loaded.get(threadId);
    if (rpc && (this.meta.owned?.[threadId] || this.active.has(threadId))) return rpc.request('get_entries');
    const record = this.catalog.get(threadId);
    if (!record) throw invalid(`Thread not found: ${threadId}`);
    const history = await this.history.readHistory(record.path);
    if (history.header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Remote can display it.');
    if (history.header.id !== threadId) throw invalid('Session history identity changed. Refresh the list before retrying.');
    return history;
  }

  async turns(threadId) {
    const rpc = this.loaded.get(threadId);
    const { entries, leafId } = await this.entries(threadId);
    const running = this.active.get(threadId);
    if (running && this.reconcileEntries(running, entries)) await this.saveMetadata();
    for (const compaction of running?.compactionMappings ?? []) {
      if (this.mapCompaction(running, compaction.item, compaction.result, entries)) await this.saveMetadata();
    }
    const turns = this.history.projectTurns(entries, { leafId, entryMappings: this.meta.entries, cwd: rpc?.cwd ?? this.catalog.get(threadId)?.cwd, senderThreadId: threadId });
    const merged = [];
    for (const turn of turns) {
      const mapped = this.meta.entries[turn.id];
      if (mapped?.turnId) turn.id = mapped.turnId;
      for (const item of turn.items) {
        const itemMap = this.meta.entries[item.id];
        if (itemMap?.itemId) item.id = itemMap.itemId;
        if (item.type === 'userMessage' && itemMap?.clientId) item.clientId = itemMap.clientId;
      }
      const previous = merged.at(-1);
      if (previous?.id === turn.id) {
        previous.items.push(...turn.items);
        previous.status = turn.status;
        previous.error = turn.error;
        previous.completedAt = turn.completedAt;
      } else merged.push(turn);
    }
    const active = this.active.get(threadId);
    for (const turn of merged) {
      if (turn.status === 'inProgress' && turn.id !== active?.turn.id) turn.status = 'interrupted';
    }
    if (active) {
      const current = merged.find(turn => turn.id === active.turn.id);
      const items = new Map([...(current?.items ?? []), ...active.turn.items].map(item => [item.id, item]));
      const live = { ...structuredClone(active.turn), items: structuredClone([...items.values()]), status: 'inProgress', error: null, completedAt: null, durationMs: null };
      if (current) Object.assign(current, live);
      else merged.push(live);
    }
    return merged;
  }

  async thread(threadId, includeTurns = false) {
    if (!this.catalog.has(threadId)) await this.discover();
    const record = this.catalog.get(threadId);
    if (!record) throw invalid(`Thread not found: ${threadId}`);
    const rpc = this.loaded.get(threadId);
    const nickname = record.isSubAgent ? rpc?.state.sessionName ?? record.name ?? null : null;
    const source = this.threadSource(record, nickname);
    return {
      id: threadId, sessionId: threadId, cwd: record.cwd, path: record.path ?? null,
      name: rpc?.state.sessionName ?? record.name ?? null, preview: record.firstMessage ?? '',
      modelProvider: 'custom', cliVersion: 'pi',
      createdAt: seconds(record.created), updatedAt: seconds(record.modified), recencyAt: seconds(record.modified),
      ephemeral: !record.path, forkedFromId: record.isSubAgent ? null : this.meta.parents?.[threadId] ?? record.parentSessionId ?? null, parentThreadId: record.isSubAgent ? record.parentSessionId ?? null : null,
      status: this.active.has(threadId) ? { type: 'active', activeFlags: [] } : { type: rpc ? 'idle' : 'notLoaded' },
      turns: includeTurns ? await this.turns(threadId) : [], source, threadSource: 'pi',
      agentNickname: nickname, agentRole: null, canAcceptDirectInput: !record.isSubAgent && !this.meta.trashed?.[threadId] && (this.inputEligibility.get(threadId) ?? Boolean(this.meta.owned?.[threadId])), extra: null, gitInfo: null,
      historyMode: 'paginated', projectId: null, section: null, sectionEnteredAt: null,
    };
  }

  threadSource(record, nickname = record.name ?? null) {
    if (!record.isSubAgent) return { custom: 'pi' };
    let ancestor = record;
    let depth = 0;
    const seen = new Set();
    while (ancestor?.isSubAgent && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      depth++;
      ancestor = this.catalog.get(ancestor.parentSessionId);
    }
    if (ancestor && !ancestor.isSubAgent) return { subAgent: { thread_spawn: { parent_thread_id: record.parentSessionId, depth, agent_nickname: nickname } } };
    return { subAgent: { other: 'pi-agents' } };
  }

  historyContext(threadId, scope) {
    return { threadId, scope };
  }

  async threadResponse(rpc, includeTurns = true, threadId = rpc.id) {
    await rpc.refresh();
    const thread = await this.thread(threadId);
    const turns = await this.turns(threadId);
    if (includeTurns) thread.turns = turns;
    const lastTurn = turns.at(-1);
    const lastItem = turns.flatMap(turn => turn.items).at(-1);
    return {
      thread, cwd: rpc.cwd, model: modelKey(rpc.state.model),
      modelProvider: 'custom', reasoningEffort: rpc.state.thinkingLevel,
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' },
      activePermissionProfile: null, instructionSources: [], runtimeWorkspaceRoots: [rpc.cwd],
      multiAgentMode: 'explicitRequestOnly', serviceTier: null,
      initialTurnsPage: null,
      itemsBackwardsCursor: lastItem ? historyCursor(lastItem.id, true, this.historyContext(threadId, 'items')) : null,
      turnsBackwardsCursor: lastTurn ? historyCursor(lastTurn.id, true, this.historyContext(threadId, 'turns')) : null,
    };
  }

  async acquireThreadMutation(threadId) {
    const previous = this.mutationQueues.get(threadId);
    if (!previous && this.mutating.has(threadId)) throw invalid('Thread configuration or history is changing. Retry after the current request finishes.');
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    this.mutationQueues.set(threadId, pending);
    await previous;
    this.mutating.add(threadId);
    return () => {
      this.mutating.delete(threadId);
      if (this.mutationQueues.get(threadId) === pending) this.mutationQueues.delete(threadId);
      release();
    };
  }

  async handle(message, emit) {
    if (message.id == null) return;
    let releaseMutation;
    let barrier;
    try {
      await this.ready;
      const threadId = message.params?.threadId;
      const mutates = threadId && ['thread/resume', 'thread/settings/update', 'thread/fork', 'thread/revert', 'thread/name/set', 'thread/compact/start', 'thread/shellCommand', 'thread/delete', 'thread/archive', 'thread/unarchive', 'turn/start', 'turn/interrupt', 'thread/queue/add', 'thread/queue/list', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start'].includes(message.method);
      if (mutates) releaseMutation = await this.acquireThreadMutation(threadId);
      if (['turn/start', 'thread/shellCommand', 'thread/queue/start'].includes(message.method) && threadId) {
        barrier = { threadId, pending: [] };
        this.notificationBarriers.set(threadId, barrier);
      }
      const result = await this.dispatch(message.method, message.params ?? {}, emit);
      if (message.method === 'thread/resume') await this.queueResume(threadId);
      this.onResponse(message, null, result);
      checkSchema({ id: message.id, result }, message.method);
      emit({ id: message.id, result });
      if (((message.method === 'thread/read' && message.params?.includeTurns) || (message.method === 'thread/resume' && !message.params?.excludeTurns)) && !this.notificationFilters.get(emit)?.has('deprecationNotice')) {
        const notice = { method: 'deprecationNotice', params: { summary: 'Full-history reads of paginated threads are deprecated.', details: 'Use thread/turns/list and thread/items/list; resume with excludeTurns and initialTurnsPage.' } };
        checkSchema(notice);
        emit(notice);
      }
      if (message.method === 'thread/settings/update') {
        const rpc = this.loaded.get(threadId);
        const model = modelKey(rpc.state.model);
        const effort = rpc.state.thinkingLevel === 'off' ? 'none' : rpc.state.thinkingLevel ?? null;
        this.notify(threadId, 'thread/settings/updated', { threadId, threadSettings: {
          disabledPluginIds: [], cwd: rpc.cwd, approvalPolicy: 'never', approvalsReviewer: 'user',
          sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: null,
          model, modelProvider: 'custom', serviceTier: null, effort, summary: null,
          collaborationMode: { mode: 'default', settings: { model, reasoning_effort: effort, developer_instructions: null } },
          multiAgentMode: 'explicitRequestOnly', personality: null,
        } });
      }
      if (message.method === 'thread/revert') this.notify(threadId, 'thread/reverted', { threadId });
      if (['thread/archive', 'thread/unarchive'].includes(message.method)) {
        this.subscribe(threadId, emit);
        this.notify(null, message.method === 'thread/archive' ? 'thread/archived' : 'thread/unarchived', { threadId });
      }
    } catch (error) {
      this.onResponse(message, error);
      try { emit({ id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.message } }); }
      catch (deliveryError) { this.disconnect(emit); throw deliveryError; }
    } finally {
      try {
        if (barrier) {
          for (const packet of barrier.pending) {
            const { emit, message } = packet;
            packet.emit = null;
            packet.message = null;
            if (!emit) continue;
            try { emit(message); }
            catch { this.disconnect(emit); }
          }
        }
      } finally {
        if (barrier) this.notificationBarriers.delete(barrier.threadId);
        releaseMutation?.();
      }
    }
  }

  async probeRpc(cwd = this.cwd) {
    cwd = resolve(cwd);
    let opening = this.probes.get(cwd);
    if (!opening) {
      opening = this.sessions.open({ cwd, ephemeral: true });
      this.probes.set(cwd, opening);
    }
    try {
      const rpc = await opening;
      if (rpc.failure) {
        if (this.probes.get(cwd) === opening) this.probes.set(cwd, (async () => {
          await rpc.close();
          return this.sessions.open({ cwd, ephemeral: true });
        })());
        return this.probeRpc(cwd);
      }
      return rpc;
    } catch (error) {
      if (this.probes.get(cwd) === opening) this.probes.delete(cwd);
      throw error;
    }
  }

  async dispatch(method, params, emit) {
    if (!Object.hasOwn(handlers, method)) throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
    return handlers[method].call(this, params, emit);
  }

  async close() {
    this.queueClosing = true;
    this.attachments.close();
    this.previews.close();
    for (const processes of this.execProcesses.values()) for (const { kill } of processes.values()) kill();
    await this.sessions.close();
    await this.saving;
  }
}

Object.assign(Protocol.prototype, turnsMethods, threadsMethods, queueMethods);
