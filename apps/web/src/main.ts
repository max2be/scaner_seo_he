import { z } from 'zod';
import { checkDataDirectory } from '@hsi/storage';
import { buildApp } from './app.js';
try {
    const config = z.object({ DATA_DIR: z.string().min(1).default('./data'), HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
        PORT: z.coerce.number().int().min(1).max(65535).default(3000), JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
        ADMIN_PASSWORD_HASH: z.string().optional(), PUBLIC_ORIGIN: z.string().optional(), BACKEND_CREDENTIAL_ORIGINS: z.string().default('{}') }).parse(process.env);
    if (Boolean(config.ADMIN_PASSWORD_HASH) !== Boolean(config.PUBLIC_ORIGIN))
        throw new Error('partial_auth_configuration');
    await checkDataDirectory(config.DATA_DIR);
    const app = buildApp(config.DATA_DIR, { concurrency: config.JOB_CONCURRENCY, backendCredentialOrigins: JSON.parse(config.BACKEND_CREDENTIAL_ORIGINS || '{}'), ...(config.ADMIN_PASSWORD_HASH && config.PUBLIC_ORIGIN ? { auth: { passwordHash: config.ADMIN_PASSWORD_HASH, publicOrigin: config.PUBLIC_ORIGIN } } : {}) });
    await app.listen({ host: config.HOST, port: config.PORT });
    console.log(JSON.stringify({ event: 'started', service: 'web', stage: 'M6', authenticationConfigured: Boolean(config.ADMIN_PASSWORD_HASH) }));
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.once(signal, () => {
            void app.close().then(() => {
                process.exitCode = 0;
            }).catch(() => {
                process.exitCode = 1;
            });
        });
}
catch {
    console.error(JSON.stringify({ event: 'startup_failed', service: 'web' }));
    process.exitCode = 1;
}
