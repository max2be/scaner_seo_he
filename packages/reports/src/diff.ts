import { DiffRecordSchema, DiffSummarySchema, type DiffRecord, type DiffBuildPort, type ReportReadPort, type Finding } from '@hsi/contracts';
import { csvRow, escapeHtml, htmlHead, htmlEnd } from './format.js';
function incompatibility(before: ReportReadPort, after: ReportReadPort): DiffRecord['reason'] | undefined {
    const a = before.descriptor.context, b = after.descriptor.context;
    if (!after.descriptor.summary.coverageComplete)
        return 'second_scan_incomplete';
    if (a.scopeHash !== b.scopeHash)
        return 'scope_changed';
    if (a.policyHash !== b.policyHash)
        return 'policy_changed';
    if (a.engineVersion !== b.engineVersion)
        return 'engine_changed';
}
export async function buildDiff(before: ReportReadPort, after: ReportReadPort, writer: DiffBuildPort, signal?: AbortSignal, csvBom = true) {
    const a = before.descriptor, b = after.descriptor;
    try {
        if (a.context.projectId !== b.context.projectId || a.context.scanId === b.context.scanId)
            throw new Error('invalid_diff_pair');
        if (Date.parse(a.context.createdAt) > Date.parse(b.context.createdAt))
            throw new Error('diff_scan_order');
    }
    catch (error) {
        await writer.abort();
        throw error;
    }
    const incompatible = incompatibility(before, after);
    const summary = DiffSummarySchema.parse({ schemaVersion: '1.0', projectId: a.context.projectId, beforeScanId: a.context.scanId, afterScanId: b.context.scanId,
        beforeGeneration: a.generation, afterGeneration: b.generation, total: 0, counts: { new: 0, persisting: 0, resolved: 0, unknown: 0 }, comparable: !incompatible && Object.keys(a.context.ruleVersions).length === Object.keys(b.context.ruleVersions).length && Object.entries(a.context.ruleVersions).every(([id, version]) => b.context.ruleVersions[id] === version) });
    const old = before.sortedFindings()[Symbol.asyncIterator](), fresh = after.sortedFindings()[Symbol.asyncIterator]();
    try {
        await writer.text('diff.csv', (csvBom ? '\ufeff' : '') + csvRow(['id', 'status', 'reason', 'ruleId', 'url', 'beforeSeverity', 'afterSeverity', 'beforeVerdict', 'afterVerdict', 'firstSeenAt', 'lastSeenAt']));
        let left = await old.next(), right = await fresh.next();
        while (!left.done || !right.done) {
            signal?.throwIfAborted();
            let previous: Finding | undefined, current: Finding | undefined;
            if (left.done) {
                current = right.value!;
                right = await fresh.next();
            }
            else if (right.done) {
                previous = left.value;
                left = await old.next();
            }
            else if (left.value.id === right.value.id) {
                previous = left.value;
                current = right.value;
                left = await old.next();
                right = await fresh.next();
            }
            else if (left.value.id < right.value.id) {
                previous = left.value;
                left = await old.next();
            }
            else {
                current = right.value;
                right = await fresh.next();
            }
            let status: DiffRecord['status'] = previous ? current ? 'persisting' : 'resolved' : 'new';
            let reason: DiffRecord['reason'];
            const f = current ?? previous!;
            const versionChanged = Boolean(previous && a.context.ruleVersions[previous.ruleId] !== b.context.ruleVersions[previous.ruleId]);
            if (previous && !current)
                reason = incompatible ?? (versionChanged ? 'rule_version_changed' : previous.verdict === 'needs_review' ? 'baseline_needs_review' : undefined);
            else if (previous && current && previous.ruleVersion !== current.ruleVersion)
                reason = 'rule_version_changed';
            if (reason)
                status = 'unknown';
            const row = DiffRecordSchema.parse({ schemaVersion: '1.0', id: f.id, status, ...(previous ? { before: previous } : {}), ...(current ? { after: current } : {}), ...(reason ? { reason } : {}),
                firstSeenAt: previous && current ? (Date.parse(previous.firstSeenAt) < Date.parse(current.firstSeenAt) ? previous.firstSeenAt : current.firstSeenAt) : f.firstSeenAt,
                lastSeenAt: current?.lastSeenAt ?? previous!.lastSeenAt, severityChanged: Boolean(previous && current && previous.severity !== current.severity), verdictChanged: Boolean(previous && current && previous.verdict !== current.verdict) });
            summary.total++;
            summary.counts[status]++;
            await writer.append(row);
            await writer.text('diff.csv', csvRow([row.id, row.status, row.reason, f.ruleId, f.url, previous?.severity, current?.severity, previous?.verdict, current?.verdict, row.firstSeenAt, row.lastSeenAt]));
        }
        await writer.text('diff.html', htmlHead('Сравнение ' + a.context.scanId + ' → ' + b.context.scanId) + '<p>Сопоставимость: ' + (summary.comparable ? 'да' : 'ограничена') + '. ' + escapeHtml(JSON.stringify(summary.counts)) + '. Resolved означает отсутствие воспроизведения в полном сопоставимом скане; это не доказательство причины исправления.</p><table><thead><tr><th>Статус</th><th>Причина</th><th>Правило</th><th>URL</th><th>Критичность</th></tr></thead><tbody>');
        for await (const row of writer.records()) {
            signal?.throwIfAborted();
            const f = row.after ?? row.before!;
            await writer.text('diff.html', '<tr><td>' + escapeHtml(row.status) + '</td><td>' + escapeHtml(row.reason) + '</td><td>' + escapeHtml(f.ruleId) + '</td><td>' + escapeHtml(f.url) + '</td><td>' + escapeHtml(row.before?.severity) + ' → ' + escapeHtml(row.after?.severity) + '</td></tr>\n');
        }
        await writer.text('diff.html', '</tbody></table>' + htmlEnd);
        signal?.throwIfAborted();
        await writer.finish(summary);
        return summary;
    }
    catch (error) {
        await writer.abort();
        throw error;
    }
    finally {
        await old.return?.();
        await fresh.return?.();
    }
}
