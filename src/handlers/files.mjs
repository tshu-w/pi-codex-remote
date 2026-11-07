import { join } from 'node:path';

export const filesHandlers = {
  async 'fs/createDirectory'(params, emit) {
    const root = `${join(this.stateDir, 'visualizations')}/`;
    const match = typeof params.path === 'string' && params.path.startsWith(root)
      ? /^(\d{4})\/(\d{2})\/(\d{2})\/([0-9a-f-]{36})$/i.exec(params.path.slice(root.length)) : null;
    if (match && this.catalog.has(match[4])) {
      // Desktop skips optional visualization setup on a filesystem permission error.
      throw Object.assign(new Error('EACCES: Pi Remote does not expose visualization filesystem access.'), { code: -32000 });
    }
    return this.attachments.createDirectory(params, emit);
  },
  async 'fs/writeFile'(params, emit) { return this.attachments.writeFile(params, emit); },
  async 'fs/readFile'(params, emit) { return this.previews.contains(params.path) ? this.previews.readFile(params) : this.attachments.readFile(params, emit); },
  async 'fs/readDirectory'(params, emit) { return this.attachments.readDirectory(params, emit); },
  async 'fs/copy'(params, emit) { return this.attachments.copy(params, emit); },
  async 'fs/getMetadata'(params, emit) { return this.previews.contains(params.path) ? this.previews.getMetadata(params) : this.attachments.getMetadata(params, emit); },
  async 'fs/remove'(params, emit) { return this.attachments.remove(params, emit); },
};
