import { z } from 'zod';
import type { ProjectConfig } from '@hsi/contracts';
const httpsOrigin = z.string().max(2048).refine(value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    }
    catch {
        return false;
    }
});
export const CredentialOriginsSchema = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.array(httpsOrigin).min(1).max(16)).refine(v => Object.keys(v).length <= 100);
export function assertCredentialOrigin(project: ProjectConfig, bindings: Record<string, string[]>) {
    const backend = project.sources.backend;
    if (backend?.enabled && backend.auth?.type === 'bearer' && !bindings[backend.auth.tokenEnv]?.includes(new URL(backend.endpoint).origin))
        throw new Error('backend_credential_binding_required');
}
