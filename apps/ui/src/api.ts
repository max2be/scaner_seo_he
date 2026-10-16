import { z } from 'zod';
import {
  ApiErrorSchema,
  SessionViewSchema,
  ProjectViewSchema,
  ScanManifestSchema,
  DiffSummarySchema,
  DiffPageSchema,
} from '@hsi/contracts';
export type Session = z.infer<typeof SessionViewSchema>;
export const ProjectPageSchema = listSchema(ProjectViewSchema);
export const ScanPageSchema = listSchema(ScanManifestSchema);
export const ComparisonSchema = z.object({ summary: DiffSummarySchema, page: DiffPageSchema }).strict();
function listSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      schemaVersion: z.literal('1.0'),
      items: z.array(item).max(200),
      total: z.number().int().nonnegative(),
      nextCursor: z.string().nullable(),
    })
    .strict();
}
const messages: Record<string, string> = {
  invalid_credentials: 'Неверный пароль.',
  authentication_required: 'Сессия завершена. Войдите снова.',
  authentication_unavailable: 'Вход недоступен: администратор ещё не настроил авторизацию и HTTPS.',
  login_throttled: 'Слишком много попыток входа. Повторите позже.',
  origin_rejected: 'Адрес панели не совпадает с PUBLIC_ORIGIN. Проверьте настройки HTTPS.',
  csrf_rejected: 'Защитный токен устарел. Войдите снова.',
  invalid_request: 'Проверьте поля конфигурации.',
  invalid_scan_schedule: 'Проверьте расписание: пять числовых полей cron и действующий часовой пояс.',
  backend_credential_binding_required:
    'Ссылка на секрет не привязана к этому HTTPS origin. Обратитесь к оператору.',
  project_revision_changed: 'Конфигурация изменилась. Перезагрузите её перед сохранением.',
  comparison_stale: 'Сравнение устарело. Постройте его заново.',
  invalid_cursor: 'Страница устарела. Вернитесь к первой странице.',
  stale_list_cursor: 'Список изменился. Вернитесь к первой странице.',
  resource_not_found: 'Данные ещё не готовы или уже удалены.',
  report_not_ready: 'Отчёт ещё не готов. Обновите страницу после завершения скана.',
  network_error: 'Сервер недоступен. Проверьте соединение и повторите запрос.',
  invalid_response: 'Сервер вернул несовместимый ответ.',
};
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly currentScanId?: string,
    readonly retryAfter?: number,
    readonly issues: string[] = [],
  ) {
    super(
      messages[code] ??
        (status === 409
          ? 'Операция конфликтует с текущим состоянием проекта.'
          : 'Запрос не выполнен. Попробуйте обновить данные.'),
    );
  }
}
export class ApiClient {
  private session: Session | undefined;
  private epoch = 0;
  onSession: (session?: Session) => void = () => {};
  get currentSession() {
    return this.session;
  }
  clear() {
    this.epoch++;
    this.session = undefined;
    this.onSession();
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST' | 'PATCH';
      body?: unknown;
      signal?: AbortSignal;
      revision?: string;
    } = {},
  ): Promise<T> {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#'))
      throw new ApiError(0, 'invalid_request');
    const epoch = this.epoch;
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.session) headers['X-CSRF-Token'] = this.session.csrfToken;
    if (options.revision) headers['If-Match'] = options.revision;
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiError(0, 'network_error');
    }
    if (epoch !== this.epoch) throw new DOMException('Session changed', 'AbortError');
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => undefined));
      const error = parsed.success ? parsed.data : { error: 'invalid_response' };
      if ((response.status === 401 && path !== '/api/auth/login') || error.error === 'csrf_rejected')
        this.clear();
      throw new ApiError(
        response.status,
        error.error,
        error.currentScanId,
        error.retryAfter,
        error.issues?.map((v) => `${v.path}: ${v.code}`),
      );
    }
    const parsed = schema.safeParse(
      response.status === 204 ? undefined : await response.json().catch(() => null),
    );
    if (epoch !== this.epoch || options.signal?.aborted)
      throw new DOMException('Session changed', 'AbortError');
    if (!parsed.success) throw new ApiError(response.status, 'invalid_response');
    return parsed.data;
  }
  async restore(signal?: AbortSignal) {
    const session = await this.request('/api/me', SessionViewSchema, signal ? { signal } : {});
    this.session = session;
    this.onSession(session);
  }
  async login(password: string) {
    const session = await this.request('/api/auth/login', SessionViewSchema, {
      method: 'POST',
      body: { password },
    });
    this.session = session;
    this.onSession(session);
  }
  async logout() {
    await this.request('/api/auth/logout', z.undefined(), { method: 'POST', body: {} });
    this.clear();
  }
}
export const api = new ApiClient();
export const part = encodeURIComponent;
export const projectPath = (id: string) => '/api/projects/' + part(id);
export const scanPath = (id: string, scan: string) => projectPath(id) + '/scans/' + part(scan);
export function query(values: Record<string, string | number | undefined>) {
  return (
    '?' +
    new URLSearchParams(
      Object.entries(values)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => [key, String(value)]),
    )
  );
}
