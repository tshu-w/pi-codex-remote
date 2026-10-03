import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export function liveSessionsDir({ env = process.env, home = homedir() } = {}) {
  return join(env.XDG_STATE_HOME || join(home, '.local/state'), 'pi/codex-remote/live-sessions');
}

export function canonicalSessionFile(sessionFile) {
  if (sessionFile == null) return null;
  const absolute = resolve(sessionFile);
  // Pi creates the parent directory before session_start, but not necessarily the file.
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

export function createLiveSessionRegistry(options = {}) {
  const directory = liveSessionsDir(options);
  let marker;
  let processStart;
  return {
    register({ sessionFile, sessionId }) {
      const canonical = canonicalSessionFile(sessionFile);
      processStart ??= childProcess.execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      }).trim().replace(/\s+/g, ' ');
      const key = canonical ?? `ephemeral:${sessionId}`;
      const hash = createHash('sha256').update(key).digest('hex');
      const next = join(directory, `${process.pid}-${hash}.json`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const temporary = `${next}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, sessionFile: canonical, processStart })}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, next);
      } finally {
        rmSync(temporary, { force: true });
      }
      if (marker && marker !== next) rmSync(marker, { force: true });
      marker = next;
      return marker;
    },
    shutdown(reason) {
      if (!marker) return;
      // Reload transfers the same row to the new runtime without a protection gap.
      if (reason !== 'reload') rmSync(marker, { force: true });
      marker = undefined;
    },
  };
}
