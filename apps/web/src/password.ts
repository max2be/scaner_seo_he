import { hashPassword } from './password-hash.js';
// Read a local pipe, never command arguments/environment or interactive echoed input.
try {
    if (process.stdin.isTTY)
        throw new Error('use_stdin_pipe');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 1026)
            throw new Error('password_length');
        chunks.push(Buffer.from(chunk));
    }
    const input = Buffer.concat(chunks);
    const password = input.toString('utf8').replace(/\r?\n$/, '');
    input.fill(0);
    for (const chunk of chunks)
        chunk.fill(0);
    process.stdout.write(await hashPassword(password) + '\n');
}
catch {
    console.error('password_hash_failed');
    process.exitCode = 1;
}
