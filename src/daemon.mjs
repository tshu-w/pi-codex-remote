import { createServer, createConnection } from 'node:net';
import { accessSync, constants, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { open, readFile, mkdir, unlink, chmod, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Remote, remotePaths } from './remote.mjs';
import { Sessions } from './sessions.mjs';
import { Protocol } from './protocol.mjs';

const MAX_LOG = 10 * 1024 * 1024;

export function paths() {
  const { state } = remotePaths();
  return { state, socket: join(state, 'control.sock'), lock: join(state, 'daemon.lock'), log: join(state, 'daemon.log') };
}

export function control(action, statePaths = paths()) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(statePaths.socket);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Codex Remote control request timed out')); }, 35000);
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
  let lock;
  try { lock = await open(p.lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(p.lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Codex Remote daemon lock; inspect it before restarting');
    try { process.kill(pid, 0); throw new Error('Codex Remote daemon is already running'); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await unlink(p.lock);
    lock = await open(p.lock, 'wx', 0o600);
  }
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();
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
  const remote = new Remote({ stateDir: p.state, handle: (message, emit) => {
    if (message.id !== undefined) console.error(`${new Date().toISOString()} ${message.method}`);
    return protocol.handle(message, emit);
  }, disconnect: emit => protocol.disconnect(emit),
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
          else throw new Error(`Unknown Codex Remote command: ${action}`);
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
