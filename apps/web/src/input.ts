import { z, type ZodTypeAny } from 'zod';
// Only schema field names are exposed. Dynamic record keys and submitted values stay private.
const fields = new Set(('id schemaVersion name baseUrl allowedHosts discovery sitemapUrls seedUrls crawlLinks maxDepth queryPolicy mode allowedKeys dropTrackingKeys maxUrls canonicalPolicy trailingSlash expectedScheme preferredHost checkSelfCanonical http userAgent respectRobots requestsPerSecondPerHost concurrency timeoutMs maxResponseBytes maxRedirects maxRetries sources backend enabled type endpoint auth tokenEnv pageSize reports keepLastRuns htmlEnabled scanSchedule cron timezone archived username password rules scanId severityOverrides maxRedirectHops checkTrailingSlash unknownRouteProbes url notFoundMarker config limit cursor sort severity ruleId verdict confidence source entityType httpStatus entityId urlContains operationId findingId otherId kind status').split(' '));
export class ApiInputError extends Error {
  constructor(readonly issues: { path: string; code: string }[]) { super('invalid_request'); }
}
/** Only request validation is400; malformed persisted data remains a safe500. */
export function parseInput<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiInputError(result.error.issues.slice(0, 20).map(issue => ({ path: (issue.path.map(v => typeof v === 'number' ? String(v) : fields.has(v) ? v : 'field').join('.') || '$').slice(0, 200), code: issue.code })));
  return result.data;
}
