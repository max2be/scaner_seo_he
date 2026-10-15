import type { Entity, Finding, ProjectConfig, UrlRecord } from '@hsi/contracts';
import type { AnalysisContext } from './seo/context.js';
export interface RuleContext { project: ProjectConfig; url: UrlRecord; entity?: Entity; analysis?: AnalysisContext }
export type RuleResult =
  | { verdict: 'pass' | 'not_applicable' }
  | { verdict: 'finding'; finding: Finding & { verdict: 'finding' } }
  | { verdict: 'needs_review'; finding: Finding & { verdict: 'needs_review' } }
  | { verdict: 'scan_error'; code: string };
export interface Rule {
  readonly id: string;
  readonly version: string;
  readonly severityDefault: Finding['severity'];
  readonly recommendationKey: string;
  appliesTo(context: RuleContext): boolean;
  detect(context: RuleContext): Promise<RuleResult>;
}
export { SafeHttpClient, retryDelay, type HttpFetchResult } from './http/client.js';
export type { BodySink, BodySinkFactory } from './http/transport.js';
export { RuleEngine, validateRuleProfile, type EngineResult, type RuleEvaluation } from './seo/engine.js';
export { seoRules, findingId, normalizedTarget, expectedIndexable, trustedEntity } from './seo/rules.js';
export type { AnalysisContext } from './seo/context.js';
