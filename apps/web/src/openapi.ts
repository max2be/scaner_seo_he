import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ApiErrorSchema, LoginSchema, SessionViewSchema } from '@hsi/contracts';
const json = (schema: ZodTypeAny) => zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
export interface ApiSpec {
    summary: string;
    body?: ZodTypeAny;
    query?: ZodTypeAny;
    response: ZodTypeAny;
    status?: number;
    binary?: boolean;
    contentType?: string;
}
export function apiDocument() {
    const paths: Record<string, Record<string, unknown>> = {};
    function add(method: string, path: string, spec: ApiSpec, authenticated = true) {
        const parameters: unknown[] = [...path.matchAll(/:([A-Za-z]+)/g)].map(m => ({ in: 'path', name: m[1], required: true, schema: { type: 'string', maxLength: 100 } }));
        if (spec.query instanceof z.ZodObject)
            for (const [key, schema] of Object.entries(spec.query.shape))
                parameters.push({ in: 'query', name: key, required: false, schema: json(schema as ZodTypeAny) });
        if (authenticated && !['get', 'head'].includes(method))
            parameters.push({ in: 'header', name: 'X-CSRF-Token', required: true, schema: { type: 'string' } });
        if (!['get', 'head'].includes(method))
            parameters.push({ in: 'header', name: 'Origin', required: true, schema: { type: 'string', format: 'uri' } });
        const responses: Record<string, unknown> = {};
        responses[spec.status ?? 200] = { description: spec.status === 202 ? 'Queued; poll operation or scan' : 'Success', ...(spec.status === 204 ? {} : { content: { [spec.contentType ?? 'application/json']: { schema: spec.binary ? { type: 'string', format: 'binary' } : json(spec.response) } } }) };
        for (const code of [400, 401, 403, 404, 409, 413, 415, 429, 500, 503])
            responses[code] = { description: 'Safe error; no credentials or request values', content: { 'application/json': { schema: json(ApiErrorSchema) } } };
        const key = path.replace(/:([A-Za-z]+)/g, '{$1}');
        paths[key] ??= {};
        paths[key]![method] = { summary: spec.summary, security: authenticated ? [{ cookieAuth: [] }] : [], parameters, ...(spec.body ? { requestBody: { required: false, content: { 'application/json': { schema: json(spec.body) } } } } : {}), responses };
    }
    add('get', '/api/health', { summary: 'Minimal public storage readiness', response: z.object({ status: z.enum(['ok','unavailable']) }).strict() }, false);
    add('post', '/api/auth/login', { summary: 'Admin login; Origin required, rate limited', body: LoginSchema, response: SessionViewSchema }, false);
    add('post', '/api/auth/logout', { summary: 'Revoke session', response: z.null(), status: 204 });
    add('get', '/api/me', { summary: 'Current admin, CSRF token and expiry', response: SessionViewSchema });
    return { add, document: () => ({ openapi: '3.0.3', info: { title: 'Headless SEO Inspector private API', version: '1.0.0', description: 'Single admin. All writes require matching Origin and CSRF. Credentials belong only in server environment. GET never generates reports. Full UI is EPIC-08.' }, paths, components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: '__Host-hsi_session' } } } }) };
}
