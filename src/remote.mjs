// Wire format references: openai/codex remote_control and Lqm1/pi-codex-app-server.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Agent } from 'undici';
import { protocolMethods } from './schema.mjs';

const BASE = 'https://chatgpt.com/backend-api/wham/remote/control/';
const MAX_MESSAGE = 100 * 1024 * 1024;
const CHUNK_SIZE = 100 * 1024;

export function remotePaths(env = process.env) {
  const config = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const state = join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'pi', 'codex-remote');
  return { state, auth: join(env.CODEX_HOME || join(config, 'codex'), 'auth.json') };
}

export async function loadAuth(path) {
  const { tokens } = JSON.parse(await readFile(path, 'utf8'));
  if (!tokens?.access_token || !tokens.account_id) throw new Error('Sign in through official ChatGPT/Codex before enabling Remote. Pi model credentials are not Remote credentials.');
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url'));
  if (claims.exp * 1000 <= Date.now()) throw new Error('Official Codex login expired. Refresh it through ChatGPT/Codex; Remote never rotates its refresh token.');
  return { accessToken: tokens.access_token, accountId: tokens.account_id };
}

async function store(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export class Remote {
  constructor({ stateDir = remotePaths().state, authPath = remotePaths().auth, handle, fetchImpl = fetch, socketFactory = (url, options) => new WebSocket(url, options), onStatus = () => {}, disconnect = () => {}, onTrace }) {
    Object.assign(this, { stateDir, authPath, handle, fetchImpl, socketFactory, onStatus, disconnect, onTrace });
    this.pending = new Map();
    this.frameSizes = new WeakMap();
    this.incoming = new Map();
    this.received = new Map();
    this.runtimeReceived = new Map();
    this.chunks = new Map();
    this.sequences = new Map();
    this.tasks = new Set();
    this.clients = new Map();
    this.closedStreams = new Set();
    this.stopController = new AbortController();
    this.dispatcher = new Agent({ allowH2: false });
    this.status = 'stopped';
    this.saving = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    this.file = join(this.stateDir, 'remote.json');
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { installationId: randomUUID() }; }
    this.incoming = new Map(Object.entries(this.state.incoming || {}));
    this.received = new Map(Object.entries(this.state.received || {}).map(([key, values]) => [key, new Set(values)]));
    for (const [key, seq] of this.incoming) if (!this.received.has(key)) this.received.set(key, new Set(Array.from({ length: Math.min(seq + 1, 1024) }, (_, index) => seq - index)));
    this.sequences = new Map(Object.entries(this.state.sequences || {}));
    this.closedStreams = new Set(this.state.closedStreams || []);
    this.cursor = this.state.cursor;
    await this.persist();
  }

  persist() {
    this.saving = this.saving.then(() => store(this.file, this.state));
    return this.saving;
  }

  async post(endpoint, token, body, headers = {}) {
    const response = await this.fetchImpl(`${BASE}${endpoint}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30000), this.stopController.signal]),
      dispatcher: this.dispatcher,
    });
    if (!response.ok) throw new Error(`Codex Remote relay ${endpoint}: HTTP ${response.status}`);
    return response.json();
  }

  async enroll() {
    this.enrolling ||= this.enrollOnce().finally(() => { this.enrolling = undefined; });
    return this.enrolling;
  }

  async enrollOnce() {
    const auth = await loadAuth(this.authPath);
    const current = this.state.enrollment;
    if (current && current.accountId !== auth.accountId) throw new Error('Official login belongs to a different account. Existing Remote pairing was preserved.');
    if (current?.accountId === auth.accountId && Date.parse(current.expires_at) > Date.now() + 5 * 60000) return current;
    const headers = { 'chatgpt-account-id': auth.accountId, 'x-codex-installation-id': this.state.installationId, 'user-agent': `codex_cli_rs/${protocolMethods.version} (Mac OS; arm64)` };
    let enrollment;
    if (current?.accountId === auth.accountId) {
      enrollment = await this.post('server/refresh', auth.accessToken, { server_id: current.server_id, installation_id: this.state.installationId }, headers);
      if (enrollment.server_id !== current.server_id || enrollment.environment_id !== current.environment_id) throw new Error('Remote refresh returned a different device');
    } else {
      enrollment = await this.post('server/enroll', auth.accessToken, { name: `${hostname()} · Pi`, os: process.platform, arch: process.arch, app_server_version: protocolMethods.version, installation_id: this.state.installationId }, headers);
    }
    if (!enrollment.server_id || !enrollment.remote_control_token || !Number.isFinite(Date.parse(enrollment.expires_at))) throw new Error('Invalid Remote enrollment response');
    this.state.enrollment = { ...enrollment, accountId: auth.accountId };
    await this.persist();
    return this.state.enrollment;
  }

  async pair() {
    const enrollment = await this.enroll();
    const result = await this.post('server/pair', enrollment.remote_control_token, { manual_code: true });
    if (result.server_id !== enrollment.server_id || result.environment_id !== enrollment.environment_id) throw new Error('Pairing returned a different device');
    const url = new URL('https://chatgpt.com/codex/pair');
    url.searchParams.set('pairing_code', result.pairing_code);
    return { url: url.toString(), manualCode: result.manual_pairing_code, expiresAt: result.expires_at };
  }

  setStatus(status, error) {
    this.status = status;
    this.error = error;
    this.onStatus({ status, error });
  }

  async run() {
    let retry = 1000;
    while (!this.stopController.signal.aborted) {
      try {
        this.setStatus('connecting');
        const enrollment = await this.enroll();
        await this.connect(enrollment);
        retry = 1000;
      } catch (error) {
        if (this.stopController.signal.aborted) break;
        this.setStatus('disconnected', error.message);
      }
      try { await delay(retry, undefined, { signal: this.stopController.signal }); } catch { break; }
      retry = Math.min(retry * 2, 30000);
    }
    this.setStatus('stopped');
  }

  async connect(enrollment) {
    const headers = {
      authorization: `Bearer ${enrollment.remote_control_token}`, 'x-codex-server-id': enrollment.server_id,
      'x-codex-installation-id': this.state.installationId, 'x-codex-name': Buffer.from(`${hostname()} · Pi`).toString('base64'),
      'x-codex-protocol-version': '3',
    };
    if (this.cursor) headers['x-codex-subscribe-cursor'] = this.cursor;
    const socket = this.socketFactory(BASE.replace('https:', 'wss:') + 'server', { headers, maxPayload: MAX_MESSAGE });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let open = false;
      let heartbeat;
      let deadline = setTimeout(() => { socket.terminate(); reject(new Error('Remote connection timed out')); }, 30000);
      socket.on('open', () => {
        open = true;
        clearTimeout(deadline);
        this.setStatus('connected');
        for (const frames of this.pending.values()) for (const frame of frames) this.sendFrame(frame);
        heartbeat = setInterval(() => socket.ping(), 20000);
        deadline = setTimeout(() => socket.terminate(), 60000);
      });
      socket.on('pong', () => { clearTimeout(deadline); deadline = setTimeout(() => socket.terminate(), 60000); });
      socket.on('message', bytes => {
        const task = Promise.resolve().then(() => this.receive(JSON.parse(bytes.toString()))).catch(error => { this.setStatus('disconnected', error.message); socket.close(); });
        this.tasks.add(task);
        task.finally(() => this.tasks.delete(task));
      });
      socket.on('error', reject);
      socket.on('close', () => {
        clearInterval(heartbeat); clearTimeout(deadline);
        if (this.socket === socket) this.socket = undefined;
        open ? resolve() : reject(new Error('Remote closed before connecting'));
      });
    });
  }

  trace(event, envelope) {
    if (!this.onTrace) return;
    const hash = value => value == null ? null : createHash('sha256').update(`${typeof value}:${value}`).digest('hex').slice(0, 16);
    const message = envelope.message;
    const method = typeof message?.method === 'string' && /^[a-zA-Z][a-zA-Z0-9/]{0,99}$/.test(message.method) ? message.method : null;
    const detail = {
      event, type: ['ping', 'pong', 'ack', 'client_closed', 'client_message', 'client_message_chunk', 'server_message', 'server_message_chunk'].includes(envelope.type) ? envelope.type : 'unknown',
      client: hash(envelope.client_id), stream: hash(envelope.stream_id), seq: Number.isSafeInteger(envelope.seq_id) ? envelope.seq_id : null,
      request: hash(message?.id), method, errorCode: Number.isInteger(message?.error?.code) ? message.error.code : null,
      segment: Number.isSafeInteger(envelope.segment_id) ? envelope.segment_id : null,
      segments: Number.isSafeInteger(envelope.segment_count) ? envelope.segment_count : null,
      bytes: Number.isSafeInteger(envelope.message_size_bytes) ? envelope.message_size_bytes : null,
    };
    if (method === 'command/exec') {
      const command = message.params?.command;
      const program = Array.isArray(command) && typeof command[0] === 'string' ? command[0].split('/').at(-1) : null;
      detail.program = ['sh', 'bash', 'zsh', 'git', 'pwd', 'ls', 'test', 'node', 'python3'].includes(program) ? program : 'other';
      const sandbox = message.params?.sandboxPolicy?.type;
      detail.sandboxType = ['readOnly', 'workspaceWrite', 'dangerFullAccess', 'externalSandbox'].includes(sandbox) ? sandbox : 'other';
      const text = Array.isArray(command) ? command.filter(value => typeof value === 'string').join(' ') : '';
      detail.execChecks = ['status', 'rev-parse', 'diff', 'branch', 'log'].filter(operation => new RegExp(`\\bgit\\s+${operation}\\b`).test(text)).map(operation => `git-${operation}`);
    }
    this.onTrace(detail);
  }

  sendFrame(frame) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      this.trace('send', frame);
    } else this.trace('send-deferred', frame);
  }

  frameSize(frame) {
    // Pending frames are snapshots; ACK filtering preserves surviving frame identities.
    let size = this.frameSizes.get(frame);
    if (size === undefined) {
      size = Buffer.byteLength(JSON.stringify(frame));
      this.frameSizes.set(frame, size);
    }
    return size;
  }

  emit(clientId, streamId, message) {
    return this.emitEvent(clientId, streamId, { type: 'server_message', message });
  }

  emitEvent(clientId, streamId, event) {
    const key = `${clientId}\0${streamId}`;
    const seq = (this.sequences.get(key) || 0) + 1;
    const bytes = Buffer.from(JSON.stringify(event.message ?? event));
    if (bytes.length > MAX_MESSAGE) throw new Error('Remote result exceeds 100 MiB');
    const base = { client_id: clientId, stream_id: streamId, seq_id: seq };
    this.trace('response', { ...base, ...event, message_size_bytes: bytes.length });
    const frames = [];
    if (bytes.length <= CHUNK_SIZE) frames.push({ ...base, ...event });
    else for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) frames.push({ ...base, type: 'server_message_chunk', segment_id: frames.length, segment_count: Math.ceil(bytes.length / CHUNK_SIZE), message_size_bytes: bytes.length, message_chunk_base64: bytes.subarray(offset, offset + CHUNK_SIZE).toString('base64') });
    let size = 0;
    for (const pendingFrames of this.pending.values()) for (const frame of pendingFrames) size += this.frameSize(frame);
    if (size + frames.reduce((total, frame) => total + this.frameSize(frame), 0) > MAX_MESSAGE) throw new Error('Remote acknowledgement backlog exceeds 100 MiB; reconnect the phone');
    this.sequences.set(key, seq);
    this.pending.set(`${key}\0${seq}`, frames);
    this.state.sequences = Object.fromEntries(this.sequences);
    return this.persist().then(() => {
      for (const frame of frames) this.sendFrame(frame);
    }).catch(error => { this.setStatus('disconnected', error.message); this.socket?.close(); });
  }

  async receive(envelope) {
    const { client_id: clientId, stream_id: streamId, seq_id: seq } = envelope;
    this.trace('receive', envelope);
    if (typeof clientId !== 'string' || !clientId || clientId.includes('\0')) throw new Error('Invalid Remote client');
    if (envelope.type === 'ping') {
      const status = this.clients.has(`${clientId}\0${streamId}`) ? 'active' : 'unknown';
      await this.emitEvent(clientId, streamId || randomUUID(), { type: 'pong', status });
      return;
    }
    if (envelope.type === 'client_closed' && !streamId) {
      const keys = new Set([...this.clients.keys(), ...this.incoming.keys(), ...this.sequences.keys(), ...this.chunks.keys()].map(key => key.split('\0').slice(0, 2).join('\0')));
      for (const key of keys) if (key.startsWith(`${clientId}\0`)) this.closeClient(key);
      for (const id of this.pending.keys()) if (id.startsWith(`${clientId}\0`)) this.pending.delete(id);
      this.saveDeliveryState();
      await this.persist();
      return;
    }
    if (typeof streamId !== 'string' || !streamId || streamId.includes('\0')) throw new Error('Remote message has no valid stream ID');
    const key = `${clientId}\0${streamId}`;
    if (['ack', 'client_message', 'client_message_chunk'].includes(envelope.type) && (!Number.isSafeInteger(seq) || seq < 0)) throw new Error('Invalid Remote sequence ID');
    if (envelope.type === 'ack') {
      if (envelope.segment_id !== undefined && (!Number.isInteger(envelope.segment_id) || envelope.segment_id < 0)) throw new Error('Invalid Remote acknowledgement');
      if (seq > (this.sequences.get(key) ?? 0)) return;
      for (const [id, frames] of this.pending) {
        if (!id.startsWith(`${key}\0`) || frames[0].seq_id > seq) continue;
        if (envelope.segment_id === undefined || frames[0].seq_id < seq) this.pending.delete(id);
        else {
          const rest = frames.filter(frame => frame.segment_id !== envelope.segment_id);
          rest.length ? this.pending.set(id, rest) : this.pending.delete(id);
        }
      }
      return;
    }
    if (this.closedStreams.has(key)) { this.trace('closed-stream', envelope); return; }
    if (envelope.type === 'client_closed') {
      this.closeClient(key);
      for (const id of this.pending.keys()) if (id.startsWith(`${key}\0`)) this.pending.delete(id);
      this.saveDeliveryState();
      await this.persist();
      return;
    }
    if (envelope.type === 'client_message_chunk') {
      if (!Number.isInteger(envelope.segment_count) || envelope.segment_count < 1 || envelope.segment_count > 1024 || !Number.isInteger(envelope.segment_id) || envelope.segment_id < 0 || envelope.segment_id >= envelope.segment_count || !Number.isSafeInteger(envelope.message_size_bytes) || envelope.message_size_bytes < 1 || envelope.message_size_bytes > MAX_MESSAGE || typeof envelope.message_chunk_base64 !== 'string') throw new Error('Invalid Remote chunk');
      const id = `${key}\0${seq}`;
      if (!this.chunks.has(id) && this.chunks.size >= 16) throw new Error('Too many incomplete Remote messages');
      const assembly = this.chunks.get(id) || { parts: Array(envelope.segment_count).fill(undefined), size: envelope.message_size_bytes, bytes: 0, receivedCount: 0 };
      if (assembly.parts.length !== envelope.segment_count || assembly.size !== envelope.message_size_bytes) throw new Error('Remote chunk metadata changed');
      const part = Buffer.from(envelope.message_chunk_base64, 'base64');
      let used = 0;
      for (const item of this.chunks.values()) used += item.bytes;
      if (used + part.length - (assembly.parts[envelope.segment_id]?.length || 0) > MAX_MESSAGE) throw new Error('Remote chunk backlog exceeds 100 MiB');
      const previous = assembly.parts[envelope.segment_id];
      if (previous && !previous.equals(part)) throw new Error('Remote chunk content changed');
      if (previous === undefined) {
        assembly.bytes += part.length;
        assembly.receivedCount++;
      }
      assembly.parts[envelope.segment_id] = part;
      this.chunks.set(id, assembly);
      if (assembly.receivedCount !== assembly.parts.length) return;
      this.chunks.delete(id);
      const bytes = Buffer.concat(assembly.parts);
      if (bytes.length !== assembly.size) throw new Error('Remote chunk size mismatch');
      envelope = { ...envelope, type: 'client_message', message: JSON.parse(bytes.toString()) };
      this.trace('assembled', envelope);
    }
    if (envelope.type !== 'client_message') throw new Error(`Unsupported Remote envelope: ${envelope.type}`);
    if (!envelope.message || typeof envelope.message !== 'object' || Array.isArray(envelope.message)) throw new Error('Invalid Remote message');
    const duplicate = this.received.get(key)?.has(seq) || seq <= (this.incoming.get(key) ?? -1) - 1024;
    const existing = this.clients.get(key);
    let client = existing;
    if (!client) {
      client = { closed: false, deliveryFailures: 0 };
      client.emit = message => {
        if (client.closed) return;
        try { return this.emit(clientId, streamId, message); }
        catch (error) {
          client.deliveryFailed = true;
          client.deliveryFailures++;
          this.runtimeReceived.get(key)?.clear();
          this.setStatus('disconnected', error.message);
          this.socket?.close();
        }
      };
      this.clients.set(key, client);
    }
    if (duplicate) {
      this.trace('duplicate', envelope);
      const failures = client.deliveryFailures;
      if (!this.runtimeReceived.get(key)?.has(seq) && envelope.message.id != null) {
        await client.emit({ id: envelope.message.id, error: { code: -32000, message: 'Earlier request outcome is unavailable after Remote restart or delivery failure. It may have executed. Reload thread history and current state before retrying any action.' } });
        if (client.deliveryFailures === failures) client.deliveryFailed = false;
      }
      return;
    }
    const highest = Math.max(seq, this.incoming.get(key) ?? -1);
    this.incoming.set(key, highest);
    let received = this.received.get(key);
    if (!received) this.received.set(key, received = new Set());
    received.add(seq);
    let runtimeReceived = this.runtimeReceived.get(key);
    if (!runtimeReceived) this.runtimeReceived.set(key, runtimeReceived = new Set());
    runtimeReceived.add(seq);
    for (const values of [received, runtimeReceived]) for (const value of values) if (value <= highest - 1024) values.delete(value);
    this.saveDeliveryState();
    if (envelope.cursor) this.state.cursor = this.cursor = envelope.cursor;
    await this.persist();
    if (client.closed) { this.trace('closed-before-dispatch', envelope); return; }
    this.trace('dispatch', envelope);
    await this.handle(envelope.message, client.emit);
    await this.saving;
  }

  saveDeliveryState() {
    this.state.incoming = Object.fromEntries(this.incoming);
    this.state.received = Object.fromEntries([...this.received].map(([key, values]) => [key, [...values]]));
    this.state.sequences = Object.fromEntries(this.sequences);
    this.state.closedStreams = [...this.closedStreams];
  }

  closeClient(key) {
    this.closedStreams.add(key);
    const client = this.clients.get(key);
    if (client) { client.closed = true; this.disconnect(client.emit); this.clients.delete(key); }
    this.incoming.delete(key);
    this.received.delete(key);
    this.runtimeReceived.delete(key);
    for (const id of this.chunks.keys()) if (id.startsWith(`${key}\0`)) this.chunks.delete(id);
  }

  async close() {
    for (const key of this.clients.keys()) this.closeClient(key);
    this.stopController.abort();
    this.socket?.close();
    const socket = this.socket;
    if (socket) setTimeout(() => socket.terminate(), 1000).unref();
    await Promise.allSettled(this.tasks);
    await this.saving;
    await this.dispatcher.destroy();
  }
}
