import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
export class StorageConflict extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string) { super(code); }
}
/** Linux local filesystem advisory lock. Never unlink lock files, including during cleanup. */
export class FileLease {
  private released = false;
  private alive = true;
  private lost?: () => void;
  onLost(callback: () => void) { this.lost = callback; this.assertHeld(); }
  private constructor(private child: ChildProcessWithoutNullStreams) {
    child.once('exit', () => { this.alive = false; if (!this.released) this.lost?.(); });
  }
  assertHeld() { if (!this.alive || this.released) throw new Error('storage_lock_lost'); }
  static async acquire(path: string): Promise<FileLease> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockFile = await open(path, 'a', 0o600); await lockFile.close();
    const child = spawn('/usr/bin/flock', ['-E', '73', '-n', path, process.execPath, '-e',
      "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('locked\\n');"], { stdio: 'pipe' });
    child.stdin.on('error', () => { /* exit handler owns the failure */ });
    return new Promise((resolve, reject) => {
      let ready = false;
      child.once('error', () => reject(new Error('flock_unavailable')));
      child.once('exit', code => { if (!ready) reject(code === 73 ? new StorageConflict('scan_busy') : new Error('flock_failed')); });
      child.stdout.once('data', () => { ready = true; resolve(new FileLease(child)); });
    });
  }
  async release() {
    if (this.released) return; this.released = true;
    if (!this.alive) return;
    await new Promise<void>(resolve => { this.child.once('exit', () => resolve()); this.child.stdin.end(); });
  }
}
