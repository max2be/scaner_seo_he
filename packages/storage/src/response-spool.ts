import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResponseSpool } from '@hsi/contracts';
export class FileResponseSpool implements ResponseSpool {
  private constructor(private readonly directory: string) {}
  static async create(parent: string): Promise<FileResponseSpool> {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return new FileResponseSpool(await mkdtemp(join(parent, 'source-')));
  }
  async createSink() {
    const path = join(this.directory, 'body');
    const file = await open(path, 'w', 0o600); let closed = false;
    const close = async () => { if (!closed) { closed = true; await file.close(); } };
    return { write: async (chunk: Uint8Array) => { await file.writeFile(chunk); }, close,
      abort: async () => { await close(); await rm(path, { force: true }); } };
  }
  read() { return createReadStream(join(this.directory, 'body'), { highWaterMark: 16384 }); }
  async close() { await rm(this.directory, { recursive: true, force: true }); }
}
