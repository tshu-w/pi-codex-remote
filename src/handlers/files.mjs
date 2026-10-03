export const filesHandlers = {
  async 'fs/createDirectory'(params, emit) { return this.attachments.createDirectory(params, emit); },
  async 'fs/writeFile'(params, emit) { return this.attachments.writeFile(params, emit); },
  async 'fs/readFile'(params, emit) { return this.attachments.readFile(params, emit); },
  async 'fs/readDirectory'(params, emit) { return this.attachments.readDirectory(params, emit); },
  async 'fs/copy'(params, emit) { return this.attachments.copy(params, emit); },
  async 'fs/getMetadata'(params, emit) { return this.attachments.getMetadata(params, emit); },
  async 'fs/remove'(params, emit) { return this.attachments.remove(params, emit); },
};
