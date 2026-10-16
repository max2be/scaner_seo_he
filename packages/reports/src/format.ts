export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function csvCell(value: unknown): string {
    let text = value === undefined || value === null ? '' : String(value);
    // Control characters are deliberately included to prevent whitespace-prefixed formulas.
    // eslint-disable-next-line no-control-regex
    if (/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
        text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
export function csvRow(values: readonly unknown[]) {
    return values.map(csvCell).join(',') + '\r\n';
}
export const htmlHead = (title: string) => '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>' + escapeHtml(title) + '</title><style>body{font:16px system-ui;margin:2rem;max-width:100rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}td{overflow-wrap:anywhere}caption{text-align:left;margin:1rem 0}</style></head><body><h1>' + escapeHtml(title) + '</h1>';
export const htmlEnd = '</body></html>\n';
