import { z } from 'zod';
import { httpUrl, nonnegative, schemaVersion, severity } from './common.js';
import { HttpFetchResultSchema } from './http.js';
import { FindingSchema } from './finding.js';
export const RuleProfileSchema = z.object({ schemaVersion,
  severityOverrides: z.record(z.string().regex(/^[A-Z][A-Z0-9_]+$/), severity).default({}),
  maxRedirectHops: z.number().int().min(0).max(20).default(2),
  checkTrailingSlash: z.boolean().default(true),
  unknownRouteProbes: z.array(z.object({ url: httpUrl,
    notFoundMarker: z.string().trim().min(1).max(1000).optional() }).strict()).max(20).default([]),
}).strict();
export const defaultRuleProfile = () => RuleProfileSchema.parse({ schemaVersion: '1.0' });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ProductFactsSchema = z.object({ path: z.string().max(1000), sku: z.string().max(200).optional(),
  url: httpUrl.optional(), namePresent: z.boolean(),
  rating: z.object({ hasValue: z.boolean(), value: z.number().finite().optional(),
    countState: z.enum(['missing', 'invalid', 'valid']) }).strict().optional(),
  offers: z.array(z.object({ path: z.string().max(1000), kind: z.enum(['Offer', 'AggregateOffer']),
    price: z.number().finite().nonnegative().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    availability: z.enum(['in_stock', 'out_of_stock', 'preorder', 'backorder', 'discontinued', 'unknown']).optional(),
  }).strict()).max(100),
}).strict();
export const HtmlFactsSchema = z.object({ schemaVersion,
  titlePresent: z.boolean(), titleHash: hash.optional(), descriptionPresent: z.boolean(), h1Count: nonnegative,
  noindex: z.boolean(), noindexSources: z.array(z.enum(['meta', 'http'])).max(2), nofollow: z.boolean(), canonicalInvalid: nonnegative,
  canonicals: z.array(z.object({ url: httpUrl, absolute: z.boolean(), fragment: z.boolean() }).strict()).max(16),
  duplicateIdCount: nonnegative, manifestCount: nonnegative, anchorWithoutHrefCount: nonnegative,
  buttonNavCount: nonnegative, imageMissingAltCount: nonnegative, imageMissingSizeCount: nonnegative,
  contentCharacters: nonnegative, soft404Signal: z.boolean(), markerMatched: z.boolean(),
  jsonLdParseErrors: nonnegative, products: z.array(ProductFactsSchema).max(100),
  truncated: z.boolean(),
}).strict();
export const DiagnosticCheckSchema = z.object({ kind: z.enum(['canonical', 'trailing_slash']), target: httpUrl,
  result: HttpFetchResultSchema }).strict();
export const PageObservationSchema = z.object({ schemaVersion, url: httpUrl, responseIdentity: hash.optional(), result: HttpFetchResultSchema,
  facts: HtmlFactsSchema.optional(), checks: z.array(DiagnosticCheckSchema).max(2),
  duplicateTitleEligible: z.boolean(),
}).strict();
export const TitleGroupSchema = z.object({ schemaVersion, titleHash: hash, anchorUrl: httpUrl,
  otherUrl: httpUrl.optional(), count: nonnegative }).strict();
export const AnalysisErrorSchema = z.object({ schemaVersion, code: z.string().regex(/^[a-z0-9_]+$/),
  url: httpUrl, ruleId: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional() }).strict();
export const AnalysisProgressSchema = z.object({ phase: z.enum(['pending', 'running', 'done']), offset: nonnegative,
  urlsAnalyzed: nonnegative, rulesEvaluated: nonnegative, findings: nonnegative, needsReview: nonnegative, errors: nonnegative,
}).strict().superRefine((v, ctx) => {
  if (v.offset !== v.urlsAnalyzed * 67) ctx.addIssue({ code: 'custom', message: 'Analysis offset disagrees with URL count' });
});
export const AnalysisSummarySchema = z.object({ schemaVersion, engineVersion: z.literal('1.0.0'),
  urlsAnalyzed: nonnegative, rulesEvaluated: nonnegative, findings: nonnegative, needsReview: nonnegative,
  errors: nonnegative, coverageComplete: z.boolean(),
}).strict().superRefine((v, ctx) => { if (v.errors && v.coverageComplete) ctx.addIssue({ code: 'custom', message: 'Analysis errors cannot claim full coverage' }); });
export const AnalysisEventSchema = z.discriminatedUnion('op', [
  z.object({ schemaVersion: z.literal('1.1'), op: z.literal('observation'), value: PageObservationSchema }).strict(),
  z.object({ schemaVersion: z.literal('1.1'), op: z.literal('finding'), value: FindingSchema }).strict(),
  z.object({ schemaVersion: z.literal('1.1'), op: z.literal('analysis_error'), value: AnalysisErrorSchema }).strict(),
  z.object({ schemaVersion: z.literal('1.1'), op: z.literal('analysis_summary'), value: AnalysisSummarySchema }).strict(),
]);
export type RuleProfile = z.infer<typeof RuleProfileSchema>;
export type HtmlFacts = z.infer<typeof HtmlFactsSchema>;
export type ProductFacts = z.infer<typeof ProductFactsSchema>;
export type PageObservation = z.infer<typeof PageObservationSchema>;
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;
export type TitleGroup = z.infer<typeof TitleGroupSchema>;
export type AnalysisError = z.infer<typeof AnalysisErrorSchema>;
export type AnalysisProgress = z.infer<typeof AnalysisProgressSchema>;
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;
export const RuleResultSchema = z.union([
  z.object({ verdict: z.enum(['pass', 'not_applicable']) }).strict(),
  z.object({ verdict: z.literal('finding'), finding: FindingSchema }).strict().refine(v => v.finding.verdict === 'finding', 'Finding verdict must agree'),
  z.object({ verdict: z.literal('needs_review'), finding: FindingSchema }).strict().refine(v => v.finding.verdict === 'needs_review', 'Finding verdict must agree'),
  z.object({ verdict: z.literal('scan_error'), code: z.string().regex(/^[a-z0-9_]+$/).max(100) }).strict(),
]);
