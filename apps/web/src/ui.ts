import { readdirSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

export function registerUi(
  app: FastifyInstance,
  directory = fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
) {
  const publicPaths = new Set<string>();
  const serve = (url: string, file: string, mime: string) => {
    publicPaths.add(url);
    app.get(url, async (_request, reply) => {
      let handle;
      try {
        handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4194304) throw new Error('invalid_ui_asset');
        const content = await handle.readFile();
        reply.header(
          'content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
        );
        return reply.type(mime).send(content);
      } catch {
        return reply.code(503).send({ error: 'ui_unavailable' });
      } finally {
        await handle?.close();
      }
    });
  };
  serve('/', 'index.html', 'text/html; charset=utf-8');
  if (existsSync(join(directory, 'assets'))) {
    for (const name of readdirSync(join(directory, 'assets'))) {
      if (/^[a-zA-Z0-9_-]+\.(js|css)$/.test(name))
        serve(
          '/assets/' + name,
          'assets/' + name,
          name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        );
    }
  }
  return publicPaths;
}
