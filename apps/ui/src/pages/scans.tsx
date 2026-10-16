import { useState } from 'react';
import { z } from 'zod';
import {
  ScanProgressSchema,
  ScanDiagnosticsPageSchema,
  OperationSchema,
  ReportSummarySchema,
  FindingPageSchema,
  FindingSchema,
  type Finding,
} from '@hsi/contracts';
import { api, projectPath, scanPath, part, query, ComparisonSchema, ScanPageSchema } from '../api.js';
import { useResource } from '../hooks.js';
import { Badge, Completeness, ErrorNotice, Heading, Loading, Pager, scanHref } from '../components/common.js';
import { Operation } from './projects.js';
const requested = z.object({ schemaVersion: z.literal('1.0'), requested: z.literal(true) }).strict();

export function Scan({ id, scanId }: { id: string; scanId: string }) {
  const path = scanPath(id, scanId);
  const [stopped, setStopped] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [operationId, setOperationId] = useState<string>();
  const data = useResource(
    path,
    async (signal) => {
      const value = await api.request(path, ScanProgressSchema, { signal });
      setStopped(!['queued', 'running'].includes(value.manifest.status));
      return value;
    },
    stopped && !operationPending ? 0 : 2500,
  );
  const summary = useResource(path + String(data.value?.manifest.status), async (signal) => {
    if (!data.value || ['queued', 'running'].includes(data.value.manifest.status)) return undefined;
    return api.request(path + '/summary', ReportSummarySchema, { signal });
  });
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  async function action(kind: 'cancel' | 'resume') {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'cancel') {
        await api.request(path + '/cancel', requested, { method: 'POST', body: {} });
        setCancelRequested(true);
      } else {
        const operation = await api.request(path + '/resume', OperationSchema, { method: 'POST', body: {} });
        setOperationId(operation.id);
        setOperationPending(true);
      }
      data.reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const manifest = data.value?.manifest;
  return (
    <>
      <Heading eyebrow={id}>Скан {scanId}</Heading>
      <ErrorNotice error={data.error} retry={data.reload} />
      <ErrorNotice error={error} />
      {data.loading && <Loading />}
      {manifest && (
        <>
          <div className="actions">
            <Badge value={manifest.status} />
            <button onClick={data.reload}>Обновить прогресс</button>
            {(['queued', 'running', 'interrupted'].includes(manifest.status) || operationPending) && (
              <button disabled={busy || cancelRequested} onClick={() => void action('cancel')}>
                Остановить
              </button>
            )}
            {['interrupted', 'incomplete', 'canceled'].includes(manifest.status) && (
              <button disabled={busy} onClick={() => void action('resume')}>
                Продолжить
              </button>
            )}
            <a className="button" href={'#/projects/' + part(id)}>
              Новый полный запуск
            </a>
          </div>
          {cancelRequested && (
            <p role="status">Запрос остановки отправлен. Ожидается подтверждение worker.</p>
          )}
          <Completeness scan={manifest} />
          {stopped && (
            <Diagnostics key={manifest.status + String(manifest.finishedAt)} id={id} scanId={scanId} />
          )}
          <div className="stats">
            {Object.entries({
              Найдено: manifest.discovered,
              'В очереди URL': manifest.queued,
              Получено: manifest.fetched,
              'Пропущено robots': manifest.skippedRobots,
              'Ошибки запросов': manifest.fetchErrors,
              'Ошибки источников': manifest.failedSources,
            }).map(([label, count]) => (
              <div className="stat" key={label}>
                <span>{label}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          <p>
            Обработано: {manifest.fetched + manifest.skippedRobots + manifest.fetchErrors} из{' '}
            {manifest.discovered} обнаруженных URL. Итоговый объём до завершения discovery неизвестен.
          </p>
          {data.value?.analysis && (
            <p>
              Анализ: {data.value.analysis.phase}; проверено URL: {data.value.analysis.urlsAnalyzed}, ошибок
              анализа: {data.value.analysis.errors}.
            </p>
          )}
          {operationId && (
            <Operation
              key={operationId}
              id={id}
              operationId={operationId}
              onComplete={() => {
                setOperationPending(false);
                data.reload();
              }}
            />
          )}
          <ErrorNotice error={summary.error} retry={summary.reload} />
          {summary.value && (
            <section className="card">
              <h2>Сводка находок</h2>
              <div className="severity-row">
                {Object.entries(summary.value.bySeverity).map(([value, count]) => (
                  <span key={value}>
                    <Badge value={value} /> {count}
                  </span>
                ))}
              </div>
              <p>
                Требуют проверки: {summary.value.needsReview}. Полнота анализа:{' '}
                {summary.value.coverageComplete ? 'подтверждена' : 'не подтверждена'}.
              </p>
            </section>
          )}
          <div className="actions">
            <a className="button primary" href={scanHref(id, scanId) + '/findings'}>
              Открыть находки
            </a>
            <a className="button" href={scanHref(id, scanId) + '/compare'}>
              Сравнить запуски
            </a>
          </div>
          <Downloads id={id} scanId={scanId} ready={!!summary.value} />
        </>
      )}
    </>
  );
}
function Downloads({ id, scanId, ready }: { id: string; scanId: string; ready: boolean }) {
  return (
    <section className="card">
      <h2>Отчёты и диагностика</h2>
      <p>Выгрузки доступны только в текущей сессии. Неполные отчёты содержат отметку INCOMPLETE.</p>
      <div className="actions">
        {(ready
          ? ['csv', 'json', 'jsonl', 'html', 'summary', 'manifest', 'errors', 'analysis-errors']
          : ['manifest']
        ).map((kind) => (
          <a key={kind} className="button" href={scanPath(id, scanId) + '/download/' + kind} download>
            {kind.toUpperCase()}
          </a>
        ))}
      </div>
      <p className="muted">
        HTML доступен, если включён в настройках проекта. Ошибки источников находятся в ERRORS, отдельно от
        SEO-находок.
      </p>
    </section>
  );
}
export function Findings({ id, scanId }: { id: string; scanId: string }) {
  const [filters, setFilters] = useState<Record<string, string>>({ sort: 'asc' });
  const [applied, setApplied] = useState<Record<string, string>>({ sort: 'asc' });
  const [cursors, setCursors] = useState<string[]>([]);
  const path = scanPath(id, scanId) + '/findings' + query({ ...applied, limit: 50, cursor: cursors.at(-1) });
  const fields: [string, string, string[]?][] = [
    ['severity', 'Критичность', ['P0', 'P1', 'P2', 'INFO']],
    ['verdict', 'Вердикт', ['finding', 'needs_review']],
    ['ruleId', 'Rule ID'],
    ['source', 'Источник', ['server_html', 'http', 'backend', 'sitemap', 'robots']],
    ['entityType', 'Тип сущности', ['product', 'category', 'page']],
    ['confidence', 'Уверенность', ['high', 'medium', 'low']],
    ['httpStatus', 'HTTP-код'],
    ['entityId', 'ID сущности'],
    ['urlContains', 'Поиск URL'],
    ['sort', 'Порядок появления', ['asc', 'desc']],
  ];
  return (
    <>
      <Heading eyebrow={scanId}>Находки</Heading>
      <p>
        <a href={scanHref(id, scanId)}>Прогресс и полнота скана</a>
      </p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCursors([]);
          setApplied({ ...filters });
        }}
      >
        {fields.map(([key, label, choices]) => (
          <label key={key}>
            {label}
            {choices ? (
              <select
                aria-label={label}
                value={filters[key] ?? ''}
                onChange={(e) => setFilters((v) => ({ ...v, [key]: e.target.value }))}
              >
                {key !== 'sort' && <option value="">Все</option>}
                {choices.map((v) => (
                  <option key={v} value={v}>
                    {v === 'needs_review'
                      ? 'Требует проверки'
                      : v === 'finding'
                        ? 'Подтверждённая находка'
                        : v === 'asc'
                          ? 'Сначала ранние'
                          : v === 'desc'
                            ? 'Сначала поздние'
                            : v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={filters[key] ?? ''}
                maxLength={key === 'urlContains' ? 500 : 200}
                onChange={(e) => setFilters((v) => ({ ...v, [key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <button className="primary">Применить фильтры</button>
        <button
          type="button"
          onClick={() => {
            setFilters({ sort: 'asc' });
            setApplied({ sort: 'asc' });
            setCursors([]);
          }}
        >
          Сбросить фильтры
        </button>
      </form>
      <FindingResults
        key={path}
        path={path}
        id={id}
        scanId={scanId}
        reset={() => setCursors([])}
        back={cursors.length ? () => setCursors((v) => v.slice(0, -1)) : undefined}
        next={(cursor) => setCursors((v) => [...v, cursor])}
      />
    </>
  );
}
function FindingResults({
  path,
  id,
  scanId,
  reset,
  back,
  next,
}: {
  path: string;
  id: string;
  scanId: string;
  reset: () => void;
  back?: (() => void) | undefined;
  next: (cursor: string) => void;
}) {
  const data = useResource(path, (signal) => api.request(path, FindingPageSchema, { signal }));
  return (
    <>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.error && <button onClick={reset}>Вернуться к первой странице</button>}
      {data.loading && <Loading />}
      {data.value && (
        <>
          <div className="table-wrap">
            <table>
              <caption>Находки выбранного скана</caption>
              <thead>
                <tr>
                  <th>Критичность</th>
                  <th>Правило и URL</th>
                  <th>Вердикт</th>
                  <th>Источник</th>
                  <th>Уверенность</th>
                  <th>Доказательства</th>
                </tr>
              </thead>
              <tbody>
                {data.value.items.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <Badge value={f.severity} />
                    </td>
                    <td>
                      <strong>{f.ruleId}</strong>
                      <small className="url">{f.url}</small>
                    </td>
                    <td>{f.verdict === 'needs_review' ? 'Требует проверки' : 'Находка'}</td>
                    <td>{f.evidence.source}</td>
                    <td>{f.confidence}</td>
                    <td>
                      <a href={scanHref(id, scanId) + '/findings/' + part(f.id)}>Открыть доказательства</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.value.items.length && (
            <p className="empty">
              {data.value.nextCursor
                ? 'Совпадений в этой части индекса нет. Продолжите на следующую страницу.'
                : 'На этой странице находок нет.'}
            </p>
          )}
          <Pager
            total={data.value.total}
            count={data.value.items.length}
            reset={reset}
            back={back}
            next={data.value.nextCursor ? () => next(data.value!.nextCursor!) : undefined}
          />
          <p className="muted">
            Просмотрено кандидатов: {data.value.scanned}. Фильтр не означает отсутствие ошибок в непроверенных
            URL.
          </p>
        </>
      )}
    </>
  );
}
const recommendations: Record<string, string> = {
  TITLE_MISSING: 'Добавьте содержательный title в исходный HTML и повторите проверку.',
  DESCRIPTION_MISSING: 'Проверьте необходимость description и добавьте его для важных посадочных страниц.',
  PRODUCT_RATING_COUNT_MISSING:
    'Проверьте реальные оценки: у AggregateRating нужны ratingCount или reviewCount.',
  BROKEN_INTERNAL_LINK:
    'Проверьте исходную ссылку и назначение. Исправьте URL либо настройте обоснованный редирект.',
  SSR_CONTENT_MISSING:
    'Проверьте исходный HTML и способ доставки контента. Этот сигнал не доказывает отсутствие страницы в поиске.',
};
export function Evidence({ finding }: { finding: Finding }) {
  return (
    <>
      <div className="actions">
        <Badge value={finding.severity} />
        <span>
          {finding.verdict === 'needs_review' ? 'Требует ручной проверки' : 'Находка'} · confidence:{' '}
          {finding.confidence}
        </span>
      </div>
      <p className="url">{finding.url}</p>
      <dl>
        <dt>Ожидается</dt>
        <dd>{finding.expected}</dd>
        <dt>Фактически</dt>
        <dd>{finding.actual}</dd>
        <dt>Сущность</dt>
        <dd>{finding.entity ? `${finding.entity.type}: ${finding.entity.id}` : 'Не указана'}</dd>
        <dt>HTTP</dt>
        <dd>{finding.evidence.httpStatus ?? 'Нет данных'}</dd>
        <dt>Источник</dt>
        <dd>{finding.evidence.source}</dd>
        <dt>Исходная страница</dt>
        <dd className="url">{finding.evidence.sourcePage ?? 'Не указана'}</dd>
        <dt>JSON path</dt>
        <dd>{finding.evidence.jsonPath ?? 'Не указан'}</dd>
        <dt>Первое / последнее наблюдение</dt>
        <dd>
          {finding.firstSeenAt} / {finding.lastSeenAt}
        </dd>
      </dl>
      {finding.evidence.excerpt && (
        <>
          <h2>Сохранённый фрагмент</h2>
          <pre data-testid="evidence-excerpt">{finding.evidence.excerpt}</pre>
        </>
      )}
      <h2>Рекомендация</h2>
      <p>
        {recommendations[finding.ruleId] ??
          'Сопоставьте ожидаемое и фактическое поведение с политикой проекта. Исправьте подтверждённую причину и повторите скан.'}
      </p>
      <p className="muted">
        Ключ рекомендации: {finding.suggestionKey}. Версия правила: {finding.ruleVersion}. Отображаются только
        сохранённые доказательства; полная HTTP-цепочка в этом DTO отсутствует. HSI не подтверждает состояние
        поискового индекса.
      </p>
    </>
  );
}
export function FindingDetails({ id, scanId, findingId }: { id: string; scanId: string; findingId: string }) {
  const path = scanPath(id, scanId) + '/findings/' + part(findingId);
  const data = useResource(path, (signal) => api.request(path, FindingSchema, { signal }));
  return (
    <>
      <Heading eyebrow={scanId}>{data.value?.ruleId ?? 'Доказательства'}</Heading>
      <p>
        <a href={scanHref(id, scanId) + '/findings'}>К списку находок</a>
      </p>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading && <Loading />}
      {data.value && (
        <article className="card">
          <Evidence finding={data.value} />
        </article>
      )}
    </>
  );
}
export function Compare({ id, scanId }: { id: string; scanId: string }) {
  const scans = useResource(id, (signal) =>
    api.request(projectPath(id) + '/scans?limit=200', ScanPageSchema, { signal }),
  );
  const [before, setBefore] = useState('');
  return (
    <>
      <Heading eyebrow={scanId}>Сравнение запусков</Heading>
      <p>
        Выберите базовый запуск, созданный не позже текущего. Отсутствие находки в неполном повторном скане не
        означает исправление.
      </p>
      <ErrorNotice error={scans.error} retry={scans.reload} />
      <label>
        Базовый запуск
        <select aria-label="Базовый запуск" value={before} onChange={(e) => setBefore(e.target.value)}>
          <option value="">Выберите запуск</option>
          {scans.value?.items
            .filter((s) => s.scanId !== scanId && !['queued', 'running'].includes(s.status))
            .map((s) => (
              <option key={s.scanId} value={s.scanId}>
                {s.scanId} · {s.status}
              </option>
            ))}
        </select>
      </label>
      {scans.value?.nextCursor && <p>Показаны последние 200 запусков. Для более старого укажите ID ниже.</p>}
      <label>
        ID базового запуска
        <input value={before} maxLength={100} onChange={(e) => setBefore(e.target.value)} />
      </label>
      {/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(before) && (
        <Comparison key={before} id={id} scanId={scanId} before={before} />
      )}
    </>
  );
}
function Comparison({ id, scanId, before }: { id: string; scanId: string; before: string }) {
  const path = scanPath(id, scanId) + '/compare/' + part(before);
  const [operationId, setOperationId] = useState<string>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  async function build() {
    setBusy(true);
    setError(undefined);
    try {
      const value = await api.request(path, OperationSchema, { method: 'POST', body: {} });
      setOperationId(value.id);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void build()}>
          Построить сравнение
        </button>
        <button
          onClick={() => {
            setCursors([]);
            setVersion((v) => v + 1);
          }}
        >
          Обновить сравнение
        </button>
      </div>
      <ErrorNotice error={error} />
      {operationId && (
        <Operation
          key={operationId}
          id={id}
          operationId={operationId}
          onComplete={() => {
            setOperationId(undefined);
            setCursors([]);
            setVersion((v) => v + 1);
          }}
        />
      )}
      <label>
        Статус изменения
        <select
          aria-label="Статус изменения"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setCursors([]);
          }}
        >
          <option value="">Все</option>
          {['new', 'persisting', 'resolved', 'unknown'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <ComparisonResults
        key={path + status + cursors.at(-1) + version}
        path={path}
        queryString={query({ status, limit: 50, cursor: cursors.at(-1) })}
        reset={() => setCursors([])}
        back={cursors.length ? () => setCursors((v) => v.slice(0, -1)) : undefined}
        next={(cursor) => setCursors((v) => [...v, cursor])}
      />
    </>
  );
}
function ComparisonResults({
  path,
  queryString,
  reset,
  back,
  next,
}: {
  path: string;
  queryString: string;
  reset: () => void;
  back?: (() => void) | undefined;
  next: (cursor: string) => void;
}) {
  const data = useResource(path + queryString, (signal) =>
    api.request(path + queryString, ComparisonSchema, { signal }),
  );
  return (
    <>
      <ErrorNotice error={data.error} />
      {data.error && (
        <p>
          Если результат ещё не создан или устарел, нажмите «Построить сравнение». Для сброса страницы:{' '}
          <button onClick={reset}>В начало сравнения</button>
        </p>
      )}
      {data.loading && <Loading />}
      {data.value && (
        <>
          <div className="stats">
            {Object.entries(data.value.summary.counts).map(([key, value]) => (
              <div className="stat" key={key}>
                <span>{key}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {!data.value.summary.comparable && (
            <p className="notice warning">
              Покрытие или настройки различаются. Unknown не означает, что ошибка устранена.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <caption>Изменения находок</caption>
              <thead>
                <tr>
                  <th>Статус</th>
                  <th>Правило / URL</th>
                  <th>Причина неопределённости</th>
                  <th>Доказательства</th>
                </tr>
              </thead>
              <tbody>
                {data.value.page.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td>
                      {(row.after ?? row.before)!.ruleId}
                      <small className="url">{(row.after ?? row.before)!.url}</small>
                    </td>
                    <td>{row.reason ?? '—'}</td>
                    <td>
                      <details>
                        <summary>До / после</summary>
                        {row.before && (
                          <>
                            <h3>До</h3>
                            <Evidence finding={row.before} />
                          </>
                        )}
                        {row.after && (
                          <>
                            <h3>После</h3>
                            <Evidence finding={row.after} />
                          </>
                        )}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            total={data.value.page.total}
            count={data.value.page.items.length}
            reset={reset}
            back={back}
            next={data.value.page.nextCursor ? () => next(data.value!.page.nextCursor!) : undefined}
          />
          <div className="actions">
            {['csv', 'jsonl', 'html'].map((kind) => (
              <a key={kind} className="button" href={path + '/download/' + kind} download>
                DELTA {kind.toUpperCase()}
              </a>
            ))}
          </div>
          <p className="muted">Экспорт содержит всё готовое сравнение, без фильтра текущей страницы.</p>
        </>
      )}
    </>
  );
}

function Diagnostics({ id, scanId }: { id: string; scanId: string }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const path = scanPath(id, scanId) + '/diagnostics' + query({ limit: 50, cursor: cursors.at(-1) });
  const data = useResource(path, (signal) => api.request(path, ScanDiagnosticsPageSchema, { signal }));
  return (
    <section className="card">
      <h2>Непроверенные источники и ограничения</h2>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading && <Loading />}
      {data.value && (
        <>
          <ul>
            {data.value.items.map((issue, i) => (
              <li key={i}>
                {issue.source}: {issue.code}
                {issue.url && <span className="url"> · {issue.url}</span>}
              </li>
            ))}
          </ul>
          {!data.value.items.length && (
            <p>
              В этой части журнала ошибок нет. Полноту подтверждает состояние скана, а не пустая страница.
            </p>
          )}
          <Pager
            total={null}
            count={data.value.items.length}
            reset={() => setCursors([])}
            back={cursors.length ? () => setCursors((v) => v.slice(0, -1)) : undefined}
            next={
              data.value.nextCursor ? () => setCursors((v) => [...v, data.value!.nextCursor!]) : undefined
            }
          />
        </>
      )}
    </section>
  );
}
