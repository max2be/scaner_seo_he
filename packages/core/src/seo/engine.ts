import { FindingSchema, RuleResultSchema, RuleProfileSchema, AnalysisErrorSchema, type AnalysisError } from '@hsi/contracts';
import type { Rule, RuleContext, RuleResult } from '../index.js';
import { seoRules, p0Allowed, findingId } from './rules.js';
export interface RuleEvaluation { ruleId: string; result: RuleResult }
export interface EngineResult { evaluations: RuleEvaluation[]; errors: AnalysisError[] }
export function validateRuleProfile(input: unknown) {
  const profile = RuleProfileSchema.parse(input); const ids = new Set(seoRules.map(rule => rule.id));
  if (Object.keys(profile.severityOverrides).some(id => !ids.has(id))) throw new Error('unknown_rule_override'); return profile;
}
export class RuleEngine {
  constructor(private readonly rules: readonly Rule[] = seoRules) {
    if (new Set(rules.map(r => r.id)).size !== rules.length) throw new Error('duplicate_rule_id');
  }
  async evaluate(context: RuleContext): Promise<EngineResult> {
    const evaluations: RuleEvaluation[] = []; const errors: AnalysisError[] = [];
    const error = (code: string, ruleId?: string) => errors.push(AnalysisErrorSchema.parse({ schemaVersion: '1.0', code, url: context.url.normalizedUrl, ...(ruleId ? { ruleId } : {}) }));
    if (context.analysis?.observation.result.status === 'fetch_error' && context.analysis.observation.result.errorCode !== 'redirect_loop') error('page_fetch_unavailable');
    for (const check of context.analysis?.observation.checks ?? []) {
      if ((check.result.status === 'fetch_error' && check.result.errorCode !== 'redirect_loop') || (check.result.status === 'fetched' && (check.result.evidence.httpStatus >= 500 || [401, 403, 429].includes(check.result.evidence.httpStatus)))) error('diagnostic_fetch_unavailable');
    }
    if (context.analysis?.observation.facts?.truncated) error('html_analysis_limit_or_encoding');
    for (const rule of this.rules) {
      try {
        const result = RuleResultSchema.parse(rule.appliesTo(context) ? await rule.detect(context) : { verdict: 'not_applicable' }) as RuleResult;
        if (result.verdict === 'finding' || result.verdict === 'needs_review') {
          FindingSchema.parse(result.finding);
          if (result.finding.id !== findingId(context, rule.id) || result.finding.ruleId !== rule.id || result.finding.projectId !== context.project.id || result.finding.scanId !== context.url.scanId) throw new Error('rule_result_identity_mismatch');
          if (result.finding.severity === 'P0' && !p0Allowed(context, rule.id)) result.finding.severity = 'P1';
        }
        if (result.verdict === 'scan_error') error('rule_scan_error', rule.id);
        evaluations.push({ ruleId: rule.id, result });
      } catch { error('rule_execution_failed', rule.id); evaluations.push({ ruleId: rule.id, result: { verdict: 'scan_error', code: 'rule_execution_failed' } }); }
    }
    return { evaluations, errors };
  }
}
