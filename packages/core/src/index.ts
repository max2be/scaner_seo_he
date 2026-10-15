export interface RuleContext { url: string; serverHtml?: string; httpStatus?: number; }
export interface RuleResult { verdict: 'pass'|'finding'|'needs_review'|'not_applicable'|'scan_error'; evidence?: Record<string,unknown>; }
export interface Rule { id:string; version:string; detect(context:Readonly<RuleContext>):RuleResult|Promise<RuleResult>; }
// EPIC-05 implements actual rules. No network access at EPIC-01.
