import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

async function sessionPath(file) {
  try { return { path: await realpath(file), exists: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let parent = dirname(resolve(file));
  try { parent = await realpath(parent); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { path: resolve(parent, basename(file)), exists: false };
}

export class RpcSession {
  constructor(child, { cwd, ephemeral = false, requestTimeoutMs, shutdownTimeoutMs, onState, onClose }) {
    this.child = child;
    this.cwd = cwd;
    this.ephemeral = ephemeral;
    this.state = {};
    this.initializing = true;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.onState = onState;
    this.stderr = '';
    let fragments = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      let start = 0;
      let index;
      while ((index = chunk.indexOf('\n', start)) !== -1) {
        fragments.push(chunk.slice(start, index));
        const line = fragments.join('').replace(/\r$/, '');
        fragments = [];
        start = index + 1;
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.fail(new Error(`Invalid Pi RPC output: ${error.message}`)); child.kill('SIGTERM'); }
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    this.exited = new Promise(resolveExit => child.once('close', (code, signal) => {
      this.fail(new Error(`Pi RPC exited (${signal || code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
      onClose(this);
      for (const listener of this.listeners) listener({ type: 'process_exit', code, signal, error: this.failure.message });
      this.listeners.clear();
      resolveExit();
    }));
  }

  get id() { return this.state.sessionId; }
  get sessionFile() { return this.state.sessionFile; }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(record) {
    if ((this.initializing || !this.listeners.size) && record.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(record.method)) {
      this.startupDialog = record;
      const title = String(record.title ?? record.method).replace(/\s+/g, ' ').trim();
      const boundedTitle = title.length > 240 ? `${title.slice(0, 240)}…` : title;
      this.startupError = new Error(`Pi RPC ${this.initializing ? 'startup' : 'probe'} requires local user interaction (${record.method}) in workspace ${JSON.stringify(this.cwd)}: ${JSON.stringify(boundedTitle)}; it was cancelled without approval. Open Pi locally in this workspace to review and authorize the request. For project trust, save a persistent decision before retrying; a one-run --approve is not inherited by Remote.`);
      this.send({ type: 'extension_ui_response', id: record.id, cancelled: true })
        .then(() => this.fail(this.startupError), error => this.fail(error));
      return;
    }
    if (record.type === 'response') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success) pending.resolve(record.data);
      else pending.reject(new Error(record.error || `Pi RPC ${record.command} failed`));
      return;
    }
    if (record.type === 'agent_start') this.state.isStreaming = true;
    if (record.type === 'agent_settled') this.state.isStreaming = false;
    if (record.type === 'compaction_start') this.state.isCompacting = true;
    if (record.type === 'compaction_end') this.state.isCompacting = false;
    if (record.type === 'session_info_changed') this.state.sessionName = record.name;
    if (record.type === 'thinking_level_changed') this.state.thinkingLevel = record.level;
    for (const listener of this.listeners) listener(record);
  }

  fail(error) {
    this.failure ||= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
  }

  send(record) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error('Pi RPC session is closing'));
    return new Promise((resolveWrite, reject) => {
      this.child.stdin.write(`${JSON.stringify(record)}\n`, error => {
        if (error) { this.fail(error); reject(error); }
        else resolveWrite();
      });
    });
  }

  async request(type, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error('Pi RPC session is closing');
    const id = params.id ?? `remote-${++this.nextId}`;
    const data = await new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Pi RPC ${type} timed out; its action may already have executed`));
        void this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.send({ ...params, id, type }).catch(error => this.fail(error));
    });
    if (type === 'get_state') {
      this.state = data;
      await this.onState(this);
    } else if (['fork', 'clone', 'switch_session', 'new_session', 'set_model', 'set_thinking_level', 'set_session_name'].includes(type) && !data?.cancelled) {
      await this.refresh();
    }
    return data;
  }

  refresh() { return this.request('get_state'); }

  close() {
    this.closing ||= this.stop();
    return this.closing;
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    this.fail(new Error('Pi RPC session closed'));
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill('SIGTERM'), this.shutdownTimeoutMs);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), this.shutdownTimeoutMs + 1000);
    try { await this.exited; }
    finally { clearTimeout(term); clearTimeout(kill); }
  }
}

export class Sessions {
  constructor({ command = 'pi', args = [], requestTimeoutMs = 120000, shutdownTimeoutMs = 5000 } = {}) {
    this.command = command;
    this.args = args;
    this.requestTimeoutMs = requestTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.paths = new Map();
    this.aliases = new Map();
    this.persistedPaths = new Map();
    this.opening = new Map();
    this.sessions = new Set();
  }

  async open(options = {}) {
    if (this.closed) throw new Error('Remote sessions are closed');
    const path = options.sessionFile && await sessionPath(options.sessionFile);
    const requestedPath = options.sessionFile && resolve(options.sessionFile);
    const key = path?.exists ? path.path : this.aliases.get(requestedPath) ?? path?.path;
    if (key && this.paths.has(key)) {
      const cached = this.paths.get(key);
      const exists = path.exists || (key !== path.path && (await sessionPath(key)).exists);
      if (cached.failure || cached.closing) throw new Error(`Pi RPC session for ${key} is unavailable (failed or closing). Wait for shutdown to finish before retrying; refresh the history list.`);
      this.aliases.set(requestedPath, key);
      if (!cached.ephemeral && exists) this.persistedPaths.set(key, cached);
      if (this.persistedPaths.get(key) === cached && !exists) {
        if (cached.state.isStreaming || cached.state.isCompacting) throw new Error(`Pi session history is no longer on disk: ${key}. Its active or compacting runtime was not closed. Wait until it is idle and refresh the history list; restore the file locally if needed.`);
        await this.closeMissing(cached, key);
      }
      return cached;
    }
    if (key && this.opening.has(key)) {
      const rpc = await this.opening.get(key);
      this.aliases.set(requestedPath, key);
      return rpc;
    }
    if (key && !path.exists) throw new Error(`Pi session history is no longer on disk: ${key}. Refresh the history list; restore the file locally before retrying if needed.`);
    const opening = this.start({ ...options, sessionFile: key });
    if (key) this.opening.set(key, opening);
    try {
      const rpc = await opening;
      if (key) this.aliases.set(requestedPath, key);
      return rpc;
    } finally { if (key) this.opening.delete(key); }
  }

  async closeMissing(rpc, file) {
    const error = new Error(`Pi session history is no longer on disk: ${file}. Its cached runtime was closed. Refresh the history list; restore the file locally before retrying if needed.`);
    rpc.fail(error);
    await rpc.close();
    throw error;
  }

  async start({ cwd = process.cwd(), sessionFile, forkFrom, model, effort, ephemeral = false } = {}) {
    const args = [...this.args, '--mode', 'rpc'];
    if (ephemeral) args.push('--no-session');
    if (sessionFile) args.push('--session', sessionFile);
    if (forkFrom) args.push('--fork', forkFrom);
    if (model) args.push('--model', typeof model === 'string' ? model : `${model.provider}/${model.modelId ?? model.id}`);
    if (effort) args.push('--thinking', effort);
    const child = spawn(this.command, args, {
      cwd: resolve(cwd),
      env: { ...process.env, PI_OFFLINE: '1', PI_CODEX_REMOTE_RPC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = new RpcSession(child, {
      cwd: resolve(cwd),
      ephemeral,
      requestTimeoutMs: this.requestTimeoutMs,
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      onState: async rpc => {
        for (const [file, existing] of this.paths) if (existing === rpc) this.paths.delete(file);
        if (rpc.sessionFile) {
          const { path: file, exists } = await sessionPath(rpc.sessionFile);
          if (this.persistedPaths.get(file) === rpc && !exists && !rpc.state.isStreaming && !rpc.state.isCompacting) await this.closeMissing(rpc, file);
          const existing = this.paths.get(file);
          if (existing && existing !== rpc) throw new Error(`Pi Session is already open: ${rpc.id}`);
          this.paths.set(file, rpc);
          if (!ephemeral && exists) this.persistedPaths.set(file, rpc);
        }
      },
      onClose: rpc => {
        this.sessions.delete(rpc);
        for (const [file, existing] of this.paths) if (existing === rpc) this.paths.delete(file);
        for (const [file, existing] of this.persistedPaths) if (existing === rpc) this.persistedPaths.delete(file);
        for (const [alias, file] of this.aliases) if (!this.paths.has(file)) this.aliases.delete(alias);
      },
    });
    this.sessions.add(session);
    try {
      await session.refresh();
      if (session.startupError) throw session.startupError;
      session.initializing = false;
      if (this.closed) throw new Error('Remote sessions are closed');
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.sessions].map(session => session.close()));
  }
}
