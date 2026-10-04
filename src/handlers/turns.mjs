import { randomUUID } from 'node:crypto';
import { commandOutputDelta, toolItem, updateToolItem } from '../items.mjs';
import { seconds, invalid, applyEffort, workspaceSettings, executionSettings, providerSettings, modelIdentity, inputPrompt, agentItem, textPhase } from '../codex.mjs';
import { turnView } from '../pages.mjs';

export const turnsHandlers = {
  async 'turn/start'(params, emit) { return { turn: await this.startTurn(params, emit) }; },
  async 'turn/steer'(params, emit) {
    const active = this.active.get(params.threadId);
    if (!active || active.kind || active.interrupted || active.finishing || active.turn.id !== params.expectedTurnId) throw invalid('The requested turn is not active or is being interrupted.');
    this.subscribe(params.threadId, emit);
    const prompt = inputPrompt(params.input, this.attachments, emit);
    if (prompt.images?.length && !active.rpc.state.model?.input?.includes('image')) throw invalid('The selected Pi model does not support image input.');
    const user = { clientId: params.clientUserMessageId ?? null };
    const steering = active.inputs.then(async () => {
      if (!await active.acceptance) throw invalid('The initial prompt was not accepted.');
      if (active.interrupted) throw invalid('The turn is being interrupted.');
      active.users.push(user);
      try {
        const response = await active.rpc.request('steer', prompt);
        if (response?.disposition === 'handled' && active.imageRejection) {
          const message = active.imageRejection;
          active.imageRejection = undefined;
          throw invalid(message);
        }
        if (response?.disposition === 'queued') {
          await active.rpc.refresh();
          if (!active.rpc.state.isStreaming && active.rpc.state.pendingMessageCount > 0 && !active.interrupted) {
            await active.rpc.request('clear_queue');
            const message = 'Pi settled before steering input could be consumed. Pending input was removed; send it as a new turn.';
            active.error = active.error ? `${active.error} ${message}` : message;
            throw invalid(message);
          }
        }
        if (response?.disposition === 'handled') active.users.splice(active.users.indexOf(user), 1);
      } catch (error) {
        active.users.splice(active.users.indexOf(user), 1);
        throw error;
      }
    });
    active.inputs = steering.catch(() => {});
    await steering;
    return { turnId: active.turn.id };
  },
  async 'thread/shellCommand'(params, emit) {
    const { threadId, command } = params;
    if (typeof command !== 'string' || !command.trim()) throw invalid('command must be a non-empty string.');
    const timeoutMs = params.timeoutMs ?? 3_600_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw invalid('timeoutMs must be a non-negative integer.');
    const rpc = this.meta.owned?.[threadId] ? await this.rpc(threadId) : await this.takeover(params, null, {});
    const joined = this.active.get(threadId);
    if (joined?.kind) throw invalid('Wait for the current compaction or shell command to finish.');
    this.subscribe(threadId, emit);
    const active = joined ?? this.startOperationTurn(rpc, 'shell');
    const item = this.startItem(active, {
      type: 'commandExecution', id: randomUUID(), command, cwd: rpc.cwd, commandActions: [], aggregatedOutput: null,
      durationMs: null, exitCode: null, pluginId: null, processId: null, scriptPath: null, source: 'userShell', status: 'inProgress',
    });
    (active.shells ??= []).push(item);
    const running = this.runShell(active, item, timeoutMs, !joined);
    active.inputs = active.inputs.then(() => running);
    if (!joined) void running.then(() => this.finish(active)).catch(error => {
      active.error = error.message;
      this.finishNotification(active);
    });
    return {};
  },
  async 'turn/interrupt'(params) {
    const active = this.active.get(params.threadId);
    if (!active || active.turn.id !== params.turnId) throw invalid('The requested turn is not active.');
    await this.queuePause(params.threadId);
    active.interrupted = true;
    active.stopping ||= (async () => {
      await active.acceptance;
      await active.inputs;
      await active.rpc.request('clear_queue');
      await active.rpc.request('abort_bash');
      await active.rpc.request('abort');
    })();
    await active.stopping;
    return {};
  },
};

export const turnsMethods = {
  async startTurn(params, emit, { turnId = randomUUID() } = {}) {
    const effort = executionSettings(params);
    const prompt = inputPrompt(params.input, this.attachments, emit);
    if (params.model) modelIdentity(params.model);
    if (this.active.has(params.threadId)) throw invalid('Thread is already running. Use turn/steer.');
    const external = !this.meta.owned?.[params.threadId];
    const rpc = external ? await this.takeover(params, effort, prompt) : await this.rpc(params.threadId);
    workspaceSettings(params, rpc.cwd);
    providerSettings(params, rpc);
    if (this.active.has(params.threadId)) throw invalid('Thread is already running. Use turn/steer.');
    if (!external) {
      if (params.model) await rpc.request('set_model', modelIdentity(params.model));
      await applyEffort(rpc, effort);
    }
    if (prompt.images?.length && !rpc.state.model?.input?.includes('image')) throw invalid('The selected Pi model does not support image input.');
    if (emit) this.subscribe(params.threadId, emit);
    const active = { rpc, turn: { id: turnId, items: [], status: 'inProgress', error: null, startedAt: seconds(Date.now()), completedAt: null, durationMs: null, itemsView: 'full' }, messageIndex: -1, blocks: new Map(), tools: new Map(), messages: [], users: [{ clientId: params.clientUserMessageId ?? null }], completed: new Set(), startedAt: Date.now() };
    active.acceptance = new Promise(resolve => { active.accept = resolve; });
    active.inputs = Promise.resolve();
    this.active.set(params.threadId, active);
    try {
      const { entries } = await rpc.request('get_entries');
      active.priorEntries = new Set(entries.map(entry => entry.id));
      this.notify(rpc.id, 'thread/status/changed', { threadId: rpc.id, status: { type: 'active', activeFlags: [] } });
      this.notify(rpc.id, 'turn/started', { threadId: rpc.id, turn: { ...active.turn, items: [], itemsView: 'notLoaded' } });
      const response = active.interrupted ? { disposition: 'handled' } : await rpc.request('prompt', prompt);
      if (response?.disposition === 'handled' && active.imageRejection) throw invalid(active.imageRejection);
      active.accept(true);
      if (response?.disposition === 'handled') await this.finish(active);
      else if (!active.finished) {
        const { entries } = await rpc.request('get_entries');
        this.recordUsers(active, entries);
        await this.saveMetadata();
      }
      return structuredClone(turnView(active.turn, 'notLoaded'));
    } catch (error) {
      active.accept(false);
      active.error = error.message;
      if (rpc.failure) { await rpc.close(); this.finishNotification(active); }
      else if (active.priorEntries) await this.finish(active);
      else this.finishNotification(active);
      throw error;
    }
  },

  reconcileEntries(active, entries) {
    if (!active.priorEntries) return false;
    let changed = false;
    const map = (id, value) => {
      if (JSON.stringify(this.meta.entries[id]) === JSON.stringify(value)) return;
      this.meta.entries[id] = value;
      changed = true;
    };
    let userIndex = 0;
    let messageIndex = 0;
    let shellIndex = 0;
    for (const entry of entries) {
      if (active.priorEntries.has(entry.id) || entry.type !== 'message') continue;
      if (entry.message.role === 'user') {
        const user = active.users[userIndex] ??= { clientId: null };
        userIndex++;
        user.itemId ??= entry.id;
        map(entry.id, { turnId: active.turn.id, clientId: user.clientId, itemId: user.itemId });
      }
      else if (entry.message.role === 'assistant') {
        for (const [index, item] of active.messages[messageIndex++] ?? []) map(`${entry.id}:${index}`, { itemId: item.id });
      } else if (entry.message.role === 'bashExecution') {
        const shell = active.shells?.[shellIndex++];
        // A shell command run while idle owns its turn; one run during a turn joins it.
        if (shell) map(entry.id, active.kind === 'shell' ? { itemId: shell.id, turnId: active.turn.id } : { itemId: shell.id });
      }
    }
    return changed;
  },

  recordUsers(active, entries) {
    this.reconcileEntries(active, entries);
    for (const entry of entries) {
      if (active.priorEntries?.has(entry.id) || entry.type !== 'message' || entry.message.role !== 'user') continue;
      const mapping = this.meta.entries[entry.id];
      if (active.completed.has(mapping.itemId)) continue;
      const item = this.history.projectTurns([entry])[0].items[0];
      item.id = mapping.itemId;
      item.clientId = mapping.clientId;
      this.completeItem(active, this.startItem(active, item));
    }
  },

  startItem(active, item) {
    active.turn.items.push(item);
    this.notify(active.rpc.id, 'item/started', { threadId: active.rpc.id, turnId: active.turn.id, item, startedAtMs: Date.now() });
    return item;
  },

  completeItem(active, item) {
    if (active.completed.has(item.id)) return;
    active.completed.add(item.id);
    this.notify(active.rpc.id, 'item/completed', { threadId: active.rpc.id, turnId: active.turn.id, item, completedAtMs: Date.now() });
  },

  startOperationTurn(rpc, kind) {
    const active = {
      kind, rpc,
      turn: { id: randomUUID(), items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: seconds(Date.now()), completedAt: null, durationMs: null },
      tools: new Map(), blocks: new Map(), messages: [], users: [], completed: new Set(),
      startedAt: Date.now(), acceptance: Promise.resolve(true), inputs: Promise.resolve(),
    };
    this.active.set(rpc.id, active);
    this.notify(rpc.id, 'thread/status/changed', { threadId: rpc.id, status: { type: 'active', activeFlags: [] } });
    this.notify(rpc.id, 'turn/started', { threadId: rpc.id, turn: { ...active.turn, items: [], itemsView: 'notLoaded' } });
    return active;
  },

  // Pi RPC `bash` is the `!command` path: it runs user_bash hooks and records the output in context.
  async runShell(active, item, timeoutMs, ownsTurn) {
    const { rpc } = active;
    const id = `shell-${item.id}`;
    const started = Date.now();
    if (ownsTurn) active.priorEntries = new Set((await rpc.request('get_entries')).entries.map(entry => entry.id));
    const unsubscribe = rpc.onEvent(event => {
      if (event.type !== 'bash_execution_update' || event.id !== id) return;
      item.aggregatedOutput = (item.aggregatedOutput ?? '') + event.delta;
      this.notify(rpc.id, 'item/commandExecution/outputDelta', { threadId: rpc.id, turnId: active.turn.id, itemId: item.id, delta: event.delta });
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void rpc.request('abort_bash').catch(() => {}); }, timeoutMs);
    try {
      const result = await rpc.request('bash', { id, command: item.command }, { timeoutMs: timeoutMs + 30_000 });
      item.aggregatedOutput = result.output;
      item.exitCode = timedOut || result.cancelled ? -1 : result.exitCode;
      item.status = item.exitCode === 0 ? 'completed' : 'failed';
    } catch (error) {
      item.exitCode = -1;
      item.status = 'failed';
      if (ownsTurn) active.error = error.message;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      item.durationMs = Date.now() - started;
    }
    this.completeItem(active, item);
  },

  mapCompaction(active, item, result, entries) {
    if (Object.values(this.meta.entries).some(value => value.itemId === item.id)) return false;
    const entry = entries.find(entry => entry.type === 'compaction' && !active.priorEntries?.has(entry.id) && !this.meta.entries[entry.id]?.itemId && entry.summary === result.summary && entry.firstKeptEntryId === result.firstKeptEntryId);
    if (!entry) return false;
    this.meta.entries[entry.id] = {
      itemId: item.id, turnId: active.turn.id,
      ...(active.kind === 'compaction' ? { compactionTurn: true } : {}),
    };
    return true;
  },

  async persistCompaction(active, item, result) {
    const { entries } = await active.rpc.request('get_entries');
    this.mapCompaction(active, item, result, entries);
    if (!Object.values(this.meta.entries).some(value => value.itemId === item.id)) throw new Error('Completed Pi compaction has no new persisted entry.');
    await this.saveMetadata();
  },

  event(rpc, event) {
    const active = this.active.get(rpc.id);
    if (event.type === 'extension_ui_request' && event.method === 'notify' && event.notifyType === 'error' && event.message?.startsWith('Pi Remote rejected image:')) {
      if (active) active.imageRejection = event.message;
      return;
    }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      void rpc.send({ type: 'extension_ui_response', id: event.id, cancelled: true }).catch(error => {
        if (active) { active.error = error.message; this.finishNotification(active); }
      });
      if (active) this.notify(rpc.id, 'error', { threadId: rpc.id, turnId: active.turn.id, willRetry: false, error: { message: `Pi dialog cancelled: ${event.title ?? event.method}. Remote dialog approvals are not supported.`, codexErrorInfo: null, additionalDetails: null } });
      return;
    }
    if (event.type === 'process_exit') this.loaded.delete(rpc.id);
    if (event.type === 'compaction_start') {
      const operation = active ?? this.startOperationTurn(rpc, 'compaction');
      operation.compactionItem = this.startItem(operation, { type: 'contextCompaction', id: randomUUID() });
      return;
    }
    if (!active) return;
    if (event.type === 'compaction_end') {
      const item = active.compactionItem;
      active.compactionItem = undefined;
      if (event.result && !event.aborted && !event.errorMessage && item) {
        (active.compactionMappings ??= []).push({ item, result: event.result });
        this.completeItem(active, item);
        active.inputs = (active.inputs ?? Promise.resolve()).then(() => this.persistCompaction(active, item, event.result));
        // Keep persistence failure observable without leaving a rejected background promise.
        active.inputs = active.inputs.catch(error => {
          active.error = error.message;
          this.notify(rpc.id, 'error', { threadId: rpc.id, turnId: active.turn.id, willRetry: false, error: { message: error.message, codexErrorInfo: null, additionalDetails: null } });
        });
      } else {
        if (active.kind === 'compaction') {
          active.interrupted ||= event.aborted;
          active.error = event.errorMessage ?? (event.aborted ? undefined : 'Pi compaction did not produce a result.');
        }
        if (event.errorMessage) {
          active.compactionErrorReported = true;
          this.notify(rpc.id, 'error', { threadId: rpc.id, turnId: active.turn.id, willRetry: Boolean(event.willRetry), error: { message: event.errorMessage, codexErrorInfo: null, additionalDetails: null } });
        }
      }
      if (active.kind === 'compaction') void this.finish(active).catch(error => {
        active.error = error.message;
        this.finishNotification(active);
      });
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'user') {
      const index = active.observedUsers ?? 0;
      active.observedUsers = index + 1;
      const user = active.users[index] ??= { clientId: null };
      user.itemId ??= randomUUID();
      if (active.completed.has(user.itemId)) return;
      const item = this.history.projectTurns([{ type: 'message', id: user.itemId, timestamp: new Date().toISOString(), message: event.message }])[0].items[0];
      item.clientId = user.clientId;
      this.completeItem(active, this.startItem(active, item));
    } else if (event.type === 'message_start' && event.message.role === 'assistant') {
      active.messageIndex++;
      active.blocks = new Map();
    } else if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      const thinking = update.type.startsWith('thinking_');
      if (!thinking && !update.type.startsWith('text_')) return;
      let item = active.blocks.get(update.contentIndex);
      if (!item) {
        const id = `${active.turn.id}:assistant:${Math.max(0, active.messageIndex)}:${update.contentIndex}`;
        item = this.startItem(active, thinking ? { type: 'reasoning', id, content: [''], summary: [] } : agentItem(id, '', textPhase(update.partial?.content?.[update.contentIndex])));
        active.blocks.set(update.contentIndex, item);
      }
      if (!thinking) item.phase = textPhase(update.partial?.content?.[update.contentIndex]);
      if (update.type.endsWith('_delta')) {
        if (thinking) item.content[0] += update.delta;
        else item.text += update.delta;
        this.notify(rpc.id, thinking ? 'item/reasoning/textDelta' : 'item/agentMessage/delta', { threadId: rpc.id, turnId: active.turn.id, itemId: item.id, delta: update.delta, ...(thinking ? { contentIndex: 0 } : {}) });
      } else if (update.type.endsWith('_end')) {
        if (thinking) item.content[0] = update.content;
        else item.text = update.content;
      }
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message;
      for (const [index, content] of (message.content ?? []).entries()) {
        if (content.type !== 'text' && content.type !== 'thinking') continue;
        let item = active.blocks.get(index);
        if (!item) {
          const id = `${active.turn.id}:assistant:${Math.max(0, active.messageIndex)}:${index}`;
          item = this.startItem(active, content.type === 'text' ? agentItem(id, '', textPhase(content)) : { type: 'reasoning', id, content: [''], summary: [] });
          active.blocks.set(index, item);
        }
        if (content.type === 'text') { item.text = content.text; item.phase = textPhase(content); }
        else item.content[0] = content.thinking;
        this.completeItem(active, item);
      }
      active.messages.push(new Map(active.blocks));
      active.error = message.stopReason === 'error' ? message.errorMessage ?? 'Pi model request failed' : undefined;
      active.interrupted ||= message.stopReason === 'aborted';
    } else if (event.type === 'tool_execution_start') {
      const item = toolItem(event.toolCallId, event.toolName, event.args, { cwd: rpc.cwd, senderThreadId: rpc.id });
      // These cards need the result to distinguish images, patches and real tool identities.
      const collab = event.toolName === 'agent' && ['spawn', 'send', 'abort', 'wait', 'list'].includes(event.args?.action);
      if (!collab && !['read', 'edit', 'write'].includes(event.toolName) && !event.toolName.startsWith('mcp__')) this.startItem(active, item);
      active.tools.set(event.toolCallId, item);
      (active.toolInputs ??= new Map()).set(item.id, { name: event.toolName, args: event.args });
      (active.toolStartedAt ??= new Map()).set(item.id, Date.now());
    } else if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const item = active.tools.get(event.toolCallId);
      if (!item) return;
      const complete = event.type === 'tool_execution_end';
      const previousOutput = item.aggregatedOutput ?? '';
      updateToolItem(item, complete ? event.result : event.partialResult, {
        complete, isError: event.isError, cwd: rpc.cwd, senderThreadId: rpc.id, ...active.toolInputs?.get(item.id),
        durationMs: Date.now() - (active.toolStartedAt?.get(item.id) ?? Date.now()),
      });
      if (complete && !active.turn.items.some(existing => existing.id === item.id)) this.startItem(active, item);
      if (item.type === 'commandExecution' && active.turn.items.some(existing => existing.id === item.id)) {
        const delta = commandOutputDelta(previousOutput, item.aggregatedOutput);
        if (delta) this.notify(rpc.id, 'item/commandExecution/outputDelta', { threadId: rpc.id, turnId: active.turn.id, itemId: item.id, delta });
      }
      if (complete) {
        active.toolStartedAt?.delete(item.id);
        active.toolInputs?.delete(item.id);
        this.completeItem(active, item);
      }
    } else if (event.type === 'agent_settled') {
      void this.finish(active).catch(error => {
        active.error = error.message;
        this.finishNotification(active);
      });
    } else if (event.type === 'process_exit') {
      active.error ||= 'Pi process exited before completing the turn.';
      for (const item of active.tools.values()) {
        if (active.completed.has(item.id)) continue;
        item.status = 'failed';
        if (item.type === 'dynamicToolCall') item.success = false;
        if (item.type !== 'fileChange') item.durationMs = Date.now() - (active.toolStartedAt?.get(item.id) ?? Date.now());
        if (!active.turn.items.some(existing => existing.id === item.id)) this.startItem(active, item);
        this.completeItem(active, item);
      }
      this.finishNotification(active);
    }
  },

  async finish(active) {
    if (active.finished) return;
    if (active.finishing) return active.finishing;
    active.finishing = (async () => {
      await active.acceptance;
      await active.inputs;
      await active.stopping;
      await active.rpc.refresh();
      if (active.rpc.state.isStreaming) return;
      if (active.rpc.state.pendingMessageCount > 0) {
        await active.rpc.request('clear_queue');
        const message = 'Pi settled with unconsumed steering input. Pending input was removed; send it as a new turn.';
        active.error = active.error ? `${active.error} ${message}` : message;
      }
      const { entries } = await active.rpc.request('get_entries');
      this.recordUsers(active, entries);
      await this.saveMetadata();
      this.finishNotification(active);
    })().finally(() => { active.finishing = undefined; });
    return active.finishing;
  },

  finishNotification(active) {
    if (active.finished) return;
    active.finished = true;
    active.turn.status = active.interrupted ? 'interrupted' : active.error ? 'failed' : 'completed';
    active.turn.error = active.turn.status === 'failed' ? { message: active.error, additionalDetails: null, codexErrorInfo: null } : null;
    active.turn.completedAt = seconds(Date.now());
    active.turn.durationMs = Date.now() - active.startedAt;
    const record = this.catalog.get(active.rpc.id);
    if (record) record.modified = new Date();
    this.active.delete(active.rpc.id);
    const lastMessage = active.turn.items.findLast(item => item.type === 'agentMessage');
    const turn = { ...active.turn, items: lastMessage ? [lastMessage] : [], itemsView: lastMessage ? 'summary' : 'notLoaded' };
    this.notify(active.rpc.id, 'turn/completed', { threadId: active.rpc.id, turn });
    this.notify(active.rpc.id, 'thread/status/changed', { threadId: active.rpc.id, status: { type: this.loaded.has(active.rpc.id) ? 'idle' : 'notLoaded' } });
    this.queueFinished(active);
  },
};
