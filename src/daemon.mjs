import { createServer, createConnection } from 'node:net';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { open, readFile, mkdir, unlink, chmod } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Remote, remotePaths } from './remote.mjs';
import { Sessions } from './sessions.mjs';
import { Protocol } from './protocol.mjs';

export function createInputTrace({ enabled = false, home = process.env.HOME, stateDir, temporaryDir = tmpdir(), now = Date.now,
  write = record => console.error(`${new Date().toISOString()} [DEBUG-remote-input] ${JSON.stringify(record)}`),
} = {}) {
  if (!enabled) return () => {};
  const expiresAt = now() + 30 * 60 * 1000;
  const maxRecords = 200;
  const salt = randomBytes(32);
  const hash = value => createHmac('sha256', salt).update(value).digest('hex').slice(0, 16);
  const methods = new Set(['fs/createDirectory', 'fs/writeFile', 'fs/readFile', 'fs/readDirectory', 'fs/getMetadata', 'turn/start', 'turn/steer', 'config/batchWrite', 'config/value/write']);
  const directories = new Set(['.codex', '.pi', '.cache', 'tmp', 'temp', 'attachments', 'uploads', 'images', 'Library', 'Caches', 'Application Support']);
  const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif', '.bin']);
  const configKeys = new Set(['personality', 'features', 'model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'service_tier', 'approval_policy', 'sandbox_mode', 'default_permissions', 'web_search', 'hide_agent_reasoning', 'show_raw_agent_reasoning']);
  const enums = {
    personality: ['none', 'friendly', 'pragmatic'], model_reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    model_reasoning_summary: ['auto', 'concise', 'detailed', 'none'], model_verbosity: ['low', 'medium', 'high'],
    service_tier: ['auto', 'default', 'flex', 'priority', 'fast'], approval_policy: ['untrusted', 'on-failure', 'on-request', 'never'],
    sandbox_mode: ['read-only', 'workspace-write', 'danger-full-access'], web_search: ['disabled', 'cached', 'live'],
  };
  const pathInfo = value => {
    if (typeof value !== 'string') return null;
    const path = normalize(value);
    const roots = [[stateDir, 'state'], [temporaryDir, 'temp'], ['/private/tmp', 'temp'], ['/tmp', 'temp'], [home, 'home']];
    const root = roots.find(([base]) => base && (path === normalize(base) || path.startsWith(`${normalize(base)}/`)));
    const parts = (root ? relative(root[0], path) : path).split('/').filter(Boolean);
    const extension = extname(path).toLowerCase();
    return {
      root: root?.[1] ?? (isAbsolute(path) ? 'absolute' : 'relative'), id: hash(path), parent: hash(dirname(path)), depth: parts.length,
      parts: parts.slice(0, 12).map(part => directories.has(part) ? part : `#${hash(part)}`),
      extension: extensions.has(extension) ? extension : extension ? 'other' : null,
    };
  };
  const dataInfo = value => typeof value === 'string' ? { encodedChars: value.length, estimatedBytes: Buffer.byteLength(value, 'base64') } : null;
  const inputInfo = part => {
    if (part?.type === 'text') return { type: 'text', chars: typeof part.text === 'string' ? part.text.length : null };
    if (part?.type === 'localImage') return { type: 'localImage', path: pathInfo(part.path) };
    if (part?.type !== 'image') return { type: 'other' };
    const url = typeof part.url === 'string' ? part.url : '';
    const source = url.startsWith('data:') ? 'data' : /^https?:/i.test(url) ? 'http' : url.startsWith('file:') ? 'file' : 'other';
    const prefix = /^data:(image\/(?:png|jpeg|gif|webp|heic|heif|avif));base64,/i.exec(url.slice(0, 96));
    return { type: 'image', source, mimeType: prefix?.[1].toLowerCase() ?? null, ...(prefix ? dataInfo(url.slice(prefix[0].length)) : {}) };
  };
  const editInfo = edit => {
    const key = typeof edit?.keyPath === 'string' ? edit.keyPath : '';
    const value = edit?.value;
    return {
      keyPath: key ? key.split('.').slice(0, 8).map(part => configKeys.has(part) ? part : `#${hash(part)}`).join('.') : null,
      valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      ...(typeof value === 'boolean' || Object.hasOwn(enums, key) && enums[key].includes(value) ? { value } : {}),
    };
  };
  let count = 0;
  let stopped = false;
  write({ phase: 'enabled', expiresAt: new Date(expiresAt).toISOString(), maxRecords });
  return (request, phase = 'request', error) => {
    if (stopped || !methods.has(request?.method)) return;
    if (now() >= expiresAt || count >= maxRecords) {
      stopped = true;
      write({ phase: 'disabled', reason: now() >= expiresAt ? 'expired' : 'limit' });
      return;
    }
    count++;
    const { method, id } = request;
    const record = { phase, method, request: ['string', 'number'].includes(typeof id) ? hash(`${typeof id}:${id}`) : null };
    if (phase === 'response') record.errorCode = Number.isInteger(error?.code) ? error.code : null;
    else {
      const params = request.params ?? {};
      if (method.startsWith('fs/')) {
        record.path = pathInfo(params.path);
        if (method === 'fs/createDirectory') record.recursive = typeof params.recursive === 'boolean' ? params.recursive : null;
        if (method === 'fs/writeFile') record.dataBase64 = dataInfo(params.dataBase64);
      } else if (method.startsWith('turn/')) {
        record.inputCount = Array.isArray(params.input) ? params.input.length : null;
        record.input = Array.isArray(params.input) ? params.input.slice(0, 10).map(inputInfo) : [];
      } else {
        const edits = method === 'config/value/write' ? [params] : params.edits;
        record.editsCount = Array.isArray(edits) ? edits.length : null;
        record.edits = Array.isArray(edits) ? edits.slice(0, 20).map(editInfo) : [];
      }
    }
    write(record);
  };
}

export function paths() {
  const { state } = remotePaths();
  return { state, socket: join(state, 'control.sock'), lock: join(state, 'daemon.lock'), log: join(state, 'daemon.log') };
}

export function control(action, statePaths = paths()) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(statePaths.socket);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Remote control request timed out')); }, 35000);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ action })}\n`));
    socket.on('data', bytes => {
      buffer += bytes.toString();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end));
        result.error ? reject(new Error(result.error)) : resolve(result.result);
      } catch (error) { reject(error); }
      socket.end();
    });
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); if (!buffer.includes('\n')) reject(new Error('Remote control closed without a response')); });
  });
}

export async function start() {
  const p = paths();
  try { return await control('status', p); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await mkdir(p.state, { recursive: true, mode: 0o700 });
  const log = await open(p.log, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon'], {
    cwd: process.env.HOME, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  await log.close();
  for (let i = 0; i < 350; i++) {
    if (spawnError) throw spawnError;
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await control('status', p); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  }
  throw new Error(`Remote daemon did not start. See ${p.log}`);
}

async function serve() {
  const p = paths();
  await mkdir(p.state, { recursive: true, mode: 0o700 });
  await chmod(p.state, 0o700);
  let lock;
  try { lock = await open(p.lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(p.lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Remote daemon lock; inspect it before restarting');
    try { process.kill(pid, 0); throw new Error('Remote daemon is already running'); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await unlink(p.lock);
    lock = await open(p.lock, 'wx', 0o600);
  }
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();
  const sessions = new Sessions();
  const inputTrace = createInputTrace({ enabled: process.env.PI_REMOTE_INPUT_TRACE === '1', stateDir: p.state });
  const protocol = new Protocol({ sessions, cwd: process.env.HOME, stateDir: p.state, onResponse: (request, error, result) => {
    inputTrace(request, 'response', error);
    const validation = [-32601, -32602].includes(error?.code) ? ` ${error.message}` : '';
    const threadId = request.params?.threadId ?? result?.thread?.id;
    const threadContext = typeof threadId === 'string' && /^[0-9a-f-]{36}$/i.test(threadId) ? ` thread:${threadId}` : '';
    console.error(`${new Date().toISOString()} ${request.method} ${error ? `error:${error.code ?? -32000}${validation}` : 'ok'}${threadContext}`);
    if (!error && request.method === 'thread/list') {
      const params = request.params ?? {};
      console.error(JSON.stringify({
        method: 'thread/list', limit: params.limit ?? 50, archived: Boolean(params.archived),
        sortKey: params.sortKey ?? 'created_at', sortDirection: params.sortDirection ?? 'desc', cursor: Boolean(params.cursor),
        cwdFilter: Boolean(params.cwd), searchFilter: Boolean(params.searchTerm),
        projectFilter: params.projectId != null, sectionFilter: params.sectionId != null,
        parentFilter: Boolean(params.parentThreadId), ancestorFilter: Boolean(params.ancestorThreadId),
        sourceFilter: Boolean(params.sourceKinds?.length), acceptsPiSource: !params.sourceKinds?.length || params.sourceKinds.some(kind => ['unknown', 'subAgent', 'subAgentOther'].includes(kind)),
        providerFilter: Boolean(params.modelProviders?.length), acceptsPiProvider: !params.modelProviders?.length || params.modelProviders.includes('custom'),
        catalogSize: protocol.catalog.size, returned: result.data.length, hasNextPage: result.nextCursor != null,
      }));
    }
    if (request.method === 'thread/resume') {
      console.error(JSON.stringify({
        method: 'thread/resume', excludeTurns: Boolean(request.params?.excludeTurns), initialTurnsPage: Boolean(request.params?.initialTurnsPage),
        historyMode: result?.thread?.historyMode ?? null, status: result?.thread?.status?.type ?? null,
        returnedTurns: result?.thread?.turns?.length ?? null, returnedInitialTurns: result?.initialTurnsPage?.data?.length ?? null,
        canAcceptDirectInput: result?.thread?.canAcceptDirectInput ?? null,
      }));
    }
    if (error && ['thread/start', 'thread/resume', 'thread/read', 'thread/settings/update', 'turn/start'].includes(request.method)) {
      const { sandbox, sandboxPolicy, approvalPolicy, approvalsReviewer, modelProvider, model, summary, config, ...rest } = request.params ?? {};
      console.error(JSON.stringify({ method: request.method, sandbox, sandboxPolicy, approvalPolicy, approvalsReviewer, modelProvider, model, dynamicToolsCount: Array.isArray(rest.dynamicTools) ? rest.dynamicTools.length : rest.dynamicTools == null ? null : 'invalid', historyMode: rest.historyMode == null ? null : ['legacy', 'paginated'].includes(rest.historyMode) ? rest.historyMode : 'unsupported', summary: summary == null ? null : ['auto', 'concise', 'detailed', 'none'].includes(summary) ? summary : 'unsupported', configKeys: Object.keys(config ?? {}), keys: Object.keys(rest) }));
    }
  } });
  const remote = new Remote({ stateDir: p.state, handle: (message, emit) => {
    inputTrace(message);
    if (message.id !== undefined) console.error(`${new Date().toISOString()} ${message.method}`);
    return protocol.handle(message, emit);
  }, disconnect: emit => protocol.disconnect(emit),
  onTrace: process.env.PI_REMOTE_TRACE === '1' ? event => console.error(`${new Date().toISOString()} [DEBUG-remote-delivery] ${JSON.stringify(event)}`) : undefined,
  onStatus: ({ status, error }) => console.error(`${new Date().toISOString()} remote ${status}${error ? ' error' : ''}`),
  });
  let server;
  let running;
  let stopping;
  const stop = () => stopping ||= (async () => {
    await protocol.close();
    await sessions.close();
    await remote.close();
    await running;
    if (server) await new Promise(resolve => server.close(resolve));
  })();
  try {
    await remote.initialize();
    await protocol.ready;
    await remote.enroll();
    try { await unlink(p.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    server = createServer(socket => {
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', bytes => {
        buffer += bytes.toString();
        if (buffer.length > 4096) { socket.destroy(); return; }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        socket.removeAllListeners('data');
        void (async () => {
          const { action } = JSON.parse(buffer.slice(0, end));
          let result;
          if (action === 'status') result = { pid: process.pid, status: remote.status, error: remote.error, log: p.log };
          else if (action === 'pair') result = await remote.pair();
          else if (action === 'stop') result = { stopping: true };
          else throw new Error(`Unknown Remote command: ${action}`);
          socket.end(`${JSON.stringify({ result })}\n`);
          if (action === 'stop') socket.once('close', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
        })().catch(error => socket.end(`${JSON.stringify({ error: error.message })}\n`));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p.socket, resolve); });
    await chmod(p.socket, 0o600);
    running = remote.run();
    const onSignal = () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    await new Promise(resolve => server.once('close', resolve));
    await stopping;
  } finally {
    await protocol.close();
    await sessions.close();
    await remote.close();
    for (const file of [p.socket, p.lock]) try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().catch(error => { console.error(`${new Date().toISOString()} ${error.message}`); process.exitCode = 1; });
}
