import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, type Session } from './api.js';
import { useHash, useResource } from './hooks.js';
import { ErrorNotice, Heading, Loading } from './components/common.js';
import { Projects, Project, EditProject } from './pages/projects.js';
import { Compare, Findings, FindingDetails, Scan } from './pages/scans.js';

function Login({ message, initialError }: { message: string; initialError?: Error | undefined }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Error | undefined>(initialError);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const input = password;
    setPassword('');
    setBusy(true);
    setError(undefined);
    try {
      await api.login(input);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <p className="eyebrow">Headless SEO Inspector</p>
        <h1>Вход в панель</h1>
        <p>Проверки сайта, доказательства и история изменений в одном месте.</p>
        {message && <p role="status">{message}</p>}
        <ErrorNotice error={error} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            Пароль администратора
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              required
              maxLength={1024}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          <button className="primary" disabled={busy || !password}>
            {busy ? 'Вход…' : 'Войти'}
          </button>
        </form>
        <p className="muted">
          Доступ только для администратора. Секреты backend настраиваются отдельно оператором.
        </p>
      </section>
    </main>
  );
}
function Status() {
  const data = useResource(
    'health',
    (signal) =>
      api.request('/api/health', z.object({ status: z.enum(['ok', 'unavailable']) }).strict(), { signal }),
    10000,
  );
  return (
    <>
      <Heading eyebrow="Инсталляция">Состояние системы</Heading>
      <ErrorNotice error={data.error} retry={data.reload} />
      <section className="card">
        <h2>Web API</h2>
        <p role="status">
          {data.value?.status === 'ok' ? 'Доступен' : data.loading ? 'Проверка…' : 'Недоступен'}
        </p>
        <p>
          Ответ health подтверждает доступность web и каталога данных. Он не подтверждает работоспособность
          worker или доступность источников.
        </p>
        <dl>
          <dt>Worker / очередь</dt>
          <dd>
            Проверяйте сохранённый прогресс и операции в проекте. Отдельные системные метрики пока недоступны.
          </dd>
          <dt>Хранение</dt>
          <dd>Файлы на локальном volume. Retention задаётся в настройках каждого проекта.</dd>
          <dt>Границы анализа</dt>
          <dd>Исходный HTTP/HTML, без JS-рендеринга, Core Web Vitals и данных поисковых систем.</dd>
          <dt>Эксплуатация</dt>
          <dd>
            HTTPS, резервные копии и мониторинг диска настраиваются оператором. Расписания задаются в
            проектах; автоматические запуски отдельно включает оператор.
          </dd>
        </dl>
      </section>
    </>
  );
}
function Route({ hash }: { hash: string }) {
  const parts = hash
    .split('/')
    .filter(Boolean)
    .map((v) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return '';
      }
    });
  if (!parts.length) return <Projects />;
  if (parts.length === 1 && parts[0] === 'status') return <Status />;
  if (parts[0] === 'projects' && parts[1] === 'new' && parts.length === 2) return <EditProject />;
  const id = parts[1];
  if (parts[0] !== 'projects' || !id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) return <NotFound />;
  if (parts.length === 2) return <Project id={id} />;
  if (parts[2] === 'edit' && parts.length === 3) return <EditProject id={id} />;
  const scanId = parts[3];
  if (parts[2] !== 'scans' || !scanId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(scanId))
    return <NotFound />;
  if (parts.length === 4) return <Scan id={id} scanId={scanId} />;
  if (parts[4] === 'compare' && parts.length === 5) return <Compare id={id} scanId={scanId} />;
  if (parts[4] === 'findings') {
    if (parts.length === 5) return <Findings id={id} scanId={scanId} />;
    if (parts.length === 6 && /^sha256:[a-f0-9]{64}$/.test(parts[5]!))
      return <FindingDetails id={id} scanId={scanId} findingId={parts[5]!} />;
  }
  return <NotFound />;
}
function NotFound() {
  return (
    <>
      <Heading>Страница не найдена</Heading>
      <a href="#/">К проектам</a>
    </>
  );
}
export function App() {
  const [session, setSession] = useState<Session | null>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState<Error>();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const hadSession = useRef(false);
  const hash = useHash();
  useEffect(() => {
    const controller = new AbortController();
    api.onSession = (value) => {
      setSession(value ?? null);
      if (value) setError(undefined);
      if (!value && hadSession.current) {
        setMessage('Сессия завершена. Войдите снова.');
        location.hash = '/';
      }
      hadSession.current = !!value;
    };
    void api.restore(controller.signal).catch((e) => {
      if (!controller.signal.aborted) {
        setSession(null);
        if (e.status !== 401) setError(e);
      }
    });
    return () => {
      controller.abort();
      api.onSession = () => {};
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    const timer = setTimeout(() => api.clear(), Math.max(0, remaining));
    const check = () => {
      if (Date.now() >= Date.parse(session.expiresAt)) api.clear();
      else void api.restore().catch(() => {});
    };
    window.addEventListener('focus', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
    };
  }, [session]);
  if (session === undefined)
    return (
      <main className="login-shell">
        <Loading />
      </main>
    );
  if (!session) return <Login message={message} initialError={error} />;
  async function logout() {
    setLogoutBusy(true);
    setError(undefined);
    try {
      await api.logout();
    } catch (e) {
      setError(e as Error);
    } finally {
      setLogoutBusy(false);
    }
  }
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Перейти к содержимому
      </a>
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span>
            Headless SEO<small>INSPECTOR</small>
          </span>
        </a>
        <p className="sidebar-caption">Рабочее пространство</p>
        <nav aria-label="Основная навигация">
          <a href="#/" aria-current={hash === '/' ? 'page' : undefined}>
            Проекты
          </a>
          <a href="#/projects/new" aria-current={hash === '/projects/new' ? 'page' : undefined}>
            Подключить сайт
          </a>
          <a href="#/status" aria-current={hash === '/status' ? 'page' : undefined}>
            Состояние системы
          </a>
        </nav>
        <div className="sidebar-footer">
          <p>Single admin · приватная панель</p>
          <button onClick={() => void logout()} disabled={logoutBusy}>
            {logoutBusy ? 'Выход…' : 'Выйти'}
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Диагностика / {hash === '/' ? 'Обзор' : hash.startsWith('/projects') ? 'Проекты' : 'Система'}
          </span>
          <span className="session-label">● Сессия администратора</span>
        </header>
        <main id="main-content" tabIndex={-1}>
          <ErrorNotice error={error} />
          <Route key={hash} hash={hash} />
        </main>
        <footer>Headless SEO Inspector · факты HTTP и HTML, без предположений об индексации</footer>
      </div>
    </div>
  );
}
