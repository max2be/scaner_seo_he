import type { ReactNode } from 'react';
import type { ScanManifest } from '@hsi/contracts';
import { ApiError, part } from '../api.js';
export const scanLabels: Record<string, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  completed: 'Завершён',
  incomplete: 'Неполный',
  interrupted: 'Прерван',
  canceled: 'Отменён',
  failed: 'Ошибка',
};
export function Badge({ value }: { value: string }) {
  return <span className={'badge badge-' + value}>{scanLabels[value] ?? value}</span>;
}
export function ErrorNotice({
  error,
  retry,
  projectId,
}: {
  error?: Error | undefined;
  retry?: (() => void) | undefined;
  projectId?: string | undefined;
}) {
  if (!error) return null;
  return (
    <div className="notice danger" role="alert">
      <p>{error.message}</p>
      {error instanceof ApiError && (
        <>
          <ul>
            {error.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          {error.retryAfter && <p>Повторить через {error.retryAfter} с.</p>}
          {error.currentScanId && (
            <p>
              Текущий запуск:{' '}
              {projectId ? (
                <a href={'#/projects/' + part(projectId) + '/scans/' + part(error.currentScanId)}>
                  {error.currentScanId}
                </a>
              ) : (
                error.currentScanId
              )}
            </p>
          )}
        </>
      )}
      {retry && <button onClick={retry}>Повторить загрузку</button>}
    </div>
  );
}
export function Heading({
  children,
  eyebrow,
  action,
}: {
  children: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 id="page-title" tabIndex={-1}>
          {children}
        </h1>
      </div>
      {action}
    </div>
  );
}
export function Pager({
  next,
  back,
  reset,
  total,
  count,
  loading = false,
}: {
  next?: (() => void) | undefined;
  back?: (() => void) | undefined;
  reset: () => void;
  total: number | null;
  count: number;
  loading?: boolean;
}) {
  return (
    <nav className="pager" aria-label="Страницы результатов">
      <span>
        На странице: {count}. Всего: {total === null ? 'неизвестно' : total}
      </span>
      <button onClick={reset} disabled={loading}>
        В начало
      </button>
      <button onClick={back} disabled={!back || loading}>
        Назад
      </button>
      <button onClick={next} disabled={!next || loading}>
        Далее
      </button>
    </nav>
  );
}
export const projectHref = (id: string) => '#/projects/' + part(id);
export const scanHref = (id: string, scan: string) => projectHref(id) + '/scans/' + part(scan);
export function Completeness({ scan }: { scan: ScanManifest }) {
  if (scan.scanComplete) return <p className="notice success">Полное покрытие согласованного набора URL.</p>;
  return (
    <div className="notice warning">
      <strong>
        {scan.status === 'queued' || scan.status === 'running'
          ? 'Проверка ещё не завершена'
          : 'Скан неполный · INCOMPLETE'}
      </strong>
      <p>
        Полнота обнаружения: {scan.discoveryComplete ? 'подтверждена' : 'не подтверждена'}. Ошибки источников:{' '}
        {scan.failedSources}. Ошибки запросов: {scan.fetchErrors}.
      </p>
      {scan.truncated && <p>Достигнут лимит URL.</p>}
      <ul>
        {scan.reasons.map((reason, i) => (
          <li key={i}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}
export function Loading() {
  return <p role="status">Загрузка…</p>;
}
