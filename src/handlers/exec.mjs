import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { invalid } from '../codex.mjs';

// Defaults match codex-rs core/src/exec.rs and utils/pty.
const defaultTimeoutMs = 10_000;
const defaultOutputCap = 1024 * 1024;
const timeoutExitCode = 124;
// Codex's default shell environment policy drops these from inherited variables.
const secretName = /KEY|SECRET|TOKEN/i;

// Commands run under the official Codex Seatbelt profiles through `codex sandbox`.
function sandboxProfile({ sandboxPolicy, permissionProfile }) {
  if (sandboxPolicy != null && permissionProfile != null) throw invalid('`permissionProfile` cannot be combined with `sandboxPolicy`');
  if (permissionProfile != null) {
    if (![':read-only', ':workspace'].includes(permissionProfile)) throw invalid('command/exec supports the :read-only and :workspace permission profiles.');
    return permissionProfile;
  }
  if (sandboxPolicy == null || sandboxPolicy.type === 'readOnly') {
    if (sandboxPolicy?.networkAccess) throw invalid('command/exec does not grant network access.');
    return ':read-only';
  }
  if (sandboxPolicy.type === 'workspaceWrite') {
    if (sandboxPolicy.networkAccess || sandboxPolicy.writableRoots?.length) throw invalid('command/exec workspaceWrite supports only the working directory, without network access.');
    return ':workspace';
  }
  throw invalid('command/exec requires a readOnly or workspaceWrite sandbox; unsandboxed commands are not supported.');
}

function environment(overrides) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !secretName.test(name)));
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value == null) delete env[name];
    else env[name] = value;
  }
  return env;
}

function nonNegative(value, name) {
  if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw invalid(`command/exec ${name} must be a non-negative integer.`);
  return value;
}

export const execHandlers = {
  async 'command/exec'(params, emit) {
    const { command, processId, tty, streamStdin, streamStdoutStderr, disableOutputCap, disableTimeout } = params;
    if (!Array.isArray(command) || !command.length || !command.every(part => typeof part === 'string')) throw invalid('command must be a non-empty string array.');
    if (tty || params.size != null) throw invalid('command/exec PTY mode is not supported.');
    if ((streamStdin || streamStdoutStderr) && typeof processId !== 'string') throw invalid('command/exec streaming requires a client-supplied processId');
    if (disableOutputCap && params.outputBytesCap != null) throw invalid('command/exec cannot set both outputBytesCap and disableOutputCap');
    if (disableTimeout && params.timeoutMs != null) throw invalid('command/exec cannot set both timeoutMs and disableTimeout');
    const cap = disableOutputCap ? Infinity : nonNegative(params.outputBytesCap, 'outputBytesCap') ?? defaultOutputCap;
    const timeoutMs = disableTimeout ? null : nonNegative(params.timeoutMs, 'timeoutMs') ?? defaultTimeoutMs;
    const profile = sandboxProfile(params);
    const cwd = resolve(this.cwd, params.cwd ?? '.');
    const processes = this.execProcesses.get(emit) ?? new Map();
    if (processId != null && processes.has(processId)) throw invalid(`command/exec processId ${JSON.stringify(processId)} is already running`);

    const child = spawn('codex', ['sandbox', '-P', profile, '-C', cwd, '--', ...command], {
      cwd, env: environment(params.env), detached: true, stdio: [streamStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const entry = { child, kill, streamStdin };
    if (processId != null) {
      processes.set(processId, entry);
      this.execProcesses.set(emit, processes);
    }
    const collect = stream => {
      const chunks = [];
      let size = 0;
      child[stream].on('data', chunk => {
        if (size >= cap) return;
        const kept = chunk.subarray(0, cap - size);
        size += kept.length;
        if (streamStdoutStderr) emit({ method: 'command/exec/outputDelta', params: { processId, stream, deltaBase64: kept.toString('base64'), capReached: size >= cap } });
        else chunks.push(kept);
      });
      return () => Buffer.concat(chunks).toString('utf8');
    };
    const stdout = collect('stdout');
    const stderr = collect('stderr');
    let timedOut = false;
    const timer = timeoutMs == null ? null : setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    try {
      const [code, signal] = await new Promise((done, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => done([code, signal]));
      });
      const exitCode = timedOut ? timeoutExitCode : code ?? 128 + (constants.signals[signal] ?? 0);
      return { exitCode, stdout: stdout(), stderr: stderr() };
    } finally {
      clearTimeout(timer);
      if (processes.get(processId) === entry) processes.delete(processId);
    }
  },
  async 'command/exec/write'({ processId, deltaBase64, closeStdin }, emit) {
    if (deltaBase64 == null && !closeStdin) throw invalid('command/exec/write requires deltaBase64 or closeStdin');
    const entry = this.execProcesses.get(emit)?.get(processId);
    if (!entry) throw invalid(`command/exec ${JSON.stringify(processId)} is no longer running`);
    if (!entry.streamStdin) throw invalid('stdin streaming is not enabled for this command/exec');
    if (entry.child.stdin.writableEnded) throw invalid('stdin is already closed');
    if (deltaBase64) await new Promise((done, fail) => entry.child.stdin.write(Buffer.from(deltaBase64, 'base64'), error => error ? fail(error) : done()));
    if (closeStdin) entry.child.stdin.end();
    return {};
  },
  async 'command/exec/terminate'({ processId }, emit) {
    const entry = this.execProcesses.get(emit)?.get(processId);
    if (!entry) throw invalid(`command/exec ${JSON.stringify(processId)} is no longer running`);
    entry.kill();
    return {};
  },
};
