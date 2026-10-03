import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { historyPath, sessionSettings } from '../history.mjs';
import { revertCommand, revertEntryType } from '../revert-command.mjs';
import { modelKey, invalid, supportedEfforts, applyEffort, workspaceSettings, executionSettings, providerSettings, modelIdentity } from '../codex.mjs';
import { offsetPage, historyCursor, historyPage, turnView } from '../pages.mjs';

export const threadsHandlers = {
  async 'thread/goal/get'(params) {
    await this.thread(params.threadId);
    return { goal: null };
  },
  async 'threadSection/list'() { return { data: [], nextCursor: null }; },
  async 'thread/start'(params, emit) {
    const effort = executionSettings(params);
    const cwd = resolve(params.cwd ?? this.cwd);
    workspaceSettings(params, cwd);
    const rpc = await this.sessions.open({ cwd, model: modelIdentity(params.model), ephemeral: params.ephemeral === true });
    try { providerSettings(params, rpc); await applyEffort(rpc, effort); }
    catch (error) { await rpc.close(); throw error; }
    (this.meta.owned ??= {})[rpc.id] = true;
    await this.saveMetadata();
    this.register(rpc);
    await this.discover();
    this.subscribe(rpc.id, emit);
    const response = await this.threadResponse(rpc, !params.excludeTurns);
    this.notify(rpc.id, 'thread/started', { thread: response.thread });
    return response;
  },
  async 'thread/list'(params) {
    if (!params.useStateDbOnly) await this.discover();
    const cwds = params.cwd ? new Set(Array.isArray(params.cwd) ? params.cwd : [params.cwd]) : null;
    const records = [...this.catalog.values()].filter(record => Boolean(this.meta.archives[record.id]) === Boolean(params.archived) && (!cwds || cwds.has(record.cwd)) && (!params.searchTerm || `${record.name ?? ''} ${record.firstMessage ?? ''}`.toLowerCase().includes(params.searchTerm.toLowerCase())));
    if (params.parentThreadId && params.ancestorThreadId) throw invalid('parentThreadId and ancestorThreadId cannot be combined.');
    if (params.sortKey != null && !['created_at', 'updated_at', 'recency_at'].includes(params.sortKey)) throw invalid(`Unsupported sortKey ${JSON.stringify(typeof params.sortKey === 'string' ? params.sortKey.slice(0, 64) : typeof params.sortKey)}; use created_at, updated_at, or recency_at.`);
    const filtered = records.filter(record => {
      if (params.modelProviders?.length && !params.modelProviders.includes('custom')) return false;
      if (params.sourceKinds?.length) {
        if (record.isSubAgent ? !params.sourceKinds.some(kind => ['subAgent', 'subAgentOther'].includes(kind)) : !params.sourceKinds.includes('unknown')) return false;
      } else if (record.isSubAgent && (!(params.parentThreadId || params.ancestorThreadId) || params.sourceKinds != null)) return false;
      if (params.projectId != null || params.sectionId != null) return false;
      if (params.parentThreadId && (!record.isSubAgent || record.parentSessionId !== params.parentThreadId)) return false;
      if (params.ancestorThreadId) {
        if (record.id === params.ancestorThreadId) return false;
        const seen = new Set([record.id]);
        let parent = record.isSubAgent ? record.parentSessionId : null;
        while (parent && !seen.has(parent)) {
          if (parent === params.ancestorThreadId) return true;
          seen.add(parent);
          const ancestor = this.catalog.get(parent);
          parent = ancestor?.isSubAgent ? ancestor.parentSessionId : null;
        }
        return false;
      }
      return true;
    });
    const key = ['updated_at', 'recency_at'].includes(params.sortKey) ? 'modified' : 'created';
    filtered.sort((a, b) => new Date(b[key]) - new Date(a[key]) || a.id.localeCompare(b.id));
    if (params.sortDirection === 'asc') filtered.reverse();
    else if (params.sortDirection != null && params.sortDirection !== 'desc') throw invalid('sortDirection must be asc or desc.');
    const page = params.cursor != null && /^(after|at):/.test(params.cursor) ? historyPage(filtered, params, record => record.id) : offsetPage(filtered, params);
    return { ...page, nextCursor: page.nextCursor ? 'after:' + page.data.at(-1).id : null, data: await Promise.all(page.data.map(record => this.thread(record.id))), backwardsCursor: page.data.length ? 'at:' + page.data[0].id : null };
  },
  async 'thread/read'(params, emit) {
    await this.discover();
    this.subscribe(params.threadId, emit);
    return { thread: await this.thread(params.threadId, params.includeTurns) };
  },
  async 'thread/resume'(params, emit) {
    const effort = executionSettings(params);
    if (params.history != null || params.path) throw invalid('History and path overrides are unsupported; resume by threadId.');
    let readOnly = !this.meta.owned?.[params.threadId];
    if (!readOnly && !this.loaded.has(params.threadId)) {
      await this.discover();
      const record = this.catalog.get(params.threadId);
      if (record && !this.meta.trashed?.[params.threadId]) {
        try { await this.trash.assertSessionNotOpen(record.path); }
        catch { readOnly = true; }
      }
    }
    if (readOnly) {
      await this.discover();
      const record = this.catalog.get(params.threadId);
      if (!record) throw invalid('Thread not found.');
      workspaceSettings(params, record.cwd);
      const { header, entries } = await this.history.readHistory(record.path);
      if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Remote can resume it.');
      if (header.id !== params.threadId) throw invalid('Session history identity changed. Refresh the list before resuming.');
      this.inputEligibility.set(params.threadId, false);
      if (!this.meta.trashed?.[params.threadId]) {
        try {
          await this.trash.assertSessionNotOpen(record.path);
          this.inputEligibility.set(params.threadId, true);
        } catch { /* Read-only history remains available when acquisition is unsafe. */ }
      }
      const saved = sessionSettings(entries);
      const probe = await this.probeRpc(record.cwd);
      providerSettings(params, { state: { model: saved.model ?? probe.state.model } });
      const model = modelKey(saved.model ?? probe.state.model);
      const thinkingLevel = saved.thinkingLevel ?? probe.state.thinkingLevel;
      if ((params.model && params.model !== model) || (effort != null && effort !== thinkingLevel)) throw invalid('External history resume is read-only. Keep its saved settings when opening, then send a task to take over after closing the desktop session.');
      this.subscribe(params.threadId, emit);
      const response = await this.threadResponse(probe, !params.excludeTurns, params.threadId);
      response.model = model;
      response.reasoningEffort = thinkingLevel;
      if (params.initialTurnsPage) response.initialTurnsPage = await this.dispatch('thread/turns/list', { ...params.initialTurnsPage, threadId: params.threadId }, emit);
      return response;
    }
    const rpc = await this.rpc(params.threadId);
    workspaceSettings(params, rpc.cwd);
    providerSettings(params, rpc);
    const modelChanged = params.model != null && params.model !== modelKey(rpc.state.model);
    const effortChanged = effort != null && effort !== rpc.state.thinkingLevel;
    if (this.active.has(rpc.id) && (modelChanged || effortChanged)) throw invalid('Cannot change model or thinking effort while its turn is active.');
    if (modelChanged) await rpc.request('set_model', modelIdentity(params.model));
    if (effortChanged) await applyEffort(rpc, effort);
    this.subscribe(rpc.id, emit);
    const response = await this.threadResponse(rpc, !params.excludeTurns);
    if (params.initialTurnsPage) response.initialTurnsPage = await this.dispatch('thread/turns/list', { ...params.initialTurnsPage, threadId: rpc.id }, emit);
    return response;
  },
  async 'thread/settings/update'(params, emit) { return this.updateThreadSettings(params, emit); },
  async 'thread/loaded/list'(params) { return offsetPage([...this.loaded.keys()], params, Math.max(this.loaded.size, 1)); },
  async 'thread/turns/list'(params) {
    await this.discover();
    await this.thread(params.threadId);
    const turns = await this.turns(params.threadId);
    if (params.sortDirection !== 'asc') turns.reverse();
    const page = historyPage(turns, params, turn => turn.id, this.historyContext(params.threadId, 'turns'));
    page.data = page.data.map(turn => turnView(turn, params.itemsView ?? 'summary'));
    return page;
  },
  async 'thread/items/list'(params) {
    await this.discover();
    await this.thread(params.threadId);
    const turns = await this.turns(params.threadId);
    if (params.turnId && !turns.some(turn => turn.id === params.turnId)) throw invalid('Turn not found.');
    const items = turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
    const context = this.historyContext(params.threadId, 'items');
    if (params.cursor != null && typeof params.cursor === 'object') {
      if (!params.turnId || params.cursor.type !== 'item' || typeof params.cursor.itemId !== 'string' || !params.cursor.itemId || !items.some(entry => entry.turnId === params.turnId && entry.item.id === params.cursor.itemId)) throw invalid('An item anchor requires turnId and an itemId belonging to that turn.');
      params = { ...params, cursor: historyCursor(params.cursor.itemId, false, context) };
    }
    if (params.sortDirection === 'desc') items.reverse();
    return historyPage(items, params, entry => entry.item.id, context, entry => !params.turnId || entry.turnId === params.turnId);
  },
  async 'thread/name/set'(params) {
    if (!this.meta.owned?.[params.threadId]) throw invalid('Externally created Pi sessions are read-only in Remote. Fork before renaming.');
    const rpc = await this.rpc(params.threadId);
    await rpc.request('set_session_name', { name: params.name });
    await rpc.refresh();
    this.notify(rpc.id, 'thread/name/updated', { threadId: rpc.id, threadName: params.name });
    return {};
  },
  async 'thread/fork'(params, emit) { return this.fork(params, emit); },
  async 'thread/revert'(params, emit) { return this.revert(params, emit); },
  async 'thread/archive'(params) { return this.archive(params.threadId); },
  async 'thread/unarchive'(params) { return this.unarchive(params.threadId); },
  async 'thread/delete'({ threadId }) {
    await this.thread(threadId);
    if (!this.meta.trashed?.[threadId]) await this.archive(threadId);
    for (const map of [this.meta.trashed, this.meta.archives, this.meta.owned, this.meta.parents, this.meta.queues]) if (map) delete map[threadId];
    this.catalog.delete(threadId);
    this.inputEligibility.delete(threadId);
    await this.saveMetadata();
    this.notify(null, 'thread/deleted', { threadId });
    return {};
  },
  async 'thread/search'(params) {
    const { searchTerm } = params;
    if (typeof searchTerm !== 'string' || !searchTerm.trim()) throw invalid('searchTerm must be a non-empty string.');
    if (params.sortKey != null && !['created_at', 'updated_at', 'recency_at'].includes(params.sortKey)) throw invalid('sortKey must be created_at, updated_at, or recency_at.');
    if (params.sortDirection != null && !['asc', 'desc'].includes(params.sortDirection)) throw invalid('sortDirection must be asc or desc.');
    await this.discover();
    const term = searchTerm.toLowerCase();
    const hits = [];
    for (const record of this.catalog.values()) {
      if (record.isSubAgent || !record.path || Boolean(this.meta.archives[record.id]) !== Boolean(params.archived)) continue;
      const text = await this.history.readSearchText(record.path);
      const index = text.toLowerCase().indexOf(term);
      if (index >= 0) hits.push({ record, snippet: text.slice(Math.max(0, index - 60), index + term.length + 60).replace(/\s+/g, ' ').trim() });
    }
    const key = params.sortKey === 'created_at' ? 'created' : 'modified';
    hits.sort((a, b) => new Date(b.record[key]) - new Date(a.record[key]) || a.record.id.localeCompare(b.record.id));
    if (params.sortDirection === 'asc') hits.reverse();
    const page = offsetPage(hits, params);
    return { ...page, data: await Promise.all(page.data.map(async ({ record, snippet }) => ({ thread: await this.thread(record.id), snippet }))), backwardsCursor: null };
  },
  async 'thread/backgroundTerminals/list'() { return { data: [], nextCursor: null }; },
  async 'thread/unsubscribe'(params, emit) {
    this.unsubscribe(params.threadId, emit);
    return { status: 'unsubscribed' };
  },
  async 'thread/compact/start'(params, emit) {
    if (!this.meta.owned?.[params.threadId]) throw invalid('Externally created Pi sessions are read-only in Remote. Fork before compacting.');
    if (this.active.has(params.threadId)) throw invalid('Cannot compact an active turn.');
    const rpc = await this.rpc(params.threadId);
    const { entries } = await rpc.request('get_entries');
    this.subscribe(rpc.id, emit);
    const active = this.startOperationTurn(rpc, 'compaction');
    active.priorEntries = new Set(entries.map(entry => entry.id));
    void rpc.request('compact').then(() => this.finish(active)).catch(error => {
      if (active.finished) return;
      active.error = error.message;
      if (!active.compactionErrorReported && !active.interrupted) this.notify(rpc.id, 'error', { threadId: rpc.id, turnId: active.turn.id, willRetry: false, error: { message: error.message, codexErrorInfo: null, additionalDetails: null } });
      this.finishNotification(active);
    });
    return {};
  },
};

export const threadsMethods = {
  async archive(threadId) {
    await this.thread(threadId);
    if (this.meta.trashed?.[threadId]) return {};
    const record = this.catalog.get(threadId);
    if (!record.path) throw invalid('Ephemeral sessions have no history file to move to Trash.');
    try { await stat(record.path); }
    catch (error) {
      if (error.code === 'ENOENT') throw invalid('Session history is not on disk. Send a message first, or refresh the list if it was removed.');
      throw error;
    }
    const { header } = await this.history.readHistory(record.path);
    if (header.id !== threadId) throw invalid('Session history identity changed. Refresh the list before archiving.');
    const rpc = this.loaded.get(threadId);
    await this.trash.assertSessionNotOpen(record.path, { ignorePids: rpc?.child?.pid ? [rpc.child.pid] : [] });
    const active = this.active.get(threadId);
    if (active) {
      await this.dispatch('turn/interrupt', { threadId, turnId: active.turn.id });
      await active.finishing;
    }
    if (rpc) {
      await rpc.close();
      this.loaded.delete(threadId);
    }
    if (active) this.finishNotification(active);
    await this.trash.assertSessionNotOpen(record.path);
    const originalPath = record.path;
    const trashPath = await this.trash.trashSession(originalPath);
    const previous = this.meta.archives[threadId];
    (this.meta.trashed ??= {})[threadId] = { originalPath, trashPath, record };
    this.meta.archives[threadId] = true;
    this.catalog.set(threadId, { ...record, path: trashPath });
    try { await this.saveMetadata(); }
    catch (error) {
      try { await this.trash.restoreSession(trashPath, originalPath); }
      catch (rollback) { throw new Error(`Archive metadata failed; history remains in Trash at ${trashPath}. ${rollback.message}`, { cause: error }); }
      delete this.meta.trashed[threadId];
      if (previous === undefined) delete this.meta.archives[threadId];
      else this.meta.archives[threadId] = previous;
      this.catalog.set(threadId, record);
      try { await this.saveMetadata(); }
      catch (repair) { throw new Error(`Archive rollback metadata could not be saved; history is at ${originalPath}. Fix state-directory write access before retrying.`, { cause: repair }); }
      throw error;
    }
    return {};
  },

  async unarchive(threadId) {
    await this.thread(threadId);
    const archived = this.meta.trashed?.[threadId];
    const previous = this.meta.archives[threadId];
    if (archived) {
      let header;
      try { ({ header } = await this.history.readHistory(archived.trashPath)); }
      catch (error) {
        if (error.code === 'ENOENT') throw invalid('Trashed history is unavailable. Trash may have been emptied; recover it from a backup.');
        throw error;
      }
      if (header.id !== threadId) throw invalid('Trash item identity changed. Restore the correct session manually.');
      await this.trash.assertSessionNotOpen(archived.originalPath);
      await this.trash.restoreSession(archived.trashPath, archived.originalPath);
      delete this.meta.trashed[threadId];
      this.catalog.set(threadId, { ...archived.record, path: archived.originalPath });
    }
    this.meta.archives[threadId] = false;
    try { await this.saveMetadata(); }
    catch (error) {
      this.meta.archives[threadId] = previous;
      if (archived) {
        try { await this.trash.restoreSession(archived.originalPath, archived.trashPath); }
        catch (rollback) { throw new Error(`Unarchive metadata failed; history is at ${archived.originalPath}. ${rollback.message}`, { cause: error }); }
        this.meta.trashed[threadId] = archived;
        this.catalog.set(threadId, { ...archived.record, path: archived.trashPath });
      }
      try { await this.saveMetadata(); }
      catch (repair) { throw new Error(`Unarchive rollback metadata could not be saved; history is at ${archived?.trashPath ?? this.catalog.get(threadId).path}. Fix state-directory write access before retrying.`, { cause: repair }); }
      throw error;
    }
    return { thread: await this.thread(threadId) };
  },

  async revert(params, emit) {
    const { threadId, beforeTurnId } = params;
    if (typeof threadId !== 'string' || !threadId) throw invalid('threadId must be a non-empty string.');
    if (typeof beforeTurnId !== 'string' || !beforeTurnId) throw invalid('beforeTurnId must be a non-empty string.');
    const thread = await this.rewind(threadId, beforeTurnId, emit);
    const lastTurn = thread.turns.at(-1);
    const lastItem = thread.turns.flatMap(turn => turn.items).at(-1);
    return {
      thread: { ...thread, turns: [] },
      itemsBackwardsCursor: lastItem ? historyCursor(lastItem.id, true, this.historyContext(threadId, 'items')) : null,
      turnsBackwardsCursor: lastTurn ? historyCursor(lastTurn.id, true, this.historyContext(threadId, 'turns')) : null,
    };
  },

  async rewind(threadId, beforeTurnId, emit) {
    if (!this.meta.owned?.[threadId]) throw invalid('External Pi histories are read-only for revert. Fork before editing, or use a session already explicitly taken over by Remote.');
    if (this.active.has(threadId)) throw invalid('Cannot revert an active turn. Stop it and wait for Pi to become idle.');
    if (this.meta.trashed?.[threadId]) throw invalid('Session is in Trash. Unarchive it before editing.');
    await this.discover();
    const record = this.catalog.get(threadId);
    if (!record?.path) throw invalid('Revert requires a persisted Pi session.');
    const wireTurns = await this.turns(threadId);
    if (!wireTurns.some(turn => turn.id === beforeTurnId)) throw invalid('beforeTurnId is not in the active thread history. Refresh the thread before retrying.');
    const cached = this.loaded.get(threadId);
    await this.trash.assertSessionNotOpen(record.path, { ignorePids: cached?.child?.pid ? [cached.child.pid] : [] });
    const rpc = await this.rpc(threadId);
    if (rpc.state.isStreaming || rpc.state.isCompacting || rpc.state.pendingMessageCount > 0) throw invalid('Wait for Pi to finish active work, compaction, and queued messages before editing.');
    await this.trash.assertSessionNotOpen(record.path, { ignorePids: rpc.child?.pid ? [rpc.child.pid] : [] });
    const { entries, leafId } = await rpc.request('get_entries');
    const nativeTurns = this.history.projectTurns(entries, { leafId });
    const targetTurn = nativeTurns.find(turn => (this.meta.entries[turn.id]?.turnId ?? turn.id) === beforeTurnId);
    const target = entries.find(entry => entry.id === targetTurn?.id);
    if (target?.type !== 'message' || target.message.role !== 'user') throw invalid('Revert boundary is not an active user turn. Refresh the thread before retrying.');
    const { commands } = await rpc.request('get_commands');
    if (!commands.some(command => command.name === revertCommand && command.source === 'extension')) throw invalid('The Remote history command is unavailable. Reload the Remote RPC extension before editing.');
    const operationId = randomUUID();
    let commandError;
    const unsubscribe = rpc.onEvent(event => {
      if (event.type === 'extension_error' && event.extensionPath === `command:${revertCommand}`) commandError = event.error;
    });
    try {
      const result = await rpc.request('prompt', { message: `/${revertCommand} ${JSON.stringify({ operationId, threadId, expectedLeafId: leafId, targetId: target.id })}` });
      if (commandError) throw new Error(commandError);
      if (result?.disposition !== 'handled') throw new Error('Pi did not handle the Remote history command.');
      const snapshot = await rpc.request('get_entries');
      const marker = snapshot.entries.find(entry => entry.id === snapshot.leafId);
      const committed = entry => entry?.type === 'custom' && entry.customType === revertEntryType
        && entry.data?.operationId === operationId && entry.data.phase === 'committed'
        && entry.data.targetId === target.id && entry.data.fromLeafId === leafId && entry.parentId === target.parentId;
      if (!committed(marker)) throw new Error('Pi did not confirm the requested history boundary.');
      const persisted = await this.history.readHistory(record.path);
      if (persisted.header.id !== threadId || persisted.header.version !== 3 || !committed(persisted.entries.at(-1)) || persisted.entries.at(-1).id !== marker.id) throw new Error('The history revert could not be verified on disk.');
      await rpc.refresh();
      if (rpc.id !== threadId || await historyPath(rpc.sessionFile) !== await historyPath(record.path)) throw new Error('Pi session identity changed during revert.');
      await this.discover();
      this.subscribe(threadId, emit);
      return await this.thread(threadId, true);
    } catch (error) {
      await rpc.close();
      this.loaded.delete(threadId);
      throw new Error(`History revert was not confirmed: ${error.message} Reopen the thread to inspect its saved branch before retrying. Original history entries were retained.`, { cause: error });
    } finally { unsubscribe(); }
  },

  async fork(params, emit) {
    const effort = executionSettings(params);
    if (this.active.has(params.threadId)) throw invalid('Cannot fork an active turn.');
    if (params.path || params.ephemeral || params.truncationTurnId != null) throw invalid('Fork path, ephemeral, and truncationTurnId are unsupported. Use threadId with beforeTurnId or lastTurnId.');
    if (params.beforeTurnId && params.lastTurnId) throw invalid('beforeTurnId and lastTurnId cannot be combined.');
    const external = !this.meta.owned?.[params.threadId];
    if (params.model) modelIdentity(params.model);
    let rpc;
    try {
      if (external) {
        await this.discover();
        const record = this.catalog.get(params.threadId);
        if (!record) throw invalid('Thread not found.');
        workspaceSettings(params, record.cwd);
        const { header } = await this.history.readHistory(record.path);
        if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Remote can fork it.');
        rpc = await this.sessions.open({ cwd: record.cwd, forkFrom: record.path });
      } else rpc = await this.rpc(params.threadId);
      providerSettings(params, rpc);
      if (params.cwd && resolve(params.cwd) !== rpc.cwd) throw invalid('Changing workspace while forking is unsupported.');
      const { entries, leafId } = await rpc.request('get_entries');
      const nativeTurns = this.history.projectTurns(entries, { leafId });
      const cutoff = params.beforeTurnId ?? params.lastTurnId;
      let entryId;
      if (cutoff) {
        const matches = turn => turn.id === cutoff || this.meta.entries[turn.id]?.turnId === cutoff;
        const index = params.beforeTurnId ? nativeTurns.findIndex(matches) : nativeTurns.findLastIndex(matches);
        if (index < 0) throw invalid(`Fork turn not found: ${cutoff}`);
        entryId = params.beforeTurnId ? nativeTurns[index].id : nativeTurns[index + 1]?.id;
      }
      const oldId = params.threadId;
      const oldPath = this.catalog.get(oldId)?.path;
      const snapshotId = rpc.id;
      const result = external && !entryId ? { cancelled: false } : await rpc.request(entryId ? 'fork' : 'clone', entryId ? { entryId } : {});
      if (external && entryId) this.meta.archives[snapshotId] = true;
      if (result?.cancelled) throw new Error('Pi cancelled the fork.');
      await rpc.refresh();
      if (rpc.id === oldId) throw new Error('Pi did not create a new fork.');
      const childId = rpc.id;
      this.mutating.add(childId);
      try {
        this.loaded.delete(oldId);
        if (external) this.register(rpc);
        else this.loaded.set(rpc.id, rpc);
        this.catalog.set(oldId, { ...this.catalog.get(oldId), path: oldPath });
        await this.discover();
        (this.meta.parents ??= {})[rpc.id] = oldId;
        (this.meta.owned ??= {})[rpc.id] = true;
        await this.saveMetadata();
        if (params.model) await rpc.request('set_model', modelIdentity(params.model));
        await applyEffort(rpc, effort);
        this.subscribe(rpc.id, emit);
        const response = await this.threadResponse(rpc, !params.excludeTurns);
        this.notify(rpc.id, 'thread/started', { thread: response.thread });
        return response;
      } finally { this.mutating.delete(childId); }
    } catch (error) {
      if (external && rpc) {
        await rpc.close();
        this.loaded.delete(rpc.id);
        this.subscribers.delete(rpc.id);
        if (rpc.id !== params.threadId) {
          this.meta.archives[rpc.id] = true;
          await this.saveMetadata();
        }
      }
      throw error;
    }
  },

  async updateThreadSettings(params, emit) {
    const fields = ['threadId', 'disabledPluginIds', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'model', 'serviceTier', 'effort', 'summary', 'collaborationMode', 'multiAgentMode', 'personality'];
    for (const key of Object.keys(params)) if (!fields.includes(key)) throw invalid(`Unsupported thread/settings/update parameter: ${key}`);
    if (typeof params.threadId !== 'string' || !params.threadId) throw invalid('threadId must be a non-empty string.');
    if (params.model != null && (typeof params.model !== 'string' || !params.model)) throw invalid('model must be a provider-qualified Pi model from model/list.');
    if (params.cwd != null && (typeof params.cwd !== 'string' || !params.cwd)) throw invalid('cwd must be the existing session working directory.');
    if (params.approvalPolicy != null && params.approvalPolicy !== 'never') throw invalid('Pi does not enforce Codex approval policies. Use Pi extensions or omit approvalPolicy.');
    if (params.approvalsReviewer != null && params.approvalsReviewer !== 'user') throw invalid('Delegated Codex approval reviewers are not supported.');
    if (params.sandboxPolicy != null && params.sandboxPolicy?.type !== 'dangerFullAccess') throw invalid('Pi does not enforce Codex sandbox policies. Use Pi permissions or omit sandboxPolicy.');
    if (params.disabledPluginIds != null && (!Array.isArray(params.disabledPluginIds) || params.disabledPluginIds.length)) throw invalid('disabledPluginIds overrides are not supported by Pi Remote.');
    if (params.multiAgentMode != null && params.multiAgentMode !== 'explicitRequestOnly') throw invalid('Proactive multi-agent mode is not supported by Pi Remote.');
    const effort = executionSettings(params);
    if (params.model) modelIdentity(params.model);
    const external = !this.meta.owned?.[params.threadId];
    if (external && this.active.has(params.threadId)) throw invalid('Cannot change settings while its turn is active.');
    const rpc = external ? await this.takeover(params, effort, {}) : await this.rpc(params.threadId);
    workspaceSettings(params, rpc.cwd);
    if (!external) {
      const modelChanged = params.model != null && params.model !== modelKey(rpc.state.model);
      const effortChanged = effort != null && effort !== rpc.state.thinkingLevel;
      if ((this.active.has(params.threadId) || rpc.state.isStreaming || rpc.state.isCompacting) && (modelChanged || effortChanged)) throw invalid('Cannot change model or thinking effort while its turn is active.');
      const identity = params.model ? modelIdentity(params.model) : rpc.state.model;
      const { models } = await rpc.request('get_available_models');
      const selected = models.find(model => model.provider === identity?.provider && model.id === (identity.modelId ?? identity.id));
      if (!selected) throw invalid('Requested model is unavailable in Pi. Choose an available model from model/list.');
      if (effort != null && !supportedEfforts(selected).includes(effort)) throw invalid('Requested reasoning effort is unavailable for the selected Pi model.');
      if (modelChanged) { await rpc.request('set_model', modelIdentity(params.model)); await rpc.refresh(); }
      if (effort != null && effort !== rpc.state.thinkingLevel) await applyEffort(rpc, effort);
    }
    await rpc.refresh();
    this.subscribe(rpc.id, emit);
    return {};
  },

  async takeover(params, effort, prompt) {
    const id = params.threadId;
    if (this.meta.trashed?.[id]) throw invalid('Session is in Trash. Unarchive it before sending tasks.');
    await this.discover();
    const record = this.catalog.get(id);
    if (!record) throw invalid('Thread not found.');
    workspaceSettings(params, record.cwd);
    const { header, entries } = await this.history.readHistory(record.path);
    if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Remote can resume it.');
    if (header.id !== id) throw invalid('Session history identity changed. Refresh the list before sending tasks.');
    this.inputEligibility.delete(id);
    await this.trash.assertSessionNotOpen(record.path);
    const probe = await this.probeRpc(record.cwd);
    const saved = sessionSettings(entries);
    const identity = params.model ? modelIdentity(params.model) : saved.model ?? probe.state.model;
    const { models } = await probe.request('get_available_models');
    const selected = models.find(model => model.provider === identity.provider && model.id === (identity.modelId ?? identity.id));
    if (!selected) throw invalid('Requested model is unavailable in Pi. Choose an available model before sending.');
    providerSettings(params, { state: { model: selected } });
    if (effort != null && !supportedEfforts(selected).includes(effort)) throw invalid('Requested reasoning effort is unavailable for the selected Pi model.');
    if (prompt.images?.length && !selected.input?.includes('image')) throw invalid('The selected Pi model does not support image input.');
    // Recheck after the probe; acquisition uses the original path, never a fork.
    await this.trash.assertSessionNotOpen(record.path);
    const latest = await this.history.readHistory(record.path);
    if (latest.header.version !== 3 || latest.header.id !== id) throw invalid('Session history identity changed. Refresh the list before sending tasks.');
    let rpc;
    let ownershipAttempted = false;
    try {
      rpc = await this.sessions.open({ cwd: record.cwd, sessionFile: record.path });
      if (rpc.id !== id || await historyPath(rpc.sessionFile) !== await historyPath(record.path)) throw invalid('Pi opened a different session. Refresh the list before retrying.');
      if (rpc.state.isStreaming || rpc.state.isCompacting) throw invalid('Pi session is already running. Wait for it to finish before retrying.');
      await this.trash.assertSessionNotOpen(record.path, { ignorePids: rpc.child?.pid ? [rpc.child.pid] : [] });
      if (params.model) await rpc.request('set_model', modelIdentity(params.model));
      await applyEffort(rpc, effort);
      (this.meta.owned ??= {})[id] = true;
      ownershipAttempted = true;
      await this.saveMetadata();
      this.register(rpc);
      return rpc;
    } catch (error) {
      if (ownershipAttempted) delete this.meta.owned[id];
      try { if (rpc) await rpc.close(); }
      finally {
        if (ownershipAttempted) {
          try { await this.saveMetadata(); }
          catch (repair) {
            throw new Error(`Takeover failed and ownership rollback could not be saved. Fix state-directory write access before retrying. ${repair.message}`, { cause: error });
          }
        }
      }
      throw error;
    }
  },
};
