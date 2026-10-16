import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
const eslint = new ESLint({ cwd: process.cwd() });
async function ruleIds(code: string) {
  const [result] = await eslint.lintText(code, { filePath: 'packages/core/src/style-fixture.ts' });
  return result!.messages.map(message => message.ruleId);
}
describe('Repository declaration conventions', () => {
  it('rejects local variable references before their declarations', async () => {
    expect(await ruleIds('export function f() { return value; const value = 1; }')).toContain('@typescript-eslint/no-use-before-define');
  });
  it('requires const for values that never change', async () => {
    expect(await ruleIds('export function f() { let value = 1; return value; }')).toContain('prefer-const');
  });
  it('keeps class fields above constructors, methods and accessors', async () => {
    for (const code of ['export class Example { method() { return this.value; } value = 1; }', 'export class Example { get current() { return this.value; } value = 1; }']) {
      expect(await ruleIds(code)).toContain('@typescript-eslint/member-ordering');
    }
  });
  it('accepts narrow const scope, fields first and safe hoisted named helper functions', async () => {
    expect(await ruleIds('export class Example { private value = 1; method() { const next = this.value + 1; return next; } } export function f() { return helper(); function helper() { return 1; } }')).toEqual([]);
  });
});
