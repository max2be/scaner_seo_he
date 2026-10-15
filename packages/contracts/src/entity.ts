import { z } from 'zod';
import { entityType, httpUrl, schemaVersion, timestamp } from './common.js';
export const EntitySchema = z.object({
  id: z.string().min(1).max(200), type: entityType, url: httpUrl,
  publicationState: z.enum(['published', 'unpublished', 'deleted', 'redirected', 'unknown']),
  expectedIndexable: z.boolean().optional(), expectedStatus: z.number().int().min(100).max(599).optional(),
  canonicalUrl: httpUrl.optional(), redirectTargetUrl: httpUrl.optional(), updatedAt: timestamp.optional(),
  data: z.object({ title: z.string().max(2000).optional(), sku: z.string().max(200).optional(),
    price: z.number().finite().nonnegative().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    availability: z.string().max(100).optional() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.publicationState === 'redirected' && !value.redirectTargetUrl)
    ctx.addIssue({ code: 'custom', path: ['redirectTargetUrl'], message: 'Redirected entity requires target' });
});
export const EntityFeedSchema = z.object({ schemaVersion, snapshotId: z.string().min(1).max(200).optional(),
  items: z.array(EntitySchema).max(10000), nextCursor: z.string().min(1).max(4096).nullable(),
}).strict().superRefine((value, ctx) => {
  const keys = value.items.map(entity => JSON.stringify([entity.type, entity.id]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate entity identities' });
});
export type Entity = z.infer<typeof EntitySchema>;
export type EntityFeed = z.infer<typeof EntityFeedSchema>;
