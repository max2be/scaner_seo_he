import { createHash } from 'node:crypto';
import { open, constants } from 'node:fs/promises';
import { z } from 'zod';
import { DiscoveryIssueSchema, ScanDiagnosticsPageSchema } from '@hsi/contracts';
import { safeDataPath, StorageConflict } from '@hsi/storage';
const cursorSchema = z
  .object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative().safe() })
  .strict();
export async function readDiagnostics(
  dataDir: string,
  id: string,
  scanId: string,
  query: { limit: number; cursor?: string | undefined },
) {
  const path = await safeDataPath(dataDir, 'projects', id, 'scans', scanId, 'scanner_errors.jsonl');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('invalid_diagnostics');
    const snapshot = createHash('sha256')
      .update(JSON.stringify([id, scanId, info.ino, info.size, info.mtimeMs]))
      .digest('hex');
    let offset = 0;
    if (query.cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      } catch {
        throw new StorageConflict('invalid_cursor');
      }
      const parsed = cursorSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.snapshot !== snapshot || parsed.data.offset > info.size)
        throw new StorageConflict('invalid_cursor');
      offset = parsed.data.offset;
      if (offset) {
        const previous = Buffer.alloc(1);
        await file.read(previous, 0, 1, offset - 1);
        if (previous[0] !== 10) throw new StorageConflict('invalid_cursor');
      }
    }
    const buffer = Buffer.alloc(Math.min(262144, info.size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const items = [];
    let consumed = 0;
    while (consumed < bytesRead && items.length < query.limit) {
      const end = buffer.indexOf(10, consumed);
      if (end === -1 || end >= bytesRead) {
        if (!consumed) throw new Error('invalid_diagnostics_record');
        break;
      }
      items.push(DiscoveryIssueSchema.parse(JSON.parse(buffer.subarray(consumed, end).toString('utf8'))));
      consumed = end + 1;
    }
    const nextCursor =
      offset + consumed < info.size
        ? Buffer.from(JSON.stringify({ snapshot, offset: offset + consumed })).toString('base64url')
        : null;
    return ScanDiagnosticsPageSchema.parse({ schemaVersion: '1.0', items, nextCursor });
  } finally {
    await file.close();
  }
}
