import { readFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
const password = 'synthetic-browser-password-only';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Пароль администратора').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
}
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'https://127.0.0.1:4178' });
  const page = await context.newPage();
  await login(page);
  cookies = await context.cookies();
  await context.close();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== 'https://127.0.0.1:4178')
      throw new Error('Unexpected external browser request');
    return route.continue();
  });
});
test('anonymous login shell, private API and attachments are protected', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/#/projects/browser-reports/scans/before/findings');
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/projects')).status)).toBe(401);
  expect(
    await page.evaluate(
      async () => (await fetch('/api/projects/browser-reports/scans/before/download/csv')).status,
    ),
  ).toBe(401);
  await expect(page.getByText('Каталог · тестовый проект', { exact: true })).toHaveCount(0);
});
test('dashboard renders latest coverage and summary with keyboard navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Каталог · тестовый проект' })).toBeVisible();
  await expect(
    page
      .getByRole('article')
      .filter({ has: page.getByRole('link', { name: 'Каталог · тестовый проект' }) })
      .getByText('Покрытие: не подтверждено'),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});
test('pilot acceptance: evidence opens in three clicks from the projects dashboard', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: 'Каталог · тестовый проект', exact: true }) });
  await card.getByRole('link', { name: 'after', exact: true }).click();
  await page.getByRole('link', { name: 'Открыть находки', exact: true }).click();
  await page.getByRole('link', { name: 'Открыть доказательства', exact: true }).first().click();
  await expect(page.getByText('Ожидается', { exact: true })).toBeVisible();
  await expect(page.getByText('Фактически', { exact: true })).toBeVisible();
});
test('mobile dashboard wraps long project names and scheduled scan IDs', async ({ page }) => {
  const longName = 'W'.repeat(160);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  const body = await page.evaluate(async () => (await fetch('/api/projects?limit=12')).json());
  body.items[0].project.name = longName;
  body.items[0].latestScan.scanId = 'scheduled-' + 'a'.repeat(64);
  await page.route(/\/api\/projects\?/, route => route.fulfill({ json: body }));
  await page.reload();
  await expect(page.getByRole('link', { name: longName, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('invalid form rejects private hosts; saves, edits and validates a public profile without secrets', async ({
  page,
}) => {
  await page.goto('/#/projects/new');
  await page.getByLabel('ID проекта', { exact: true }).fill('browser-created');
  await page.getByLabel('Название', { exact: true }).fill('Новый тестовый сайт');
  await page.getByLabel('Базовый URL', { exact: true }).fill('http://127.0.0.1');
  await page.getByLabel('Разрешённые хосты — по одному в строке', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Предпочтительный хост', { exact: true }).fill('127.0.0.1');
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await expect(page.getByRole('alert')).toContainText('baseUrl');
  await page.getByLabel('Базовый URL', { exact: true }).fill('https://shop.example.com');
  await page
    .getByLabel('Разрешённые хосты — по одному в строке', { exact: true })
    .fill('shop.example.com\nwww.shop.example.com\n');
  await page.getByLabel('Предпочтительный хост', { exact: true }).fill('shop.example.com');
  await page.getByText('Предпросмотр конфигурации без секретов', { exact: true }).click();
  await expect(page.locator('pre')).toContainText('https://shop.example.com');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await expect(page.getByRole('heading', { name: 'Новый тестовый сайт', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Настройки проекта' }).click();
  await page.getByLabel('Название', { exact: true }).fill('Изменённый тестовый сайт');
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await expect(page.getByRole('heading', { name: 'Изменённый тестовый сайт', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить источники' }).click();
  await expect(page.getByText('Выборочная проверка пройдена', { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText('Это не проверка всего каталога.', { exact: false })).toBeVisible();
});
test('real worker start, explicit incomplete state and durable resume', async ({ page }) => {
  await page.goto('/');
  const example = JSON.parse(readFileSync('docs/examples/project.example.json', 'utf8'));
  const config = {
    ...example,
    id: 'browser-lifecycle',
    name: 'Lifecycle fixture',
    sources: {},
    discovery: { ...example.discovery, seedUrls: [], sitemapUrls: [] },
  };
  const created = await page.evaluate(async (profile) => {
    const session = await (await fetch('/api/me')).json();
    return (
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(profile),
      })
    ).status;
  }, config);
  expect(created).toBe(201);
  await page.goto('/#/projects/browser-lifecycle');
  await page.getByRole('button', { name: 'Запустить полный скан' }).click();
  await expect(page.getByRole('heading', { name: /^Скан / })).toBeVisible();
  await expect(page.getByText('Скан неполный · INCOMPLETE')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('discovery_incomplete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Операция worker' })).toContainText('Завершён', {
    timeout: 15000,
  });
  await expect(page.getByText('Скан неполный · INCOMPLETE')).toBeVisible();
});
test('large reports: bounded page, filters, empty page with cursor and unknown total', async ({ page }) => {
  await page.goto('/#/projects/browser-reports/scans/before/findings');
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByLabel('Поиск URL', { exact: true }).fill('needle');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(page.getByText('Совпадений в этой части индекса нет.', { exact: false })).toBeVisible();
  await expect(page.getByText('Всего: неизвестно', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Далее', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('/needle');
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByLabel('Критичность', { exact: true }).selectOption('P2');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(page.locator('tbody .badge-P1')).toHaveCount(0);
});
test('lazy details escape hostile evidence and do not request target resources', async ({ page }) => {
  const details: string[] = [];
  page.on('request', (request) => {
    if (/\/findings\/sha256/.test(decodeURIComponent(request.url()))) details.push(request.url());
  });
  await page.goto('/#/projects/browser-reports/scans/before/findings');
  await expect(page.locator('tbody tr')).toHaveCount(50);
  expect(details).toHaveLength(0);
  await page.getByRole('link', { name: 'Открыть доказательства' }).first().click();
  await expect(page.getByTestId('evidence-excerpt')).toContainText('<script>window.__evidenceXss=1</script>');
  await expect(page.getByTestId('evidence-excerpt').locator('img,script')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, '__evidenceXss'))).toBeUndefined();
  expect(details).toHaveLength(1);
});
test('incomplete coverage and private CSV streaming download', async ({ page }) => {
  await page.goto('/#/projects/browser-reports/scans/after');
  await expect(page.getByText('Скан неполный · INCOMPLETE')).toBeVisible();
  await expect(page.getByText('max_urls_reached', { exact: true })).toBeVisible();
  await expect(page.getByText('sitemap_source_unchecked', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toContain('csv');
});
test('comparison queues real worker diff and keeps incomplete disappearances unknown', async ({ page }) => {
  await page.goto('/#/projects/browser-reports/scans/after/compare');
  await page.getByLabel('Базовый запуск', { exact: true }).selectOption('before');
  await page.getByRole('button', { name: 'Построить сравнение' }).click();
  await expect(page.getByRole('link', { name: 'DELTA CSV', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByLabel('Статус изменения', { exact: true }).selectOption('unknown');
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(page.locator('tbody tr').first()).toContainText('second_scan_incomplete');
  await page.getByLabel('Статус изменения', { exact: true }).selectOption('resolved');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'DELTA CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('delta.csv');
});
test('responsive layout, labels, status and local assets comply with CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (?:load|execute|apply)/i.test(message.text()))
      violations.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/status');
  await expect(page.getByRole('heading', { name: 'Состояние системы' })).toBeVisible();
  await expect(page.getByText('Доступен', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/#/projects/new');
  expect(
    await page
      .locator('input:not([type="checkbox"]), textarea, select')
      .evaluateAll((inputs) => inputs.every((input) => !!(input as HTMLInputElement).labels?.length)),
  ).toBe(true);
  expect(violations).toEqual([]);
  if (process.env.HSI_UI_SCREENSHOT)
    await page.screenshot({ path: process.env.HSI_UI_SCREENSHOT, fullPage: true });
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
test('401 during private request clears protected data and presents login', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  await context.clearCookies();
  await page.evaluate(() => {
    location.hash = '/projects/browser-reports';
  });
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible();
  await expect(page.getByText('Сессия завершена. Войдите снова.', { exact: true })).toBeVisible();
  await expect(page.getByText('Каталог · тестовый проект', { exact: true })).toHaveCount(0);
});
test('logout revokes actual secure cookie session; wrong password is recoverable', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto('/');
  await page.getByLabel('Пароль администратора').fill('synthetic-incorrect');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Неверный пароль');
  await expect(page.getByLabel('Пароль администратора')).toHaveValue('');
  await page.getByLabel('Пароль администратора').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  const session = (await context.cookies()).find((c) => c.name === '__Host-hsi_session')!;
  expect(session.secure && session.httpOnly && session.sameSite === 'Strict').toBe(true);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible();
  await context.addCookies([session]);
  expect(await page.evaluate(async () => (await fetch('/api/me')).status)).toBe(401);
});

test('real duplicate409 links to active queue and cancel waits for worker acknowledgement', async ({
  page,
}) => {
  await page.goto('/#/projects/browser-queued');
  await page.getByRole('button', { name: 'Запустить полный скан' }).click();
  await expect(page.getByRole('alert')).toContainText('Текущий запуск: waiting');
  await page.getByRole('alert').getByRole('link', { name: 'waiting', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Ожидается подтверждение worker');
  await expect(page.locator('.badge-canceled')).toBeVisible({ timeout: 15000 });
});

test('absolute session timeout clears private UI without a reload', async ({ page, context }) => {
  await context.route('**/api/me', (route) =>
    route.fulfill({
      json: {
        schemaVersion: '1.0',
        role: 'admin',
        csrfToken: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Вход в панель' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: 'Каталог · тестовый проект' })).toHaveCount(0);
});

test('schedule editor validates cron and removes an existing schedule without changing project format', async ({
  page,
}) => {
  await page.goto('/#/projects/new');
  await page.getByLabel('ID проекта', { exact: true }).fill('browser-schedule');
  await page.getByLabel('Название', { exact: true }).fill('Расписание · тестовый проект');
  await page.getByLabel('Базовый URL', { exact: true }).fill('https://shop.example.com');
  await page.getByLabel('Разрешённые хосты — по одному в строке', { exact: true }).fill('shop.example.com');
  await page.getByLabel('Предпочтительный хост', { exact: true }).fill('shop.example.com');
  await page.getByLabel('Запускать по расписанию', { exact: true }).check();
  await page.getByLabel('Cron — минута час день месяц день недели', { exact: true }).fill('bad cron');
  await page.getByLabel('Часовой пояс расписания', { exact: true }).fill('Europe/Moscow');
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте расписание');
  await page.getByLabel('Cron — минута час день месяц день недели', { exact: true }).fill('0 3 * * *');
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await expect(
    page.getByRole('heading', { name: 'Расписание · тестовый проект', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Проверок расписания ещё нет.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Настройки проекта', exact: true }).click();
  await expect(page.getByLabel('Запускать по расписанию', { exact: true })).toBeChecked();
  await page.getByLabel('Запускать по расписанию', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Сохранить проект' }).click();
  await page.getByRole('link', { name: 'Настройки проекта', exact: true }).click();
  await expect(page.getByLabel('Запускать по расписанию', { exact: true })).not.toBeChecked();
});
