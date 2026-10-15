import type { Entity, Finding, ProjectConfig, UrlRecord } from '@hsi/contracts';
export interface RuleContext { project: ProjectConfig; url: UrlRecord; entity?: Entity }
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
