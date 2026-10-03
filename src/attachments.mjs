import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';

const invalid = message => Object.assign(new Error(message), { code: -32602 });
const maxImageBytes = 20 * 1024 * 1024;
const lifetime = 30 * 60 * 1000;

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw invalid('Attachments must contain PNG, JPEG, GIF or WebP image data.');
}

// Client paths are opaque cache keys, never host filesystem destinations.
export class Attachments {
  constructor({ stateDir, now = Date.now, maxBytes = 100 * 1024 * 1024, maxDirectories = 64, maxFiles = 128 }) {
    this.roots = [...new Set(['/tmp', '/private/tmp', tmpdir(), join(stateDir, 'attachments')].map(normalize))];
    this.now = now;
    this.maxBytes = maxBytes;
    this.maxDirectories = maxDirectories;
    this.maxFiles = maxFiles;
    this.directories = new Map();
  }

  path(value) {
    if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || /[\x00-\x1f\x7f\\%]/.test(value) || normalize(value) !== value || value.endsWith('/') || !this.roots.some(root => value.startsWith(`${root}/`))) {
      throw invalid('Attachment paths must be normalized absolute paths inside a temporary directory or the bridge attachments directory.');
    }
    return value;
  }

  prune() {
    const now = this.now();
    for (const [path, directory] of this.directories) if (directory.expiresAt <= now) this.directories.delete(path);
    if (!this.directories.size) { clearInterval(this.timer); this.timer = undefined; }
  }

  directory(path, owner) {
    this.prune();
    const directory = this.directories.get(path);
    if (!directory || directory.owner !== owner) throw invalid('Attachment directory is unavailable. Select and upload the image again.');
    return directory;
  }

  file(path, owner) {
    const directory = this.directory(dirname(path), owner);
    const file = directory.files.get(path);
    if (!file) throw invalid('Attachment is unavailable. Select and upload the image again.');
    return file;
  }

  createDirectory(params, owner) {
    const path = this.path(params.path);
    if (params.recursive != null && typeof params.recursive !== 'boolean') throw invalid('recursive must be a boolean.');
    this.prune();
    if (this.directories.has(path)) { this.directory(path, owner); return {}; }
    for (const [key, directory] of this.directories) {
      if (directory.owner !== owner && (path.startsWith(`${key}/`) || key.startsWith(`${path}/`))) throw invalid('Attachment directory belongs to another Remote stream.');
      for (const file of directory.files.keys()) if (path === file || path.startsWith(`${file}/`)) throw invalid('Attachment directory path contains an uploaded file.');
    }
    if (params.recursive === false && !this.roots.includes(dirname(path)) && !this.getMetadata({ path: dirname(path) }, owner).isDirectory) throw invalid('Attachment parent is not a directory.');
    if (this.directories.size >= this.maxDirectories) throw invalid('Attachment directory limit reached. Remove unused uploads or wait for them to expire.');
    const now = this.now();
    this.directories.set(path, { owner, createdAtMs: now, modifiedAtMs: now, expiresAt: now + lifetime, files: new Map() });
    this.timer ??= setInterval(() => this.prune(), 60_000).unref();
    return {};
  }

  writeFile(params, owner) {
    const path = this.path(params.path);
    const directory = this.directory(dirname(path), owner);
    if ([...this.directories.keys()].some(key => key === path || key.startsWith(`${path}/`))) throw invalid('Attachment path is a directory.');
    const data = params.dataBase64;
    if (typeof data !== 'string' || !data.length || data.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalid('Invalid or oversized attachment base64 (maximum 20 MiB per image).');
    const bytes = Buffer.from(data, 'base64');
    const canonical = bytes.toString('base64');
    if (!bytes.length || bytes.length > maxImageBytes || data !== canonical && data !== canonical.replace(/=+$/, '')) throw invalid('Invalid or oversized attachment base64 (maximum 20 MiB per image).');
    const mimeType = imageMime(bytes);
    let total = 0;
    let count = 0;
    for (const group of this.directories.values()) for (const file of group.files.values()) { total += file.bytes; count++; }
    const previous = directory.files.get(path);
    if (total - (previous?.bytes ?? 0) + bytes.length > this.maxBytes || !previous && count >= this.maxFiles) throw invalid('Attachment cache is full. Remove unused uploads or wait for them to expire.');
    const now = this.now();
    directory.files.set(path, { data: canonical, mimeType, bytes: bytes.length, createdAtMs: previous?.createdAtMs ?? now, modifiedAtMs: now });
    directory.modifiedAtMs = now;
    directory.expiresAt = now + lifetime;
    return {};
  }

  readFile(params, owner) {
    return { dataBase64: this.file(this.path(params.path), owner).data };
  }

  copy(params, owner) {
    const sourcePath = this.path(params.sourcePath);
    const destinationPath = this.path(params.destinationPath);
    if (params.recursive !== undefined && typeof params.recursive !== 'boolean') throw invalid('recursive must be a boolean.');
    if (this.getMetadata({ path: sourcePath }, owner).isDirectory) throw invalid('Attachment copy supports image files only; directory copies are unsupported.');
    if (sourcePath === destinationPath) throw invalid('Attachment source and destination must be different files.');
    const file = this.file(sourcePath, owner);
    return this.writeFile({ path: destinationPath, dataBase64: file.data }, owner);
  }

  readDirectory(params, owner) {
    const path = this.path(params.path);
    this.prune();
    const directory = this.directories.has(path) ? this.directory(path, owner) : undefined;
    const children = [...this.directories].filter(([key, value]) => value.owner === owner && key.startsWith(`${path}/`)).map(([key]) => key);
    if (!directory && !children.length) throw invalid('Attachment directory is unavailable. Select and upload the image again.');
    const entries = new Map();
    for (const file of directory?.files.keys() ?? []) {
      const fileName = file.slice(path.length + 1);
      entries.set(fileName, { fileName, isDirectory: false, isFile: true });
    }
    for (const child of children) {
      const fileName = child.slice(path.length + 1).split('/')[0];
      entries.set(fileName, { fileName, isDirectory: true, isFile: false });
    }
    return { entries: [...entries.values()].sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0) };
  }

  getMetadata(params, owner) {
    const path = this.path(params.path);
    this.prune();
    const children = [...this.directories.keys()].filter(key => key.startsWith(`${path}/`));
    const isDirectory = this.directories.has(path) || children.length > 0;
    let entry;
    if (this.directories.has(path)) entry = this.directory(path, owner);
    else if (children.length) {
      const entries = children.map(key => this.directory(key, owner));
      entry = { createdAtMs: Math.min(...entries.map(value => value.createdAtMs)), modifiedAtMs: Math.max(...entries.map(value => value.modifiedAtMs)) };
    } else entry = this.file(path, owner);
    return { isDirectory, isFile: !isDirectory, isSymlink: false, createdAtMs: entry.createdAtMs, modifiedAtMs: entry.modifiedAtMs };
  }

  remove(params, owner) {
    const path = this.path(params.path);
    for (const key of ['recursive', 'force']) if (params[key] != null && typeof params[key] !== 'boolean') throw invalid(`${key} must be a boolean.`);
    this.prune();
    const directory = this.directories.get(path);
    const children = [...this.directories.keys()].filter(key => key.startsWith(`${path}/`));
    if (directory || children.length) {
      if (directory) this.directory(path, owner);
      for (const child of children) this.directory(child, owner);
      if (params.recursive === false && (directory?.files.size || children.length)) throw invalid('Attachment directory is not empty.');
      for (const child of children) this.directories.delete(child);
      this.directories.delete(path);
    } else {
      const parent = this.directories.get(dirname(path));
      if (parent) this.directory(dirname(path), owner);
      if (!parent?.files.delete(path) && params.force === false) throw invalid('Attachment is unavailable.');
    }
    this.prune();
    return {};
  }

  image(path, owner) {
    const file = this.file(this.path(path), owner);
    return { type: 'image', url: `data:${file.mimeType};base64,${file.data}` };
  }

  disconnect(owner) {
    for (const [path, directory] of this.directories) if (directory.owner === owner) this.directories.delete(path);
    this.prune();
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.directories.clear();
  }
}
