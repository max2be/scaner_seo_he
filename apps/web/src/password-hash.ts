import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
export function parsePasswordHash(encoded: string) {
    const match = /^\$argon2id\$v=19\$m=(\d{1,6}),t=(\d),p=(\d)\$([A-Za-z0-9+/]{22,43})\$([A-Za-z0-9+/]{43,86})$/.exec(encoded);
    if (!match)
        throw new Error('invalid_password_hash');
    const memory = Number(match[1]), passes = Number(match[2]), parallelism = Number(match[3]);
    const nonce = Buffer.from(match[4]!, 'base64'), tag = Buffer.from(match[5]!, 'base64');
    if (memory < 65536 || memory > 131072 || passes < 2 || passes > 6 || parallelism < 1 || parallelism > 4 || nonce.length < 16 || nonce.length > 32 || tag.length < 32 || tag.length > 64 || nonce.toString('base64').replace(/=+$/, '') !== match[4] || tag.toString('base64').replace(/=+$/, '') !== match[5])
        throw new Error('unsafe_password_hash');
    return { memory, passes, parallelism, nonce, tag };
}
async function derive(password: string, params: ReturnType<typeof parsePasswordHash>) {
    const message = Buffer.from(password, 'utf8');
    try {
        return await new Promise<Buffer>((resolve, reject) => argon2('argon2id', { message, nonce: params.nonce, memory: params.memory, passes: params.passes, parallelism: params.parallelism, tagLength: params.tag.length }, (error, key) => error ? reject(error) : resolve(key)));
    }
    finally {
        message.fill(0);
    }
}
export async function verifyPassword(password: string, encoded: string) {
    const params = parsePasswordHash(encoded), actual = await derive(password, params);
    try {
        return timingSafeEqual(actual, params.tag);
    }
    finally {
        actual.fill(0);
    }
}
export async function hashPassword(password: string) {
    if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024)
        throw new Error('password_length');
    const nonce = randomBytes(16), tag = await derive(password, { memory: 65536, passes: 3, parallelism: 1, nonce, tag: Buffer.alloc(32) });
    return '$argon2id$v=19$m=65536,t=3,p=1$' + nonce.toString('base64').replace(/=+$/, '') + '$' + tag.toString('base64').replace(/=+$/, '');
}
