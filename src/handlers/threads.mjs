import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { historyPath, sessionSettings } from '../history.mjs';
import { revertCommand, revertEntryType } from '../revert-command.mjs';
import { modelKey, invalid, supportedEfforts, applyEffort, workspaceSettings, executionSettings, providerSettings, modelIdentity } from '../codex.mjs';
import { offsetPage, historyCursor, historyPage, turnView } from '../pages.mjs';

// The latest turns the app's scan of a parent reads; an Agent spawned before them still opens by its ID.
const ASC_SCAN_WINDOW = 300;

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
    try {
      providerSettings(params, rpc);
      if (params.model && params.model !== modelKey(rpc.state.model)) await rpc.request('set_model', modelIdentity(params.model));
      await applyEffort(rpc, effort);
    }
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
    if (!params.useStateDbOnly) await this.discover({ cached: true });
    const cwds = params.cwd ? new Set(Array.isArray(params.cwd) ? params.cwd : [params.cwd]) : null;
    const records = [...this.catalog.values()].filter(record => Boolean(this.meta.archives[record.id]) === Boolean(params.archived) && (!cwds || cwds.has(record.cwd)) && (!params.searchTerm || `${record.name ?? ''} ${record.firstMessage ?? ''}`.toLowerCase().includes(params.searchTerm.toLowerCase())));
    if (params.parentThreadId && params.ancestorThreadId) throw invalid('parentThreadId and ancestorThreadId cannot be combined.');
    if (params.sortKey != null && !['created_at', 'updated_at', 'recency_at'].includes(params.sortKey)) throw invalid(`Unsupported sortKey ${JSON.stringify(typeof params.sortKey === 'string' ? params.sortKey.slice(0, 64) : typeof params.sortKey)}; use created_at, updated_at, or recency_at.`);
    let filtered = records.filter(record => {
      if (params.modelProviders?.length && !params.modelProviders.includes('custom')) return false;
      if (params.sourceKinds?.length) {
        const sourceKind = record.isSubAgent ? (this.threadSource(record).subAgent.thread_spawn ? 'subAgentThreadSpawn' : 'subAgentOther') : 'unknown';
        if (!params.sourceKinds.includes(sourceKind) && !(record.isSubAgent && params.sourceKinds.includes('subAgent'))) return false;
      } else if (record.isSubAgent && (!(params.parentThreadId || params.ancestorThreadId) || params.sourceKinds != null)) return false;
      if (params.projectId != null || params.sectionId != null || params.attachedToThreadId != null) return false;
      if (params.excludedThreadIds?.includes(record.id)) return false;
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
    // A thread's Agents list their running ones and the 50 last active; the app reads each it lists, and others open by ID.
    if (params.parentThreadId || params.ancestorThreadId) {
      const idle = new Set(filtered.filter(record => this.threadStatus(record.id).type !== 'active').sort((a, b) => new Date(b.lastActive ?? b.modified) - new Date(a.lastActive ?? a.modified)).slice(50));
      // A page's anchor stays listed, so its cursor still continues the list.
      const anchor = typeof params.cursor === 'string' ? params.cursor.replace(/^(after|at):/, '') : null;
      filtered = filtered.filter(record => !idle.has(record) || record.id === anchor);
    }
    const key = ['updated_at', 'recency_at'].includes(params.sortKey) ? 'modified' : 'created';
    filtered.sort((a, b) => new Date(b[key]) - new Date(a[key]) || a.id.localeCompare(b.id));
    if (params.sortDirection === 'asc') filtered.reverse();
    else if (params.sortDirection != null && params.sortDirection !== 'desc') throw invalid('sortDirection must be asc or desc.');
    const page = params.cursor != null && /^(after|at):/.test(params.cursor) ? historyPage(filtered, params, record => record.id) : offsetPage(filtered, params);
    return { ...page, nextCursor: page.nextCursor ? 'after:' + page.data.at(-1).id : null, data: await Promise.all(page.data.map(record => this.thread(record.id))), backwardsCursor: page.data.length ? 'at:' + page.data[0].id : null };
  },
  async 'thread/read'(params, emit) {
    this.subscribe(params.threadId, emit);
    return { thread: await this.thread(params.threadId, params.includeTurns) };
  },
  async 'thread/resume'(params, emit) {
    const settings = { ...params, developerInstructions: undefined, config: { ...params.config } };
    if (['none', 'friendly', 'pragmatic'].includes(settings.personality)) settings.personality = undefined;
    for (const key of ['apps_mcp_path_override', 'code_mode_tool_description_first', 'collaboration_modes', 'item_ids', 'image_detail_original',
      'unified_image_budget', 'mcp_oauth_refresh_coordination', 'untrusted_as_tool_output', 'image_resize_notice',
      'code_mode_interrupt', 'instant_interrupt', 'request_rule', 'image_generation', 'workspace_dependencies',
      'guardian_approval', 'guardian_reuse_parent_compaction', 'incremental_tools', 'skill_catalog_deltas',
      'output_token_replay', 'deferred_tool_world_state', 'write_stdin_approval', 'enable_mcp_apps',
      'recommended_plugins', 'compaction_image_budget', 'guardianv2_decisions_comparison']) {
      if (typeof settings.config[`features.${key}`] === 'boolean') delete settings.config[`features.${key}`];
    }
    for (const key of ['features.guardianv2', 'apps.connector_openai_pages.tools']) {
      const value = settings.config[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) delete settings.config[key];
    }
    const effort = executionSettings(settings);
    if (params.history != null) throw invalid('History overrides are unsupported; resume by threadId.');
    if (params.path != null && typeof params.path !== 'string') throw invalid('Resume path must be a string.');
    if (!this.catalog.has(params.threadId)) await this.discover();
    if (params.path) {
      const record = this.catalog.get(params.threadId);
      if (!record) throw invalid('Thread not found.');
      if (!isAbsolute(params.path) || await realpath(params.path).catch(() => null) !== await realpath(record.path)) {
        throw invalid('Resume path must match the existing Pi session selected by threadId.');
      }
    }
    // Viewing a hosted thread joins its running host, so turns started elsewhere stream to the viewer; it never starts a host.
    const viewed = this.catalog.get(params.threadId);
    if (this.sessions.hosted && viewed && !viewed.isSubAgent && !this.loaded.has(params.threadId) && (await this.trash.sessionPids(viewed.path)).length) {
      // A Pi outside pi-agents holding the session cannot be joined; its history is read as before.
      await this.rpc(params.threadId).catch(() => {});
    }
    let readOnly = this.catalog.get(params.threadId)?.isSubAgent || !this.meta.owned?.[params.threadId];
    if (!readOnly && !this.loaded.has(params.threadId) && !this.sessions.hosted) {
      const record = this.catalog.get(params.threadId);
      if (record && !this.meta.trashed?.[params.threadId]) {
        try { await this.trash.assertSessionNotOpen(record.path); }
        catch { readOnly = true; }
      }
    }
    // Viewing an unloaded thread reads its history without opening the session; sending opens it.
    if (readOnly || !this.loaded.has(params.threadId)) {
      const record = this.catalog.get(params.threadId);
      if (!record) throw invalid('Thread not found.');
      workspaceSettings(params, record.cwd);
      const { header, entries } = await this.history.loadSession(record.path);
      if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Codex Remote can resume it.');
      if (header.id !== params.threadId) throw invalid('Session history identity changed. Refresh the list before resuming.');
      this.inputEligibility.set(params.threadId, false);
      // pi-agents joins hosted sessions; one open in a Pi outside a host fails on send.
      if (!record.isSubAgent && !this.meta.trashed?.[params.threadId] && this.sessions.hosted) this.inputEligibility.set(params.threadId, true);
      else if (!record.isSubAgent && !this.meta.trashed?.[params.threadId]) {
        try {
          await this.trash.assertSessionNotOpen(record.path);
          this.inputEligibility.set(params.threadId, true);
        } catch { /* Read-only history remains available when acquisition is unsafe. */ }
      }
      const saved = sessionSettings(entries);
      const probe = await this.settingsProbe(record.cwd);
      providerSettings(params, { state: { model: saved.model ?? probe.state.model } });
      const model = modelKey(saved.model ?? probe.state.model);
      const thinkingLevel = saved.thinkingLevel ?? probe.state.thinkingLevel;
      const changed = (params.model && params.model !== model) || (effort != null && effort !== thinkingLevel);
      if (changed && readOnly) throw invalid('External history resume is read-only. Keep its saved settings when opening, then send a task to take over after closing the desktop session.');
      if (!changed) {
        this.subscribe(params.threadId, emit);
        const response = await this.threadResponse(probe, !params.excludeTurns, params.threadId);
        response.model = model;
        response.reasoningEffort = thinkingLevel;
        if (params.initialTurnsPage) response.initialTurnsPage = await this.dispatch('thread/turns/list', { ...params.initialTurnsPage, threadId: params.threadId }, emit);
        return response;
      }
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
    await this.thread(params.threadId);
    let turns = await this.turns(params.threadId);
    // Before opening an Agent the app reads its parent's turns without items, 100 at a time from the first; it starts at the latest ones.
    // Reads of the first turn, or of whole turns, are smaller pages or load items, and keep starting at the first.
    if (params.sortDirection === 'asc' && params.cursor == null && params.itemsView === 'notLoaded' && params.limit >= 100) turns = turns.slice(-ASC_SCAN_WINDOW);
    if (params.sortDirection !== 'asc') turns.reverse();
    const page = historyPage(turns, params, turn => turn.id, this.historyContext(params.threadId, 'turns'));
    page.data = page.data.map(turn => turnView(turn, params.itemsView ?? 'summary'));
    return page;
  },
  async 'thread/items/list'(params) {
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
    if (!this.meta.owned?.[params.threadId]) throw invalid('Externally created Pi sessions are read-only in Codex Remote. Fork before renaming.');
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
    await this.discover();
    await this.thread(threadId);
    if (this.catalog.get(threadId)?.isSubAgent) throw invalid('Sub-agent threads are read-only in Codex Remote.');
    if (!this.meta.trashed?.[threadId]) await this.archive(threadId);
    for (const map of [this.meta.trashed, this.meta.archives, this.meta.owned, this.meta.parents, this.meta.queues]) if (map) delete map[threadId];
    const pending = this.meta.trashPending?.[threadId];
    if (pending) this.meta.trashPending[threadId] = { ...pending, deleted: true };
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
    if (!this.meta.owned?.[params.threadId]) throw invalid('Externally created Pi sessions are read-only in Codex Remote. Fork before compacting.');
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
    await this.discover();
    await this.thread(threadId);
    if (this.catalog.get(threadId)?.isSubAgent) throw invalid('Sub-agent threads are read-only in Codex Remote.');
    if (this.meta.trashed?.[threadId] || this.meta.trashPending?.[threadId]) return {};
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
    const active = this.active.get(threadId);
    if (this.sessions.hosted) {
      // The running turn may be the terminal's, so Remote only leaves the session; the file moves once no Pi has it open.
      const previous = this.meta.archives[threadId];
      this.meta.archives[threadId] = true;
      (this.meta.trashPending ??= {})[threadId] = { path: record.path };
      try { await this.saveMetadata(); }
      catch (error) {
        delete this.meta.trashPending[threadId];
        this.meta.archives[threadId] = previous;
        throw error;
      }
      if (rpc) {
        await rpc.close();
        this.loaded.delete(threadId);
      }
      if (active) this.finishNotification(active);
      void this.drainTrash();
      return {};
    }
    await this.trash.assertSessionNotOpen(record.path, { ignorePids: rpc?.child?.pid ? [rpc.child.pid] : [] });
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
    return this.moveToTrash(threadId, record);
  },

  async moveToTrash(threadId, record) {
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

  async drainTrash() {
    if (this.draining || this.queueClosing || !Object.keys(this.meta.trashPending ?? {}).length) return;
    this.draining = true;
    try {
      for (const [threadId, pending] of Object.entries(this.meta.trashPending)) {
        if (this.loaded.has(threadId) || this.opening.has(threadId)) continue;
        let releaseMutation;
        try {
          releaseMutation = await this.acquireThreadMutation(threadId);
          if (this.meta.trashPending[threadId] !== pending) continue;
          let header;
          try { ({ header } = await this.history.readHistory(pending.path)); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (header?.id === threadId) await this.trash.assertSessionNotOpen(pending.path);
          delete this.meta.trashPending[threadId];
          try {
            if (header?.id !== threadId) await this.saveMetadata();
            else if (pending.deleted) { await this.trash.trashSession(pending.path); await this.saveMetadata(); }
            else {
              if (!this.catalog.has(threadId)) await this.discover();
              await this.moveToTrash(threadId, { ...this.catalog.get(threadId), path: pending.path });
            }
          } catch (error) {
            this.meta.trashPending[threadId] = pending;
            throw error;
          }
        } catch { /* Still open or unavailable; retried on the next tick. */ }
        finally { releaseMutation?.(); }
      }
    } finally { this.draining = false; }
  },

  async unarchive(threadId) {
    await this.thread(threadId);
    const archived = this.meta.trashed?.[threadId];
    const previous = this.meta.archives[threadId];
    const pending = this.meta.trashPending?.[threadId];
    if (pending) delete this.meta.trashPending[threadId];
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
      if (pending) this.meta.trashPending[threadId] = pending;
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
    const lastItem = thread.turns.findLast(turn => turn.items.length)?.items.at(-1);
    return {
      thread: { ...thread, turns: [] },
      itemsBackwardsCursor: lastItem ? historyCursor(lastItem.id, true, this.historyContext(threadId, 'items')) : null,
      turnsBackwardsCursor: lastTurn ? historyCursor(lastTurn.id, true, this.historyContext(threadId, 'turns')) : null,
    };
  },

  async rewind(threadId, beforeTurnId, emit) {
    if (!this.meta.owned?.[threadId]) throw invalid('External Pi histories are read-only for revert. Fork before editing, or use a session already explicitly taken over by Codex Remote.');
    if (this.active.has(threadId)) throw invalid('Cannot revert an active turn. Stop it and wait for Pi to become idle.');
    if (this.meta.trashed?.[threadId] || this.meta.trashPending?.[threadId]) throw invalid('Session is archived. Unarchive it before editing.');
    await this.discover();
    const record = this.catalog.get(threadId);
    if (!record?.path) throw invalid('Revert requires a persisted Pi session.');
    const wireTurns = await this.turns(threadId);
    if (!wireTurns.some(turn => turn.id === beforeTurnId)) throw invalid('beforeTurnId is not in the active thread history. Refresh the thread before retrying.');
    const cached = this.loaded.get(threadId);
    // One writer: under pi-agents it is the host, which revert joins.
    if (!this.sessions.hosted) await this.trash.assertSessionNotOpen(record.path, { ignorePids: cached?.child?.pid ? [cached.child.pid] : [] });
    const rpc = await this.rpc(threadId);
    if (rpc.state.isStreaming || rpc.state.isCompacting || rpc.state.pendingMessageCount > 0) throw invalid('Wait for Pi to finish active work, compaction, and queued messages before editing.');
    if (!this.sessions.hosted) await this.trash.assertSessionNotOpen(record.path, { ignorePids: rpc.child?.pid ? [rpc.child.pid] : [] });
    const { entries, leafId } = await rpc.request('get_entries');
    const nativeTurns = this.history.projectTurns(entries, { leafId });
    const targetTurn = nativeTurns.find(turn => (this.meta.entries[turn.id]?.turnId ?? turn.id) === beforeTurnId);
    const target = entries.find(entry => entry.id === targetTurn?.id);
    if (target?.type !== 'message' || target.message.role !== 'user') throw invalid('Revert boundary is not an active user turn. Refresh the thread before retrying.');
    const { commands } = await rpc.request('get_commands');
    if (!commands.some(command => command.name === revertCommand && command.source === 'extension')) throw invalid('The Codex Remote history command is unavailable. Reload the Codex Remote RPC extension before editing.');
    const operationId = randomUUID();
    let commandError;
    const unsubscribe = rpc.onEvent(event => {
      if (event.type === 'extension_error' && event.extensionPath === `command:${revertCommand}`) commandError = event.error;
    });
    try {
      const result = await rpc.request('prompt', { message: `/${revertCommand} ${JSON.stringify({ operationId, threadId, expectedLeafId: leafId, targetId: target.id })}` });
      if (commandError) throw new Error(commandError);
      if (result?.disposition !== 'handled') throw new Error('Pi did not handle the Codex Remote history command.');
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
      throw new Error(`History revert was not confirmed: ${error.message} Reopen the thread to inspect its saved branch before retrying.`, { cause: error });
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
        if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Codex Remote can fork it.');
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
    if (params.disabledPluginIds != null && (!Array.isArray(params.disabledPluginIds) || params.disabledPluginIds.length)) throw invalid('disabledPluginIds overrides are not supported by Codex Remote.');
    if (params.multiAgentMode != null && params.multiAgentMode !== 'explicitRequestOnly') throw invalid('Proactive multi-agent mode is not supported by Codex Remote.');
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
    if (this.meta.trashed?.[id] || this.meta.trashPending?.[id]) throw invalid('Session is archived. Unarchive it before sending tasks.');
    await this.discover();
    const record = this.catalog.get(id);
    if (!record) throw invalid('Thread not found.');
    if (record.isSubAgent) throw invalid('Sub-agent threads are read-only in Codex Remote.');
    workspaceSettings(params, record.cwd);
    const { header, entries } = await this.history.readHistory(record.path);
    if (header.version !== 3) throw invalid('Legacy Pi history requires a local migration before Codex Remote can resume it.');
    if (header.id !== id) throw invalid('Session history identity changed. Refresh the list before sending tasks.');
    this.inputEligibility.delete(id);
    const hosted = this.sessions.hosted;
    if (!hosted) await this.trash.assertSessionNotOpen(record.path);
    const probe = await this.settingsProbe(record.cwd);
    const saved = sessionSettings(entries);
    const identity = params.model ? modelIdentity(params.model) : saved.model ?? probe.state.model;
    const { models } = await probe.request('get_available_models');
    const selected = models.find(model => model.provider === identity.provider && model.id === (identity.modelId ?? identity.id));
    if (!selected) throw invalid('Requested model is unavailable in Pi. Choose an available model before sending.');
    providerSettings(params, { state: { model: selected } });
    if (effort != null && !supportedEfforts(selected).includes(effort)) throw invalid('Requested reasoning effort is unavailable for the selected Pi model.');
    if (prompt.images?.length && !selected.input?.includes('image')) throw invalid('The selected Pi model does not support image input.');
    // Recheck after the probe; acquisition uses the original path, never a fork.
    if (!hosted) await this.trash.assertSessionNotOpen(record.path);
    const latest = await this.history.readHistory(record.path);
    if (latest.header.version !== 3 || latest.header.id !== id) throw invalid('Session history identity changed. Refresh the list before sending tasks.');
    let rpc;
    let ownershipAttempted = false;
    let running = false;
    try {
      rpc = await this.openSaved(record);
      if (rpc.id !== id || await historyPath(rpc.sessionFile) !== await historyPath(record.path)) throw invalid('Pi opened a different session. Refresh the list before retrying.');
      // A joined host may be running a turn started elsewhere; Remote follows it as an external turn.
      running = hosted && rpc.state.isStreaming;
      if (!running && (rpc.state.isStreaming || rpc.state.isCompacting)) throw invalid('Pi session is already running. Wait for it to finish before retrying.');
      if (!hosted) await this.trash.assertSessionNotOpen(record.path, { ignorePids: rpc.child?.pid ? [rpc.child.pid] : [] });
      if (params.model && !running) await rpc.request('set_model', modelIdentity(params.model));
      if (!running) await applyEffort(rpc, effort);
      (this.meta.owned ??= {})[id] = true;
      ownershipAttempted = true;
      await this.saveMetadata();
      this.register(rpc);
      if (running) await this.joinExternalTurn(rpc);
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
    if (running) throw invalid('Pi is running a turn started elsewhere. Steer it or wait for it to finish.');
    return rpc;
  },
};
