import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, readdir, writeFile, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, csvCell, csvRow, escapeHtml } from '@hsi/reports';
import { FileReportReader, FileReportWriter } from '@hsi/storage';
import { finding, reportContext, rows, writeReport } from './report-fixture.js';
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), 'hsi-reports-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe('CSV / HTML export safety (AC-25)', () => {
    it.each(['=HYPERLINK("https://bad.example")', '+cmd', '-1+2', '@SUM(A1)', '  =1', '\t=1', '\r=1', '\n=1', '\ufeff=1', '\u200b=1', '\u202e=1', '\u0000=1'])('neutralizes spreadsheet formulas %j', input => {
        expect(csvCell(input)).toBe('"\'' + input.replace(/"/g, '""') + '"');
    });
    it('quotes every RFC4180 cell, preserves quotes/newlines and uses CRLF', () => {
        expect(csvRow(['safe', 'a,b', 'a"b', 'a\nb', undefined])).toBe('"safe","a,b","a""b","a\nb",""\r\n');
        expect(escapeHtml('<script a="x">&\'')).toBe('&lt;script a=&quot;x&quot;&gt;&amp;&#39;');
    });
    it('exports all untrusted evidence as text with no remote assets, active links or scripts', async () => {
        const directory = await root();
        const payload = '</td><script>alert("x")</script><img src=x onerror=alert(1)>';
        const reader = await writeReport(directory, [finding(0, 'scan-one', { expected: payload, actual: '=HYPERLINK("x")', evidence: { source: 'backend', excerpt: payload, jsonPath: payload }, entity: { type: 'product', id: payload } })]);
        const html = await readFile(join(reader.directory, 'report.html'), 'utf8');
        const csv = await readFile(join(reader.directory, 'findings.csv'), 'utf8');
        expect(html).toContain(escapeHtml(payload));
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).not.toMatch(/<(?:a|link|iframe|form)\b/i);
        expect(html).toContain('Content-Security-Policy');
        expect(csv).toContain('"\'=HYPERLINK(""x"")"');
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        expect((await reader.page({})).items[0]!.expected).toBe(payload); // JSONL stays structured evidence.
    });
});
describe('Streaming report generations and seek index (AC-28)', () => {
    it('keeps summary/JSONL/CSV/HTML totals consistent and indexes every dimension', async () => {
        const directory = await root();
        const items = [finding(0), finding(1, 'scan-one', { verdict: 'needs_review', confidence: 'low', entity: { type: 'product', id: 'sku' } }), finding(2, 'scan-one', { severity: 'INFO', evidence: { source: 'http', httpStatus: 404 } })];
        const reader = await writeReport(directory, items);
        expect(reader.descriptor.summary).toMatchObject({ total: 3, findings: 2, needsReview: 1, bySeverity: { P0: 0, P1: 2, P2: 0, INFO: 1 }, byRule: { TITLE_MISSING: 3 } });
        expect((await readFile(join(reader.directory, 'findings.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
        expect((await readFile(join(reader.directory, 'findings.csv'), 'utf8')).trim().split('\r\n')).toHaveLength(4);
        expect((await readFile(join(reader.directory, 'report.html'), 'utf8')).match(/<tr>/g)).toHaveLength(4);
        for (const filter of [{ severity: 'INFO' }, { verdict: 'needs_review' }, { confidence: 'low' }, { source: 'http' }, { entityType: 'product' }, { httpStatus: 404 }, { entityId: 'sku' }, { urlContains: '/1' }])
            expect((await reader.page({ filter })).items).toHaveLength(1);
        expect((await reader.page({ filter: { severity: 'INFO', source: 'server_html' } })).items).toEqual([]);
        expect((await reader.page({ filter: { ruleId: 'TITLE_MISSING' } })).total).toBe(3);
        expect((await reader.page({ filter: { severity: 'P0' } })).total).toBe(0);
        expect((await reader.find(items[1]!.id))?.entity?.id).toBe('sku');
        expect(await reader.find(finding(999).id)).toBeUndefined();
        const sorted = [];
        for await (const f of reader.sortedFindings())
            sorted.push(f.id);
        expect(sorted).toEqual(items.map(f => f.id).sort());
    });
    it('preserves scan duration when a report is regenerated later', async () => {
        const reader = await writeReport(await root(), [finding()], { finishedAt: '2026-10-15T00:01:00.000Z', generatedAt: '2026-10-16T00:00:00.000Z' });
        expect(reader.descriptor.summary.durationMs).toBe(60000);
    });
    it('paginates in both directions and rejects invalid, changed-filter and stale-generation cursors', async () => {
        const directory = await root();
        const reader = await writeReport(directory, [finding(0), finding(1), finding(2)]);
        const first = await reader.page({ limit: 2 });
        expect(first.items.map(f => f.url)).toEqual([finding(0).url, finding(1).url]);
        const last = await reader.page({ limit: 2, cursor: first.nextCursor });
        expect(last.items.map(f => f.url)).toEqual([finding(2).url]);
        expect(last.nextCursor).toBeNull();
        expect((await reader.page({ sort: 'desc', limit: 2 })).items.map(f => f.url)).toEqual([finding(2).url, finding(1).url]);
        await expect(reader.page({ cursor: 'bad' })).rejects.toThrow();
        await expect(reader.page({ limit: 201 })).rejects.toThrow();
        await expect(reader.page({ filter: { severity: 'P1' }, cursor: first.nextCursor })).rejects.toThrow();
        await expect(reader.page({ filter: { ruleId: '../../outside' } })).rejects.toThrow();
        await expect(reader.find('../../outside')).rejects.toThrow();
        const fresh = await writeReport(directory, [finding(0)]);
        await expect(fresh.page({ cursor: first.nextCursor })).rejects.toThrow();
        expect((await reader.page({})).total).toBe(3); // An already opened immutable generation stays readable.
    });
    it('creates valid empty reports; supports BOM and HTML options without stale HTML aliases', async () => {
        const directory = await root();
        await writeReport(directory, [finding()]);
        const reader = await writeReport(directory, [], { htmlEnabled: false, csvBom: false });
        expect(reader.descriptor.summary.total).toBe(0);
        expect((await reader.page({})).items).toEqual([]);
        expect((await readFile(join(reader.directory, 'findings.csv'), 'utf8')).charCodeAt(0)).toBe(34);
        await expect(stat(join(directory, 'report.html'))).rejects.toMatchObject({ code: 'ENOENT' });
        const sorted = [];
        for await (const row of reader.sortedFindings())
            sorted.push(row);
        expect(sorted).toEqual([]);
    });
    it.each(['identity', 'totals', 'duplicate', 'abort'] as const)('preserves published pointer when generation fails: %s', async (mode) => {
        const directory = await root();
        const previous = await writeReport(directory, [finding()]);
        const context = reportContext(mode === 'duplicate' ? 2 : 1);
        const writer = await FileReportWriter.create(directory, context);
        const items = mode === 'identity' ? [finding(0, 'other-scan')] : mode === 'totals' ? [] : mode === 'duplicate' ? [finding(), finding()] : [finding()];
        const signal = mode === 'abort' ? AbortSignal.abort() : undefined;
        await expect(buildReport(context, rows(items), writer, signal)).rejects.toThrow();
        expect((await FileReportReader.open(directory, false)).descriptor.generation).toBe(previous.descriptor.generation);
        expect((await readdir(join(directory, 'reports'))).filter(n => n.endsWith('.tmp'))).toEqual([]);
    });
    it('rejects corrupt/truncated seek pointers and identity pointers', async () => {
        const reader = await writeReport(await root(), [finding()]);
        const index = await open(join(reader.directory, 'indexes/all.idx'), 'r+');
        try {
            const b = Buffer.alloc(12);
            b.writeBigUInt64BE(9999999n);
            b.writeUInt32BE(10, 8);
            await index.write(b, 0, 12, 0);
        }
        finally {
            await index.close();
        }
        await expect(reader.page({})).rejects.toThrow('index_pointer_out_of_range');
        await writeFile(join(reader.directory, 'indexes/all.idx'), Buffer.alloc(1));
        await expect(FileReportReader.open(reader.directory + '/../..', false)).rejects.toThrow('report_size_mismatch');
    });
    it('repartitions a skewed hash bucket instead of loading an unbounded identity array', async () => {
        const directory = await root(), context = reportContext(4097);
        context.htmlEnabled = false;
        async function* input() { for (let i = 0; i < 4097; i++)
            yield finding(i, 'scan-one', { id: 'sha256:aa' + i.toString(16).padStart(62, '0') }); }
        await buildReport(context, input(), await FileReportWriter.create(directory, context));
        const reader = await FileReportReader.open(directory, false);
        expect(await reader.find('sha256:aa' + (4096).toString(16).padStart(62, '0'))).toMatchObject({ url: finding(4096).url });
        let count = 0;
        for await (const _ of reader.sortedFindings()) {
            void _;
            count++;
        }
        expect(count).toBe(4097);
    }, 30000);
});
