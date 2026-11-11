import { createServer, createConnection } from 'node:net';
import { accessSync, constants, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { open, readFile, readdir, mkdir, unlink, chmod, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Remote, remotePaths } from './remote.mjs';
import { Sessions } from './sessions.mjs';
import { Protocol } from './protocol.mjs';

const execFileAsync = promisify(execFile);

const MAX_LOG = 10 * 1024 * 1024;

export function paths() {
  const { state } = remotePaths();
  return { state, socket: join(state, 'control.sock'), enabled: join(state, 'enabled'), log: join(state, 'daemon.log') };
}

const ignoreMissing = error => { if (error.code !== 'ENOENT') throw error; };

// `pair` and `start` enable the daemon and `stop` disables it; Pi sessions start an enabled daemon that is down.
export async function setEnabled(enabled, statePaths = paths()) {
  if (!enabled) return unlink(statePaths.enabled).catch(ignoreMissing);
  await mkdir(statePaths.state, { recursive: true, mode: 0o700 });
  await writeFile(statePaths.enabled, '', { mode: 0o600 });
}

// Each contender writes its own pid file; one that sees another live daemon's file backs off, so a stale
// lock is taken over by one of several daemons starting at once. `daemon.lock` is the earlier format.
export async function acquireLock(dir, pid = process.pid) {
  const own = join(dir, `daemon.${pid}.lock`);
  const alive = other => { try { process.kill(other, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  for (let attempt = 0; attempt < 20; attempt++) {
    await writeFile(own, '', { flag: 'wx', mode: 0o600 });
    let held = false;
    for (const name of await readdir(dir)) {
      const other = name === 'daemon.lock' ? Number(await readFile(join(dir, name), 'utf8').catch(() => '')) : Number(/^daemon\.(\d+)\.lock$/.exec(name)?.[1]);
      if (!other || other === pid) continue;
      if (alive(other)) held = true;
      else await unlink(join(dir, name)).catch(ignoreMissing);
    }
    if (!held) return () => { try { unlinkSync(own); } catch (error) { ignoreMissing(error); } };
    await unlink(own);
    await delay(5 + Math.random() * 20);
  }
  throw new Error('Codex Remote daemon is already running');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The checked-out commit of a git install, else the package version: edits in progress do not change it.
export async function codeVersion(dir = root) {
  if (existsSync(join(dir, '.git'))) return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
}

// A Pi session that runs other code than the daemon asks it to retire. The daemon hands over once it is idle and
// the code on disk is still that code and loads; code that does not load is not tried again.
export function createRetirement({ initial, current = codeVersion, idle, loads, handover, log = () => {}, intervalMs = 1000 }) {
  let rejected;
  let target;
  let timer;
  let checking = false;
  const check = async () => {
    if (checking || !idle()) return;
    checking = true;
    try {
      if (!await loads()) {
        rejected = target;
        target = undefined;
        clearInterval(timer);
        log('updated code does not load; keeping the running daemon');
      } else if (idle()) {
        clearInterval(timer);
        handover();
      }
    } finally { checking = false; }
  };
  return async version => {
    if (target !== undefined || version === initial || version === rejected) return false;
    target = version;
    if (await current() !== version) {
      target = undefined;
      return false;
    }
    log('code updated; handing over to a new daemon once idle');
    timer = setInterval(() => { void check().catch(error => log(`update check failed: ${error.message}`)); }, intervalMs);
    timer.unref();
    return true;
  };
}

const loads = () => new Promise(resolve => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--check'], { stdio: 'ignore' });
  child.on('error', () => resolve(false));
  child.on('exit', code => resolve(code === 0));
});

export function control(action, statePaths = paths(), params = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(statePaths.socket);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Codex Remote control request timed out')); }, 35000);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...params, action })}\n`));
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
    socket.on('close', () => { clearTimeout(timer); if (!buffer.includes('\n')) reject(new Error('Codex Remote control closed without a response')); });
  });
}

export async function start() {
  const p = paths();
  try { return await control('status', p); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await mkdir(p.state, { recursive: true, mode: 0o700 });
  if ((await stat(p.log).catch(() => undefined))?.size > MAX_LOG) await rename(p.log, `${p.log}.1`).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
  throw new Error(`Codex Remote daemon did not start. See ${p.log}`);
}

async function serve() {
  const p = paths();
  await mkdir(p.state, { recursive: true, mode: 0o700 });
  await chmod(p.state, 0o700);
  const releaseLock = await acquireLock(p.state);
  const code = await codeVersion();
  // With `pi-agents` on PATH, saved sessions join their hosts instead of running a private Pi.
  const hosted = (process.env.PATH ?? '').split(':').some(dir => { try { accessSync(join(dir, 'pi-agents'), constants.X_OK); return true; } catch { return false; } });
  console.error(`${new Date().toISOString()} sessions ${hosted ? 'pi-agents hosts' : 'pi'}`);
  const sessions = new Sessions({ hosted: hosted ? { command: 'pi-agents' } : undefined });
  const protocol = new Protocol({ sessions, cwd: process.env.HOME, stateDir: p.state, onResponse: (request, error, result) => {
    const validation = [-32601, -32602].includes(error?.code) ? ` ${error.message}` : '';
    const threadId = request.params?.threadId ?? result?.thread?.id;
    const threadContext = typeof threadId === 'string' && /^[0-9a-f-]{36}$/i.test(threadId) ? ` thread:${threadId}` : '';
    console.error(`${new Date().toISOString()} ${request.method} ${error ? `error:${error.code ?? -32000}${validation}` : 'ok'}${threadContext}`);
  } });
  let requests = 0;
  // Pairing codes not yet used, until they expire; the daemon is not replaced while one is valid.
  const pairings = new Map();
  const remote = new Remote({ stateDir: p.state, handle: async (message, emit) => {
    if (message.id !== undefined) console.error(`${new Date().toISOString()} ${message.method}`);
    requests++;
    try { return await protocol.handle(message, emit); }
    finally { requests--; }
  }, disconnect: emit => protocol.disconnect(emit),
  onStatus: ({ status, error }) => console.error(`${new Date().toISOString()} remote ${status}${error ? ' error' : ''}`),
  });
  let server;
  let running;
  let stopping;
  let handingOver = false;
  let stopRequested = false;
  let retire = async () => false;
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
          const { action, ...params } = JSON.parse(buffer.slice(0, end));
          let result;
          if (action === 'status') result = { pid: process.pid, status: remote.status, error: remote.error, log: p.log, version: code };
          else if (action === 'retire') result = { retiring: await retire(params.version) };
          else if (action === 'pairStatus') {
            result = await remote.pairingStatus(params.pairingCode);
            if (result.claimed) pairings.delete(params.pairingCode);
          }
          else if (action === 'pair') {
            requests++;
            try { result = await remote.pair(); }
            finally { requests--; }
            pairings.set(result.pairingCode, Date.parse(result.expiresAt));
          }
          else if (action === 'stop') {
            stopRequested = true;
            result = { stopping: true };
          }
          else throw new Error(`Unknown Codex Remote command: ${action}`);
          socket.end(`${JSON.stringify({ result })}\n`);
          if (action === 'stop') socket.once('close', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
        })().catch(error => socket.end(`${JSON.stringify({ error: error.message })}\n`));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p.socket, resolve); });
    await chmod(p.socket, 0o600);
    running = remote.run();
    retire = createRetirement({
      initial: code,
      idle: () => !stopping && !requests && !protocol.active.size && [...pairings.values()].every(expiry => expiry <= Date.now()),
      loads,
      handover: () => {
        handingOver = true;
        void stop().catch(error => { console.error(error.message); process.exitCode = 1; });
      },
      log: message => console.error(`${new Date().toISOString()} ${message}`),
    });
    const onSignal = () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    await new Promise(resolve => server.once('close', resolve));
    await stopping;
  } finally {
    await protocol.close();
    await sessions.close();
    await remote.close();
    await unlink(p.socket).catch(ignoreMissing);
    releaseLock();
  }
  // A stop during the handover, by request or by `/codex-remote stop` clearing the flag, ends it.
  if (handingOver && !stopRequested && existsSync(p.enabled)) await start().catch(error => { console.error(`${new Date().toISOString()} ${error.message}`); process.exitCode = 1; });
}

// `--check` only loads the modules, to tell whether updated code can start.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && !process.argv.includes('--check')) {
  serve().catch(error => { console.error(`${new Date().toISOString()} ${error.message}`); process.exitCode = 1; });
}
