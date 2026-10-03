import childProcess from 'node:child_process';
import { link, lstat, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { liveSessionsDir } from './live-sessions.mjs';

function execute(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
// Foundation returns the actual destination, including any collision rename.
// https://developer.apple.com/documentation/foundation/filemanager/trashitem(at:resultingitemurl:)
const trashScript = `
use framework "Foundation"
on run argv
  set sourceURL to current application's NSURL's fileURLWithPath:(item 1 of argv)
  set {ok, destinationURL, theError} to current application's NSFileManager's defaultManager()'s trashItemAtURL:sourceURL resultingItemURL:(reference) |error|:(reference)
  if not (ok as boolean) then error (theError's localizedDescription() as text)
  return destinationURL's |path|() as text
end run`;

export async function trashSession(path) {
  if (process.platform !== 'darwin') throw new Error('Session archive requires macOS Trash');
  const source = resolve(path);
  if (extname(source) !== '.jsonl' || !(await lstat(source)).isFile()) {
    throw new Error('Archive requires a regular JSONL session file; directories and symlinks are not allowed');
  }
  const stdout = await execute('/usr/bin/osascript', ['-l', 'AppleScript', '-e', trashScript, source]);
  // Remove only osascript's final newline; filenames can contain whitespace.
  return stdout.slice(0, -1);
}

// Caller supplies the recorded Trash path and original path, not arbitrary input.
export async function restoreSession(trashPath, originalPath) {
  const source = resolve(trashPath);
  const destination = resolve(originalPath);
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Trash item is missing; Trash may have been emptied. Recover the session from a backup', { cause: error });
    throw error;
  }
  if (!metadata.isFile() || extname(destination) !== '.jsonl') {
    throw new Error('Restore requires a regular file and a JSONL destination; directories and symlinks are not allowed');
  }
  const parent = await stat(dirname(destination));
  if (metadata.dev !== parent.dev) throw new Error('Cannot restore across volumes safely. Restore the Trash item manually to its original volume');
  try { await link(source, destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Original session path already exists. Move or rename that file before restoring; nothing was overwritten', { cause: error });
    if (error.code === 'EXDEV') throw new Error('Cannot restore across volumes safely. Restore the Trash item manually to its original volume', { cause: error });
    throw error;
  }
  // link is atomic and cannot replace even a dangling symlink at destination.
  try { await unlink(source); }
  catch (error) {
    throw new Error('Session was restored, but its Trash link could not be removed. Both paths may remain; check them before retrying', { cause: error });
  }
}

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(resolve(path))), basename(path));
  }
}

// A snapshot guard, not a lease: a Pi can start or switch sessions after it returns.
// Only matching live registrations establish occupancy; unregistered writers are not detectable.
export async function assertSessionNotOpen(path, { ignorePids = [] } = {}) {
  const target = await canonicalPath(path);
  const ignored = new Set(ignorePids);
  const uid = process.getuid();
  let commands;
  try {
    commands = await execute('/bin/ps', ['-axo', 'pid=,uid=,lstart=,comm='], { maxBuffer: 4 * 1024 * 1024, timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  } catch {
    throw new Error('Cannot inspect running Pi processes. Close local Pi sessions and retry archiving');
  }
  const processes = new Map();
  for (const line of commands.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\d{4})\s+(.+)$/);
    if (match && Number(match[2]) === uid && !ignored.has(Number(match[1]))) {
      processes.set(Number(match[1]), {
        processStart: match[3].trim().replace(/\s+/g, ' '),
      });
    }
  }
  const directory = liveSessionsDir();
  let files;
  try { files = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') files = [];
    else throw new Error('Live-session registry is unreadable. Fix its permissions and restart Pi before archiving');
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let record;
    try { record = JSON.parse(await readFile(join(directory, file), 'utf8')); }
    catch (error) {
      // A shutdown may remove its registry between readdir and readFile.
      if (error.code === 'ENOENT') continue;
      throw new Error('Live-session registry is invalid or unreadable. Restart Pi before archiving');
    }
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || (record.sessionFile !== null && (typeof record.sessionFile !== 'string' || !isAbsolute(record.sessionFile)))) {
      throw new Error('Invalid live-session registry record. Restart Pi before archiving');
    }
    const pid = record.pid;
    const running = processes.get(pid);
    // Old rows cannot authenticate a reused PID or describe its new session.
    if (!running || record.processStart !== running.processStart) continue;
    if (record.sessionFile !== null && await canonicalPath(record.sessionFile) === target) {
      throw new Error(`Session is open in Pi (PID ${pid}). Close that session before archiving or restoring`);
    }
  }
}
