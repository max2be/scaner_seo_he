import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
it('exports/indexes/pages/diffs 100k findings under a 96 MiB V8 heap cap', async () => {
    const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
    }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--max-old-space-size=96', 'tests/fixtures/reports/benchmark.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('report_benchmark_timeout')); }, 150000);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const metrics = JSON.parse(result.stdout);
    expect(metrics.count).toBe(100000);
    expect(metrics.diffUnknown).toBe(100000);
    expect(metrics.seekScanned).toBe(10);
    expect(metrics.rssMiB).toBeLessThan(256);
    console.log('EPIC-06 benchmark ' + result.stdout.trim());
}, 160000);
