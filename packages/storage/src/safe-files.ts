import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
export const isMissing = (e: unknown) => Boolean(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT');
/** API paths contain only validated IDs and fixed names. Never follow links under DATA_DIR. */
export async function safeDataPath(root: string, ...parts: string[]) {
    const base = resolve(root), path = resolve(base, ...parts), rel = relative(base, path);
    if (rel.startsWith('..') || rel.startsWith(sep))
        throw new Error('unsafe_storage_path');
    let current = base;
    for (const part of rel.split(sep).filter(Boolean)) {
        current = join(current, part);
        try {
            if ((await lstat(current)).isSymbolicLink())
                throw new Error('unsafe_storage_link');
        }
        catch (e) {
            if (isMissing(e))
                break;
            throw e;
        }
    }
    // Resolving the trusted root permits an operator-mounted DATA_DIR without permitting child links.
    const canonical = await realpath(base);
    void canonical;
    return path;
}
export async function readSmallJson(root: string, parts: string[], maximum = 2097152): Promise<unknown> {
    const path = await safeDataPath(root, ...parts), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maximum)
            throw new Error('invalid_storage_file');
        return JSON.parse(await file.readFile('utf8'));
    }
    finally {
        await file.close();
    }
}
