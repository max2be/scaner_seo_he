import { z } from 'zod';
import { httpUrl, timestamp } from './common.js';
import { HttpEvidenceSchema } from './scan.js';
export const HttpAttemptSchema = z.object({ url: httpUrl, timestamp,
  httpStatus: z.number().int().min(100).max(599).optional(), errorCode: z.string().max(100).optional(),
  ttfbMs: z.number().finite().nonnegative().optional(), totalMs: z.number().finite().nonnegative(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.httpStatus === undefined) === (value.errorCode === undefined))
    ctx.addIssue({ code: 'custom', message: 'Attempt requires exactly one of HTTP status or error code' });
});
const common = { robotsAttempts: z.array(HttpAttemptSchema).max(2000).default([]), attempts: z.array(HttpAttemptSchema).max(100), redirectChain: HttpEvidenceSchema.shape.redirectChain };
export const HttpFetchResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('fetched'), evidence: HttpEvidenceSchema, ...common }).strict(),
  z.object({ status: z.literal('skipped_robots'), requestedUrl: httpUrl, reason: z.literal('robots_disallowed'), ...common }).strict(),
  z.object({ status: z.literal('fetch_error'), requestedUrl: httpUrl.optional(), errorCode: z.string().max(100), ...common }).strict(),
]);
export type HttpFetchMetadata = z.infer<typeof HttpFetchResultSchema>;
export type HttpAttempt = z.infer<typeof HttpAttemptSchema>;
