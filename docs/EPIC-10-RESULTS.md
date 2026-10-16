# EPIC-10 — E2E Demo & Pilot readiness

Дата: 2026-10-16. Ветка `sum1-7`, поверх сохранённых EPIC-08/09.
Реализованы инструменты E10-01…04 и инструкция optional E10-05. Финальный полный
100k pipeline замер оставлен открытым: дальнейшее длительное тестирование прекращено
после уточнения пользователя о достаточности текущего набора. Production scans не выполнялись.
Новый GitHub Actions run не запускался; выполнены локальные эквиваленты CI checks.
Коммиты/push не выполнялись; исходные PRD/ТЗ/backlog/coverage не редактировались.

## Результат и найденный дефект

Один binary проверяет два независимых logical сайта через loopback HTTP и доверенный TLS
Entity Feed. Demo выполняет8 scans и33 assertions: XML index +2 child maps/gzip, HTML BFS,
cursor pagination, stable finding IDs, labelled positives/negatives, redirects, robots,
malformed XML/maxUrls/loop incomplete и release diff. Baseline11 findings, standalone5;
release diff: new0/persisting8/resolved3/unknown0. Все13 размеченных classification cases
прошли; ложных P0 в отрицательном наборе нет. Это не оценка точности на произвольном сайте.

При приёмке выявлен реальный пробел AC-18: SSR_CONTENT_MISSING был только entity-rule,
поэтому standalone shell200 не получал needs_review. Rule1.0.1 теперь работает с indexable
исходным HTML без Entity Feed, один раз на URL через generic engine. Noindex/probes и
достоверно nonpublished pages исключены; это P2 needs_review, не P0/404/индексация.
Добавлены unit и реальный worker/demo regression. Изменение версии защищает diff со старым
baseline от ложного resolved. Persisted schemas не менялись. Решения: ADR-022…025.

Вторая находка QA: длинное имя проекта/ID scheduled scan вызывали mobile overflow390px.
Измерение прежнего переноса: scrollWidth3050px; после inherited overflow-wrap:anywhere —390px.
Новый Chromium regression подтверждает reflow валидных DTO. Fixture получает JSON через
сам браузер с прежним SPKI trust; Node route.fetch для локального TLS не используется.

Третий дефект найден на большом дереве файлов: recursive `fs.rm` создавал растущее
количество задач и превышал heap128 MiB. Отдельное воспроизведение на512512 entries
завершилось OOM; последовательный streaming cleanup нового полного дерева такого же
размера прошёл с RSS53.57 MiB за70.06s. Общий storage helper применяется также в resume/retention/abort/backup
cleanup. Он не обходит symlinks, не удаляет внешние targets и запрещает filesystem root.
Regression отдельно удаляет100100 файлов при heap32 MiB. Первый100k прогон с OOM
не засчитывается успешным. Повтор после исправления остановлен до завершения;
успешный полный100k pipeline результат пока не заявляется.

## Новые файлы

- `scripts/fixtures/demo-site.mjs` — disposable two-site HTTP/TLS fixture.
- `scripts/demo.mjs` — executable acceptance с optional NEW output, без overwrite.
- `tests/pilot-demo.test.ts` — CLI/worker/report/two-site acceptance и защита существующего output.
- `scripts/fixtures/pipeline-load.mjs` — generated durable worker/HTML/rules/reports load.
- `scripts/benchmark-pipeline.mjs` — bounded child runner, disk/Docker tmpfs modes.
- `packages/storage/src/remove-tree.ts` — bounded-memory cleanup для больших сканов.
- `tests/remove-tree.test.ts` и `tests/fixtures/remove-tree-memory.mjs` — links/root/force/memory regression.
- `.github/workflows/pipeline-load.yml` — manual generated load, synthetic metrics artifact.
- `docs/ACCEPTANCE-MATRIX.md` — AC-01…28 → конкретные исполняемые доказательства.
- `docs/pilot.md` — demo/load/manual QA/operator sign-off и optional pilot procedure.
- `docs/EPIC-10-RESULTS.md` и `docs/EPIC-10-METRICS.json` — результаты и измерения.

Изменены core SEO rule/version, worker rule routing, SEO regression, browser three-click/mobile
scenarios, npm scripts, CI Docker smoke steps, portable Docker config в TLS smoke,
README/development docs, AGENTS и локальный AI Factory context/plan/decisions.
Новые зависимости и CMS-specific code не добавлены. Vendor skill hashes10/10 совпадают.
Файлы EPIC-08/09 сохранены; их списки в отдельных исторических RESULTS.

## Проверки

| Проверка | Результат |
| --- | --- |
| `npm ci --ignore-scripts` | Установка из lockfile успешна |
| `npm run check` после bounded cleanup fix | Lint/typecheck,469 tests/31 files, production build — успешно |
| Focused rules/pipeline/demo после AC-18 fix | 72 tests/3 files — успешно |
| Дополнительный final demo regression | 2 tests, standalone shell и33 assertions — успешно |
| `npm run smoke` | Web/worker health, private401, SIGTERM exit0 |
| Chromium E2E после cleanup fix | 16/16 TLS scenarios за45.6s, включая evidence за3 клика и mobile long IDs |
| 100k report/index/diff benchmark | Cap96 MiB; heap71.95 MiB/RSS183.66 MiB;107.76s; seek10 candidates |
| Production Docker build и Compose | Image собран, оба сервиса healthy; scheduler defaultfalse |
| Runtime API/reports/backup smoke | CRUD/auth/CSRF/queue409/resume/export/diff/restore успешны, UID1000 |
| Graceful benchmark SIGTERM | Собственный контейнер удалён, основной load сохранён |
| TLS proxy smoke | Trusted TLS/SNI, private401, HSTS, secure session, CSRF/logout, body413 успешны |
| Final lint, skill hashes, conflict/diff checks | Успешно |

### Generated pipeline10k/100k

Метрики и точные transport/filesystem labels: [EPIC-10-METRICS.json](EPIC-10-METRICS.json).

10k на local filesystem:10000 discovered/fetched/analyzed,100 findings и2 pages;
V8 old-space cap128 MiB, peak RSS121.08 MiB; disk footprint187.70 MiB;370.58s.
Этот замер пересекался с первоначальными regression/browser checks и не является
изолированным storage SLA. Обычная FS облачной среды имеет высокую стоимость file I/O.

100k harness использует отдельный Docker tmpfs workload с отключённой сетью и memory
limit4 GiB; Node old-space cap128 MiB/RSS budget384 MiB. Ожидаемый результат:
100000 URL, две карты по50000,1000 findings,20 страниц по50. Это assertions harness,
а не полученные финальные метрики. В повторе после исправления все100000 URL обнаружены,
последний progress log перед остановкой:89774 страницы за1980s. Обход, последующий
анализ/отчёт и cleanup всего workload не завершены; этот повтор не считается pass.
Пользователь предложил ограничиться текущим уровнем тестов; длительный повтор остановлен.
Полный100k pipeline completion остаётся отдельным gate перед утверждением этой мощности
для пилота. Успешные100k report/index/diff и512512-entry cleanup проверки покрывают
другие части системы и не заменяют его.

Replay clients только в benchmark: настоящий durable worker `runScan`, HTML parsing,
правила, WAL/checkpoints/fsync, reports и bounded pagination. Нет реальных HTTP запросов;
SafeHttpClient/rate/SSRF/TLS не меняются. HTTP semantics покрыты отдельными socket suites/demo.
Tmpfs allocated footprint не является диском, RSS Node не включает filesystem RAM;
полный container ограничен4 GiB. По100k tmpfs нельзя обещать производственную disk throughput
или сохранность данных при отказе питания. Disk100k на этой cloud FS не заявляется пройденным.

Первый полный check обнаружил AC-18 и timeout report benchmark при параллельной generated
нагрузке. Исправлен продуктовый дефект; затем check без конкурирующего большого load
полностью прошёл. Assertions/timeouts существующего report test не отключались/не увеличивались.
Первый100k disk attempt остановлен для переноса cardinality/memory exercise в tmpfs;
его незавершённые данные удалены, успешный10k результат сохранён отдельно.
Повторный browser запуск сначала не нашёл bundled Chromium в cache: тесты не выполнились.
Документированный `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` использовал
установленный браузер и завершился16/16; TLS trust/assertions не ослаблялись.

## Локальный review и оставшиеся gates

Проверены: fixture imports не доступны runtime UI/API; нет allow-private/TLS bypass в production;
TLS smoke использует штатный DOCKER_CONFIG пользователя; load container без сети/operator volume;
output exclusive, credentials synthetic, cleanup только собственных resources; rule version/diff
и no-P0 guards. Все production пути проходят прежний security suite EPIC-09.

AC matrix содержит автоматические доказательства, но не заменяет human business/security
sign-off владельца. Нужны operator TLS/DNS/firewall/admin/feed binding, offline restore drill,
согласованные лимиты/окно и оценка реальных findings/needs_review. Полная HTTP chain доступна
в urls.jsonl; Finding UI показывает status/source/excerpt и прямо сообщает ограничение chain.
Chromium checks — базовые responsive/accessibility, не полный WCAG/cross-browser audit.
Не обновляйте runtime посреди активного анализа: rebuild старых SSR1.0.0 findings
может fail-closed по version mismatch; опубликованные snapshots читаются, нужен новый scan.
Реальный100k HTTP pilot/load на сети не выполнялся. Внешняя CVE/pentest оценка не заявляется.

E10-05 опционален и остаётся вне выполнения: только после отдельного owner authorization.
Нет новых EPIC по согласованному backlog; последующая работа — фиксация/публикация изменений,
при необходимости завершение100k pipeline gate, operator sign-off и согласованный пилот.
Доступы/секреты в чат не требуются.
