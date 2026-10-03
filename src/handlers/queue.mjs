import { randomUUID } from 'node:crypto';
import { invalid, inputPrompt } from '../codex.mjs';

const emptyQueue = () => ({ items: [], paused: false });
const uncertain = intent => invalid(`Queued submission ${intent.queuedSubmissionId} has an uncertain dispatch outcome. Inspect thread history before deleting it with thread/queue/delete and recreating it if needed; it will not be retried automatically.`);

function durableInput(input) {
  if (!Array.isArray(input) || input.some(part => !['text', 'image'].includes(part?.type))) {
    throw invalid('Queued input supports text and base64 data URL images only. Temporary uploads, local paths, audio, skills and mentions cannot be queued.');
  }
  inputPrompt(input);
  if (JSON.stringify(input).length > 32 * 1024 * 1024) throw invalid('Queued input exceeds the 32 MiB limit.');
  return structuredClone(input);
}

export const queueHandlers = {
  async 'thread/queue/add'(params, emit) {
    const { threadId, clientUserMessageId } = params;
    const queue = await this.requireQueue(threadId, emit);
    if (typeof clientUserMessageId !== 'string' || !clientUserMessageId) throw invalid('clientUserMessageId must be a non-empty string.');
    if (queue.items.length >= 100) throw invalid('Queue cannot contain more than 100 submissions.');
    const queuedSubmission = { id: randomUUID(), clientUserMessageId, input: durableInput(params.input) };
    await this.saveQueue(threadId, { ...queue, items: [...queue.items, queuedSubmission] });
    this.queueChanged(threadId);
    this.scheduleQueue(threadId);
    return { queuedSubmission: structuredClone(queuedSubmission) };
  },

  async 'thread/queue/list'(params, emit) {
    const queue = await this.requireQueue(params.threadId, emit);
    if (params.cursor != null && (typeof params.cursor !== 'string' || !/^\d+$/.test(params.cursor))) throw invalid('Invalid queue pagination cursor.');
    const offset = Number(params.cursor ?? 0);
    if (!Number.isSafeInteger(offset)) throw invalid('Invalid queue pagination cursor.');
    if (params.limit != null && (!Number.isSafeInteger(params.limit) || params.limit < 0)) throw invalid('limit must be a non-negative integer.');
    const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
    return { data: structuredClone(queue.items.slice(offset, offset + limit)), nextCursor: offset + limit < queue.items.length ? String(offset + limit) : null };
  },

  async 'thread/queue/update'(params, emit) {
    const { threadId, queuedSubmissionId } = params;
    const queue = await this.requireQueue(threadId, emit);
    if (queue.intent) throw uncertain(queue.intent);
    const index = queue.items.findIndex(item => item.id === queuedSubmissionId);
    if (index < 0) throw invalid(`Queued submission not found: ${queuedSubmissionId}`);
    const queuedSubmission = { ...queue.items[index], input: durableInput(params.input) };
    const items = queue.items.slice();
    items[index] = queuedSubmission;
    await this.saveQueue(threadId, { ...queue, items });
    this.queueChanged(threadId);
    return { queuedSubmission: structuredClone(queuedSubmission) };
  },

  async 'thread/queue/delete'(params, emit) {
    const { threadId, queuedSubmissionId } = params;
    const queue = await this.requireQueue(threadId, emit);
    const items = queue.items.filter(item => item.id !== queuedSubmissionId);
    if (items.length === queue.items.length) return { deleted: false };
    const next = { ...queue, items };
    if (next.intent?.queuedSubmissionId === queuedSubmissionId) delete next.intent;
    await this.saveQueue(threadId, next);
    this.queueChanged(threadId);
    return { deleted: true };
  },

  async 'thread/queue/reorder'(params, emit) {
    const { threadId, queuedSubmissionIds } = params;
    const queue = await this.requireQueue(threadId, emit);
    if (queue.intent) throw uncertain(queue.intent);
    const byId = new Map(queue.items.map(item => [item.id, item]));
    if (!Array.isArray(queuedSubmissionIds) || queuedSubmissionIds.length !== byId.size || new Set(queuedSubmissionIds).size !== byId.size || queuedSubmissionIds.some(id => !byId.has(id))) {
      throw invalid('Queue reorder must include every queued submission exactly once.');
    }
    await this.saveQueue(threadId, { ...queue, items: queuedSubmissionIds.map(id => byId.get(id)) });
    this.queueChanged(threadId);
    return {};
  },

  async 'thread/queue/start'(params, emit) {
    await this.requireQueue(params.threadId, emit);
    return { turn: await this.dispatchQueue(params.threadId, params.queuedSubmissionId, emit) };
  },
};

export const queueMethods = {
  async requireQueue(threadId, emit) {
    if (typeof threadId !== 'string' || !threadId) throw invalid('threadId must be a non-empty string.');
    if (!this.catalog.has(threadId)) await this.discover();
    const record = this.catalog.get(threadId);
    if (!record) throw invalid(`Thread not found: ${threadId}`);
    if (this.meta.trashed?.[threadId] || this.meta.archives?.[threadId]) throw invalid('Unarchive the thread before using its queue.');
    if (!record.path) throw invalid('Ephemeral threads do not support durable queues.');
    if (record.isSubAgent) throw invalid('Sub-agent threads do not support direct queued input.');
    if (emit) this.subscribe(threadId, emit);
    return this.meta.queues?.[threadId] ?? emptyQueue();
  },

  async saveQueue(threadId, queue) {
    this.meta.queues ??= {};
    const previous = this.meta.queues[threadId];
    this.meta.queues[threadId] = queue;
    try { await this.saveMetadata(); }
    catch (error) {
      if (previous) this.meta.queues[threadId] = previous;
      else delete this.meta.queues[threadId];
      throw error;
    }
  },

  queueChanged(threadId) {
    this.notify(threadId, 'thread/queue/changed', { threadId });
  },

  async queuePause(threadId) {
    const queue = this.meta.queues?.[threadId] ?? emptyQueue();
    if (!queue.paused) await this.saveQueue(threadId, { ...queue, paused: true });
  },

  async queueResume(threadId) {
    const queue = this.meta.queues?.[threadId];
    if (queue?.paused) await this.saveQueue(threadId, { ...queue, paused: false });
    this.scheduleQueue(threadId);
  },

  queueFinished(active) {
    this.scheduleQueue(active.rpc.id, active.interrupted || Boolean(active.error));
  },

  // Automatic dispatch shares handle()'s per-thread mutation chain.
  scheduleQueue(threadId, pause = false) {
    if (this.queueClosing || !this.meta.queues?.[threadId]) return;
    void (async () => {
      let releaseMutation;
      try {
        releaseMutation = await this.acquireThreadMutation(threadId);
        if (this.queueClosing) return;
        if (pause) { await this.queuePause(threadId); return; }
        const queue = this.meta.queues?.[threadId];
        if (!queue?.items.length || queue.paused || this.active.has(threadId) || !this.loaded.has(threadId) || !this.meta.owned?.[threadId] || this.meta.trashed?.[threadId] || this.meta.archives?.[threadId]) return;
        await this.dispatchQueue(threadId);
      } catch (error) {
        this.notify(threadId, 'error', { threadId, turnId: this.meta.queues?.[threadId]?.intent?.turnId ?? '', willRetry: false,
          error: { message: error.message, additionalDetails: null, codexErrorInfo: null } });
      } finally {
        releaseMutation?.();
      }
    })();
  },

  async dispatchQueue(threadId, queuedSubmissionId, emit) {
    const queue = await this.requireQueue(threadId, emit);
    if (queue.intent) throw uncertain(queue.intent);
    const rpc = this.loaded.get(threadId);
    if (!rpc || !this.meta.owned?.[threadId]) throw invalid('Resume the thread before starting a queued submission.');
    if (this.queueClosing) throw invalid('Remote is shutting down.');
    await rpc.refresh();
    if (this.queueClosing) throw invalid('Remote is shutting down.');
    if (this.active.has(threadId) || rpc.state.isStreaming || rpc.state.isCompacting || rpc.state.pendingMessageCount) throw invalid('Thread already has an active or pending turn.');
    const item = queue.items.find(value => queuedSubmissionId == null || value.id === queuedSubmissionId);
    if (!item) throw invalid(queuedSubmissionId == null ? 'Queue is empty.' : `Queued submission not found: ${queuedSubmissionId}`);
    const prompt = inputPrompt(item.input);
    if (prompt.images?.length && !rpc.state.model?.input?.includes('image')) throw invalid('The selected Pi model does not support image input.');
    const intent = { queuedSubmissionId: item.id, turnId: randomUUID() };
    await this.saveQueue(threadId, { ...queue, paused: false, intent });
    try {
      if (this.queueClosing) throw invalid('Remote is shutting down.');
      // No client-specific attachment cache is involved: every input is self-contained.
      const turn = await this.startTurn({ threadId, input: item.input, clientUserMessageId: item.clientUserMessageId }, emit, { turnId: intent.turnId });
      await this.saveQueue(threadId, { items: queue.items.filter(value => value.id !== item.id), paused: false });
      this.queueChanged(threadId);
      return turn;
    } catch (error) {
      // A failed prompt response, process exit or metadata write cannot prove non-execution.
      throw invalid(`${uncertain(intent).message} Cause: ${error.message}`);
    }
  },
};
