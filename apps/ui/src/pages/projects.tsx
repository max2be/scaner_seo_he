import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  ProjectConfigSchema,
  ProjectViewSchema,
  OperationSchema,
  ValidationResultSchema,
  ReportSummarySchema,
  ScanManifestSchema,
  SchedulerStateSchema,
  type ProjectConfig,
  type ProjectView,
} from '@hsi/contracts';
import { api, projectPath, ProjectPageSchema, ScanPageSchema, query, scanPath } from '../api.js';
import { useResource } from '../hooks.js';
import { Badge, ErrorNotice, Heading, Loading, Pager, projectHref, scanHref } from '../components/common.js';

export function Projects() {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const path = '/api/projects' + query({ limit: 12, cursor });
  const data = useResource(path, (signal) => api.request(path, ProjectPageSchema, { signal }));
  return (
    <>
      <Heading
        eyebrow="Обзор инсталляции"
        action={
          <a className="button primary" href="#/projects/new">
            Новый проект
          </a>
        }
      >
        Проекты
      </Heading>
      <p>Анализ исходного HTTP и HTML. Без исполнения JavaScript и проверки поискового индекса.</p>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading && <Loading />}
      {data.value && (
        <>
          <div className="stats">
            <div className="stat">
              <span>Всего проектов</span>
              <strong>{data.value.total}</strong>
            </div>
            <div className="stat">
              <span>На этой странице</span>
              <strong>{data.value.items.length}</strong>
            </div>
          </div>
          <div className="project-grid">
            {data.value.items.map((view) => (
              <ProjectCard key={view.project.id} view={view} />
            ))}
          </div>
          {!data.value.items.length && (
            <p className="empty">Проектов пока нет. Создайте профиль сайта, чтобы начать проверку.</p>
          )}
          <Pager
            total={data.value.total}
            count={data.value.items.length}
            reset={() => setCursors([])}
            back={cursor ? () => setCursors((v) => v.slice(0, -1)) : undefined}
            next={
              data.value.nextCursor ? () => setCursors((v) => [...v, data.value!.nextCursor!]) : undefined
            }
          />
        </>
      )}
    </>
  );
}
function ProjectCard({ view }: { view: ProjectView }) {
  const scan = view.latestScan;
  const summary = useResource(view.project.id, async (signal) =>
    scan
      ? api.request(scanPath(view.project.id, scan.scanId) + '/summary', ReportSummarySchema, { signal })
      : undefined,
  );
  return (
    <article className="card">
      <div className="card-top">
        <span className="eyebrow">{view.archived ? 'Архив' : 'Проект'}</span>
        {scan && <Badge value={scan.status} />}
      </div>
      <h2>
        <a href={projectHref(view.project.id)}>{view.project.name}</a>
      </h2>
      <p className="url">{view.project.baseUrl}</p>
      {scan ? (
        <>
          <p>
            Последний запуск: <a href={scanHref(view.project.id, scan.scanId)}>{scan.scanId}</a>
          </p>
          <p>Покрытие: {scan.scanComplete ? 'полное' : 'не подтверждено'}</p>
          {summary.value ? (
            <>
              <div className="severity-row">
                {Object.entries(summary.value.bySeverity).map(([key, value]) => (
                  <span key={key}>
                    <Badge value={key} /> {value}
                  </span>
                ))}
              </div>
              <p>Требуют проверки: {summary.value.needsReview}</p>
              <label>
                Доля P0/P1 среди находок
                <meter
                  min={0}
                  max={Math.max(1, summary.value.total)}
                  value={summary.value.bySeverity.P0 + summary.value.bySeverity.P1}
                />
              </label>
            </>
          ) : (
            <p className="muted">Сводка ещё недоступна.</p>
          )}
        </>
      ) : (
        <p className="muted">Запусков ещё нет.</p>
      )}
    </article>
  );
}
export function Project({ id }: { id: string }) {
  const data = useResource(id, (signal) => api.request(projectPath(id), ProjectViewSchema, { signal }));
  const [cursors, setCursors] = useState<string[]>([]);
  const path = projectPath(id) + '/scans' + query({ limit: 25, cursor: cursors.at(-1) });
  const scans = useResource(path, (signal) => api.request(path, ScanPageSchema, { signal }), 4000);
  const [operationId, setOperationId] = useState<string>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  async function action(kind: 'start' | 'validate' | 'archive') {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'archive') {
        await api.request(projectPath(id), ProjectViewSchema, {
          method: 'PATCH',
          body: { archived: !data.value?.archived },
          ...(data.value ? { revision: data.value.revision } : {}),
        });
        data.reload();
      }
      if (kind === 'validate') {
        const result = await api.request(projectPath(id) + '/validate', OperationSchema, {
          method: 'POST',
          body: {},
        });
        setOperationId(result.id);
      }
      if (kind === 'start') {
        const result = await api.request(projectPath(id) + '/scans', ScanManifestSchema, {
          method: 'POST',
          body: {},
        });
        location.hash = scanHref(id, result.scanId).slice(1);
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow={id}
        action={
          <a className="button" href={projectHref(id) + '/edit'}>
            Настройки проекта
          </a>
        }
      >
        {data.value?.project.name ?? 'Проект'}
      </Heading>
      <ErrorNotice error={data.error} retry={data.reload} />
      <ErrorNotice error={error} projectId={id} />
      {data.loading && <Loading />}
      {data.value && (
        <>
          <p className="url">{data.value.project.baseUrl}</p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || data.value.archived}
              onClick={() => void action('start')}
            >
              Запустить полный скан
            </button>
            <button disabled={busy || data.value.archived} onClick={() => void action('validate')}>
              Проверить источники
            </button>
            <button disabled={busy} onClick={() => void action('archive')}>
              {data.value.archived ? 'Восстановить проект' : 'Архивировать проект'}
            </button>
          </div>
          <p className="muted">
            Сохраняются последние {data.value.project.reports.keepLastRuns} запусков. Проверка источников —
            ограниченная выборка, не полный аудит каталога.
          </p>
          {operationId && <Operation key={operationId} id={id} operationId={operationId} />}
        </>
      )}
      <ScheduleStatus id={id} />
      <h2>История и динамика</h2>
      <ErrorNotice error={scans.error} retry={scans.reload} />
      {scans.loading && <Loading />}
      {scans.value && (
        <>
          <div className="table-wrap">
            <table>
              <caption>Запуски проекта</caption>
              <thead>
                <tr>
                  <th>Запуск</th>
                  <th>Состояние</th>
                  <th>Обработано / найдено</th>
                  <th>Покрытие</th>
                </tr>
              </thead>
              <tbody>
                {scans.value.items.map((scan) => (
                  <tr key={scan.scanId}>
                    <td>
                      <a href={scanHref(id, scan.scanId)}>{scan.scanId}</a>
                      <small>{new Date(scan.createdAt).toLocaleString('ru')}</small>
                    </td>
                    <td>
                      <Badge value={scan.status} />
                    </td>
                    <td>
                      {scan.fetched + scan.skippedRobots + scan.fetchErrors} / {scan.discovered}
                      <meter
                        aria-label={'Обработано URL ' + scan.scanId}
                        min={0}
                        max={Math.max(1, scan.discovered)}
                        value={scan.fetched + scan.skippedRobots + scan.fetchErrors}
                      />
                    </td>
                    <td>{scan.scanComplete ? 'Полное' : 'Не подтверждено'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!scans.value.items.length && <p className="empty">Запусков ещё нет.</p>}
          <Pager
            total={scans.value.total}
            count={scans.value.items.length}
            reset={() => setCursors([])}
            back={cursors.length ? () => setCursors((v) => v.slice(0, -1)) : undefined}
            next={
              scans.value.nextCursor ? () => setCursors((v) => [...v, scans.value!.nextCursor!]) : undefined
            }
          />
        </>
      )}
    </>
  );
}
export function Operation({
  id,
  operationId,
  onComplete,
}: {
  id: string;
  operationId: string;
  onComplete?: (() => void) | undefined;
}) {
  const path = projectPath(id) + '/operations/' + encodeURIComponent(operationId);
  const [finished, setFinished] = useState(false);
  const notified = useRef(false);
  const data = useResource(
    path,
    async (signal) => {
      const value = await api.request(path, OperationSchema, { signal });
      if (['completed', 'failed', 'canceled'].includes(value.state)) {
        setFinished(true);
        if (!notified.current) {
          notified.current = true;
          onComplete?.();
        }
      }
      return value;
    },
    finished ? 0 : 2000,
  );
  const validation = ValidationResultSchema.safeParse(data.value?.result);
  return (
    <section className="card" aria-label="Операция worker">
      <h2>Операция worker</h2>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading && <Loading />}
      {data.value && (
        <>
          <p>
            {data.value.request.kind}: <Badge value={data.value.state} />
          </p>
          {data.value.errorCode && <p role="alert">Операция не выполнена: {data.value.errorCode}</p>}
          {validation.success && (
            <>
              <p>
                {validation.data.valid ? 'Выборочная проверка пройдена' : 'Обнаружены недоступные источники'}.
                Это не проверка всего каталога.
              </p>
              <ul>
                {validation.data.checks.map((check, index) => (
                  <li key={index}>
                    {check.kind}: <span className="url">{check.url}</span> —{' '}
                    {check.reachable ? 'доступен' : 'недоступен'} {check.httpStatus ?? check.code}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
export function EditProject({ id }: { id?: string }) {
  const data = useResource(id ?? 'new', async (signal) =>
    id ? api.request(projectPath(id), ProjectViewSchema, { signal }) : undefined,
  );
  return (
    <>
      <Heading eyebrow={id ?? 'Подключение сайта'}>{id ? 'Настройки проекта' : 'Новый проект'}</Heading>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading ? (
        <Loading />
      ) : (
        (!id || data.value) && <ProjectForm {...(data.value ? { view: data.value } : {})} />
      )}
    </>
  );
}
export function defaultProject(): ProjectConfig {
  return {
    schemaVersion: '1.0',
    id: '',
    name: '',
    baseUrl: '',
    allowedHosts: [],
    discovery: {
      sitemapUrls: [],
      seedUrls: [],
      crawlLinks: true,
      maxDepth: 8,
      queryPolicy: { mode: 'drop', allowedKeys: [], dropTrackingKeys: ['utm_*', 'gclid', 'yclid'] },
      maxUrls: 100000,
    },
    canonicalPolicy: {
      trailingSlash: 'unknown',
      expectedScheme: 'https',
      preferredHost: '',
      checkSelfCanonical: false,
    },
    http: {
      userAgent: 'HeadlessSEOInspector/1.0 (+site-owner-diagnostic)',
      respectRobots: true,
      requestsPerSecondPerHost: 1,
      concurrency: 2,
      timeoutMs: 15000,
      maxResponseBytes: 5000000,
      maxRedirects: 8,
      maxRetries: 2,
    },
    sources: {},
    reports: { keepLastRuns: 12, htmlEnabled: true },
  };
}
function Field({
  label,
  value,
  onChange,
  type = 'text',
  disabled = false,
  multiline = false,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
  multiline?: boolean;
}) {
  return (
    <label>
      {label}
      {multiline ? (
        <textarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          spellCheck={false}
        />
      ) : (
        <input
          aria-label={label}
          step={type === 'number' ? 'any' : undefined}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
      )}
    </label>
  );
}
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label>
      {label}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </label>
  );
}
const lines = (value: string) => (value ? value.split('\n') : []);
function ProjectForm({ view }: { view?: ProjectView }) {
  const [draft, setDraft] = useState(view?.project ?? defaultProject());
  const [error, setError] = useState<Error>();
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState<string>();
  const clean = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);
  const backend = draft.sources.backend;
  const normalized = {
    ...draft,
    allowedHosts: clean(draft.allowedHosts),
    discovery: {
      ...draft.discovery,
      sitemapUrls: clean(draft.discovery.sitemapUrls),
      seedUrls: clean(draft.discovery.seedUrls),
      queryPolicy: {
        ...draft.discovery.queryPolicy,
        allowedKeys: clean(draft.discovery.queryPolicy.allowedKeys),
        dropTrackingKeys: clean(draft.discovery.queryPolicy.dropTrackingKeys),
      },
    },
    sources: backend?.enabled
      ? { backend: { ...backend, allowedHosts: clean(backend.allowedHosts) } }
      : draft.sources,
  };
  const parsed = ProjectConfigSchema.safeParse(normalized);
  const feed = draft.sources.backend?.enabled
    ? draft.sources.backend
    : {
        enabled: true as const,
        type: 'entity-feed-v1' as const,
        endpoint: '',
        allowedHosts: [],
        auth: { type: 'none' as const },
        pageSize: 500,
      };
  const update = <K extends keyof ProjectConfig>(key: K, value: ProjectConfig[K]) =>
    setDraft((v) => ({ ...v, [key]: value }));
  const changeFeed = (value: typeof feed) => update('sources', { backend: value });
  async function save() {
    setIssues([]);
    setError(undefined);
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'project'}: ${issue.message}`));
      return;
    }
    setBusy(true);
    try {
      const { id: _id, schemaVersion: _version, ...patch } = parsed.data;
      void _id;
      void _version;
      await api.request(view ? projectPath(view.project.id) : '/api/projects', ProjectViewSchema, {
        method: view ? 'PATCH' : 'POST',
        body: view
          ? {
              ...patch,
              ...(view.project.scanSchedule && !parsed.data.scanSchedule ? { scanSchedule: null } : {}),
            }
          : parsed.data,
        ...(view ? { revision: view.revision } : {}),
      });
      location.hash = projectHref(parsed.data.id).slice(1);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function validateDraft() {
    if (!view || !parsed.success) {
      setIssues(
        parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const operation = await api.request(projectPath(view.project.id) + '/validate', OperationSchema, {
        method: 'POST',
        body: { config: parsed.data },
      });
      setOperationId(operation.id);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ErrorNotice error={error} />
      {!!issues.length && (
        <div className="notice danger" role="alert">
          <strong>Проверьте конфигурацию</strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-grid">
        <fieldset>
          <legend>Сайт и разрешённые адреса</legend>
          <Field label="ID проекта" value={draft.id} disabled={!!view} onChange={(v) => update('id', v)} />
          <Field label="Название" value={draft.name} onChange={(v) => update('name', v)} />
          <Field label="Базовый URL" value={draft.baseUrl} onChange={(v) => update('baseUrl', v)} />
          <Field
            label="Разрешённые хосты — по одному в строке"
            value={draft.allowedHosts.join('\n')}
            multiline
            onChange={(v) => update('allowedHosts', lines(v))}
          />
          <p className="muted">Только публичные HTTP(S) адреса, без паролей и токенов в URL.</p>
        </fieldset>
        <fieldset>
          <legend>Источники URL</legend>
          <Field
            label="Sitemap URL — по одному в строке"
            multiline
            value={draft.discovery.sitemapUrls.join('\n')}
            onChange={(v) => update('discovery', { ...draft.discovery, sitemapUrls: lines(v) })}
          />
          <Field
            label="Стартовые URL — по одному в строке"
            multiline
            value={draft.discovery.seedUrls.join('\n')}
            onChange={(v) => update('discovery', { ...draft.discovery, seedUrls: lines(v) })}
          />
          <Check
            label="Переходить по внутренним ссылкам"
            checked={draft.discovery.crawlLinks}
            onChange={(v) => update('discovery', { ...draft.discovery, crawlLinks: v })}
          />
          <Field
            label="Максимальная глубина"
            type="number"
            value={draft.discovery.maxDepth}
            onChange={(v) => update('discovery', { ...draft.discovery, maxDepth: Number(v) })}
          />
          <Field
            label="Лимит URL"
            type="number"
            value={draft.discovery.maxUrls}
            onChange={(v) => update('discovery', { ...draft.discovery, maxUrls: Number(v) })}
          />
        </fieldset>
        <fieldset>
          <legend>Политика URL и canonical</legend>
          <Choice
            label="Query-параметры"
            value={draft.discovery.queryPolicy.mode}
            options={['drop', 'allowlist']}
            onChange={(v) =>
              update('discovery', {
                ...draft.discovery,
                queryPolicy: { ...draft.discovery.queryPolicy, mode: v },
              })
            }
          />
          <Field
            label="Допустимые query-ключи — по одному в строке"
            multiline
            value={draft.discovery.queryPolicy.allowedKeys.join('\n')}
            onChange={(v) =>
              update('discovery', {
                ...draft.discovery,
                queryPolicy: { ...draft.discovery.queryPolicy, allowedKeys: lines(v) },
              })
            }
          />
          <Field
            label="Tracking-ключи для удаления — по одному в строке"
            multiline
            value={draft.discovery.queryPolicy.dropTrackingKeys.join('\n')}
            onChange={(v) =>
              update('discovery', {
                ...draft.discovery,
                queryPolicy: { ...draft.discovery.queryPolicy, dropTrackingKeys: lines(v) },
              })
            }
          />
          <Choice
            label="Завершающий слеш"
            value={draft.canonicalPolicy.trailingSlash}
            options={['unknown', 'preserve', 'with', 'without']}
            onChange={(v) => update('canonicalPolicy', { ...draft.canonicalPolicy, trailingSlash: v })}
          />
          <Choice
            label="Ожидаемая схема"
            value={draft.canonicalPolicy.expectedScheme}
            options={['https', 'http']}
            onChange={(v) => update('canonicalPolicy', { ...draft.canonicalPolicy, expectedScheme: v })}
          />
          <Field
            label="Предпочтительный хост"
            value={draft.canonicalPolicy.preferredHost}
            onChange={(v) => update('canonicalPolicy', { ...draft.canonicalPolicy, preferredHost: v })}
          />
          <Check
            label="Проверять self-canonical"
            checked={draft.canonicalPolicy.checkSelfCanonical}
            onChange={(v) => update('canonicalPolicy', { ...draft.canonicalPolicy, checkSelfCanonical: v })}
          />
        </fieldset>
        <fieldset>
          <legend>HTTP и нагрузка</legend>
          {(
            [
              'userAgent',
              'requestsPerSecondPerHost',
              'concurrency',
              'timeoutMs',
              'maxResponseBytes',
              'maxRedirects',
              'maxRetries',
            ] as const
          ).map((key) => (
            <Field
              key={key}
              label={
                {
                  userAgent: 'User-Agent',
                  requestsPerSecondPerHost: 'Запросов в секунду на хост',
                  concurrency: 'Параллельных запросов',
                  timeoutMs: 'Таймаут, мс',
                  maxResponseBytes: 'Максимум байт ответа',
                  maxRedirects: 'Максимум редиректов',
                  maxRetries: 'Повторов',
                }[key]
              }
              type={key === 'userAgent' ? 'text' : 'number'}
              value={draft.http[key]}
              onChange={(v) => update('http', { ...draft.http, [key]: key === 'userAgent' ? v : Number(v) })}
            />
          ))}
          <Check
            label="Соблюдать robots.txt"
            checked={draft.http.respectRobots}
            onChange={(v) => update('http', { ...draft.http, respectRobots: v })}
          />
        </fieldset>
        <fieldset>
          <legend>Backend Entity Feed v1</legend>
          <Check
            label="Подключить backend feed"
            checked={!!draft.sources.backend?.enabled}
            onChange={(v) => update('sources', v ? { backend: feed } : { backend: { enabled: false } })}
          />
          {draft.sources.backend?.enabled && (
            <>
              <Field
                label="HTTPS endpoint фида"
                value={feed.endpoint}
                onChange={(v) => changeFeed({ ...feed, endpoint: v })}
              />
              <Field
                label="Разрешённые хосты backend — по одному в строке"
                value={feed.allowedHosts.join('\n')}
                multiline
                onChange={(v) => changeFeed({ ...feed, allowedHosts: lines(v) })}
              />
              <Field
                label="Размер страницы фида"
                type="number"
                value={feed.pageSize}
                onChange={(v) => changeFeed({ ...feed, pageSize: Number(v) })}
              />
              <Check
                label="Bearer через ссылку на секрет"
                checked={feed.auth?.type === 'bearer'}
                onChange={(v) =>
                  changeFeed({ ...feed, auth: v ? { type: 'bearer', tokenEnv: '' } : { type: 'none' } })
                }
              />
              {feed.auth?.type === 'bearer' && (
                <Field
                  label="Имя ENV с токеном (не значение)"
                  value={feed.auth.tokenEnv}
                  onChange={(v) => changeFeed({ ...feed, auth: { type: 'bearer', tokenEnv: v } })}
                />
              )}
            </>
          )}
          <p className="muted">
            Секрет настраивается оператором только у worker и привязывается к HTTPS origin. Не вводите
            значение токена в панель.
          </p>
        </fieldset>
        <fieldset>
          <legend>Отчёты и хранение</legend>
          <Field
            label="Хранить последние запуски"
            type="number"
            value={draft.reports.keepLastRuns}
            onChange={(v) => update('reports', { ...draft.reports, keepLastRuns: Number(v) })}
          />
          <Check
            label="Создавать HTML-отчёт"
            checked={draft.reports.htmlEnabled}
            onChange={(v) => update('reports', { ...draft.reports, htmlEnabled: v })}
          />
          <Check
            label="Запускать по расписанию"
            checked={!!draft.scanSchedule}
            onChange={(enabled) =>
              update(
                'scanSchedule',
                enabled
                  ? { cron: '0 3 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                  : undefined,
              )
            }
          />
          {draft.scanSchedule && (
            <>
              <Field
                label="Cron — минута час день месяц день недели"
                value={draft.scanSchedule.cron}
                onChange={(cron) => update('scanSchedule', { ...draft.scanSchedule!, cron })}
              />
              <Field
                label="Часовой пояс расписания"
                value={draft.scanSchedule.timezone}
                onChange={(timezone) => update('scanSchedule', { ...draft.scanSchedule!, timezone })}
              />
              <p className="muted">
                Пять числовых полей cron. Полный скан; без одновременных запусков одного проекта. Оператор
                должен включить планировщик worker.
              </p>
            </>
          )}
        </fieldset>
      </div>
      <details>
        <summary>Предпросмотр конфигурации без секретов</summary>
        {parsed.success ? (
          <pre>{JSON.stringify(parsed.data, null, 2)}</pre>
        ) : (
          <p>Предпросмотр доступен после исправления ошибок конфигурации.</p>
        )}
      </details>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Сохранение…' : 'Сохранить проект'}
        </button>
        {view && (
          <button type="button" disabled={busy} onClick={() => void validateDraft()}>
            Проверить настройки без сохранения
          </button>
        )}
        <a href={view ? projectHref(view.project.id) : '#/'}>Отмена</a>
      </div>
      {view && operationId && <Operation key={operationId} id={view.project.id} operationId={operationId} />}
    </form>
  );
}

function ScheduleStatus({ id }: { id: string }) {
  const path = projectPath(id) + '/schedule';
  const data = useResource(path, (signal) =>
    api.request(
      path,
      z.object({ schemaVersion: z.literal('1.0'), state: SchedulerStateSchema.nullable() }).strict(),
      { signal },
    ),
  );
  const labels: Record<string, string> = {
    initialized: 'Инициализировано',
    idle: 'Ожидание',
    disabled: 'Расписание выключено',
    invalid_schedule: 'Некорректное расписание',
    pending: 'Подготовка очереди',
    queued: 'Поставлен в очередь',
    skipped_busy: 'Пропущено: проект занят',
  };
  return (
    <section className="card">
      <h2>Планировщик</h2>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.value?.state ? (
        <>
          <p>{labels[data.value.state.outcome]}</p>
          <p>
            Последняя проверка: {new Date(data.value.state.lastCheckedAt).toLocaleString('ru')}. Это
            сохранённое состояние, не подтверждение текущей доступности worker.
          </p>
          {data.value.state.lastScanId && (
            <a href={scanHref(id, data.value.state.lastScanId)}>Последний запуск по расписанию</a>
          )}
        </>
      ) : (
        <p>Проверок расписания ещё нет. Настройте расписание и попросите оператора включить планировщик.</p>
      )}
      <button onClick={data.reload}>Обновить состояние расписания</button>
    </section>
  );
}
