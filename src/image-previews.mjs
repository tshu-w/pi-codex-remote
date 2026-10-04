import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { invalid } from './codex.mjs';

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const imageKey = new RegExp(`^(${uuid})/[a-f0-9]{64}\\.(?:png|jpg|gif|webp)$`);

// Virtual files backed by session image blocks; no image bytes are written to disk.
export class ImagePreviews {
  constructor({ stateDir, loadEntries, maxBytes = 64 * 1024 * 1024 }) {
    this.root = `${join(resolve(stateDir), 'session-images')}/`;
    this.loadEntries = loadEntries;
    this.maxBytes = maxBytes;
    this.cache = new Map();
    this.bytes = 0;
  }

  contains(path) {
    return typeof path === 'string' && path.startsWith(this.root);
  }

  path(block, threadId) {
    const extension = extensions[block.mimeType];
    if (!extension) throw invalid(`Unsupported image preview type: ${block.mimeType}`);
    const hash = createHash('sha256').update(block.data, 'base64').digest('hex');
    return `${this.root}${threadId}/${hash}.${extension}`;
  }

  remember(path, data) {
    const previous = this.cache.get(path);
    if (previous !== undefined) { this.bytes -= previous.length * 2; this.cache.delete(path); }
    const size = data.length * 2;
    if (size <= this.maxBytes) {
      while (this.cache.size >= 128 || this.bytes + size > this.maxBytes) {
        const key = this.cache.keys().next().value;
        this.bytes -= this.cache.get(key).length * 2;
        this.cache.delete(key);
      }
      this.cache.set(path, data);
      this.bytes += size;
    }
    return data;
  }

  image(block, threadId) {
    const path = this.path(block, threadId);
    this.remember(path, block.data);
    return { type: 'localImage', path };
  }

  async read(path) {
    const key = this.contains(path) ? path.slice(this.root.length) : '';
    const match = imageKey.exec(key);
    if (!match || match[0] !== key) throw invalid('Invalid session image path.');
    const cached = this.cache.get(path);
    if (cached !== undefined) return this.remember(path, cached);
    const entries = await this.loadEntries(match[1]);
    for (const entry of entries) {
      if (entry.message?.role !== 'user' || !Array.isArray(entry.message.content)) continue;
      for (const block of entry.message.content) {
        if (block.type === 'image' && this.path(block, match[1]) === path) return this.remember(path, block.data);
      }
    }
    throw invalid('Image not found in this session.');
  }

  async readFile({ path }) {
    return { dataBase64: await this.read(path) };
  }

  async getMetadata({ path }) {
    await this.read(path);
    return { isDirectory: false, isFile: true, isSymlink: false, createdAtMs: 0, modifiedAtMs: 0 };
  }

  close() {
    this.cache.clear();
    this.bytes = 0;
  }
}
