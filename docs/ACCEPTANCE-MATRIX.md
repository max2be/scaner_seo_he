# Матрица приёмки MVP — EPIC-10

Источник: ТЗ §14, AC-01…28. Все автоматические сценарии используют mocks/disposable fixtures,
не публичные сайты. Статус ниже относится к конкретному проверенному поведению, а не к
готовности любой production инсталляции. Итоговые числа/метрики: [EPIC-10-RESULTS.md](EPIC-10-RESULTS.md).

| AC | Проверяемое поведение | Исполняемое доказательство |
| --- | --- | --- |
| 01 | Docker UI+worker, health, writable private volume, без БД | `npm run smoke`; Compose `up --wait`; runtime API/report/backup/TLS smoke |
| 02 | Login и анонимные reports401 | `api-auth`, `api-process`, `ui-static`; browser anonymous/private downloads; TLS smoke |
| 03 | UI project create/validation/edit | `api-projects`; Chromium invalid/public profile scenario |
| 04 | Один binary, два сайта без изменения кода | `pilot-demo.test.ts` → `npm run demo`: shop + content с разными hostname/source/canonical profiles |
| 05 | Sitemap index,2 дочерние карты, provenance | `discovery-flow`: XML+gzip maps, общий child DAG; demo HTTP/gzip maps |
| 06 | Feed+sitemap+BFS, дедупликация без утраты источников | `discovery-flow` combine sources + provenance; demo manifests accounted |
| 07 | maxUrls →incomplete и видимая причина | `discovery-flow`, `durable-flow`; demo limited; browser incomplete/diagnostics |
| 08 | Cursor feed,401/timeout — source errors | `discovery-flow` two pages +401/timeout/snapshot/loop; demo TLS bearer feed |
| 09 | Published expected200/404 → finding с entity/evidence | `seo-rules`, `seo-integration`; demo confirmed P0,2 GET confirmations |
| 10 | Deleted404 без ложного P0 | `seo-rules` deleted/unpublished/unknown; `seo-integration`; demo deleted negative |
| 11 | Unknown trailingSlash не создаёт slash error | `seo-rules`, discovery normalization; demo308 alias/unknown policy |
| 12 | Явная canonical policy: conflict/pass | `seo-rules` canonical fixtures; `seo-integration` targets/query identity; demo valid canonical negative |
| 13 | AggregateRating без count | `seo-rules`, `seo-parser`; demo before fixture exact rule |
| 14 | Отсутствие AggregateRating допустимо | `seo-rules` rating absence; demo standalone no rating finding |
| 15 | Broken internal href/sourcePage | `seo-integration` links checked before/after target; demo sourcePage assertion |
| 16 | JS button →needs_review, не invented broken link | `seo-rules` heuristic; demo no request to guessed button URL |
| 17 | robots →skipped_robots, без404/noindex | `http-robots`, `seo-rules`; demo blocked seed never requested |
| 18 | HTML shell →needs_review | `seo-rules` SSR_CONTENT_MISSING; demo shell, без ложного P0; UI объясняет пределы исходного HTML |
| 19 | 301/308 chain и bounded loop | `http-client`; demo durable urls chain + isolated loop incomplete/REDIRECT_LOOP |
| 20 | Retry-After, concurrency, rate, timeout | `http-client` real socket timing/DNS/body/queued Retry-After/circuit tests; не replay benchmark |
| 21 | SSRF private/metadata/forbidden host | `http-policy`, `http-client` private redirects; `api-security`; production policy не ослаблена |
| 22 | DNS pinning/rebinding/TLS/SNI | `http-policy`, `http-client`: mixed A/AAAA, socket peer, rebinding, wrong hostname/untrusted cert; TLS proxy smoke |
| 23 | Worker SIGKILL/restart, durable progress | `durable-flow`: real child death SIGKILL/SIGTERM; resume source cursors/analysis/report recovery |
| 24 | Concurrent same-project conflict/locks | `api-operations`, `api-process`, `durable-storage`, `scheduler`; runtime duplicate409/cancel/resume |
| 25 | CSV formula/HTML escaping | `reports`, `report-integration`, `api-reports`; Chromium hostile evidence no external resources |
| 26 | Private exports, без secrets | `api-auth`, `api-security`, `api-reports`; Chromium downloads/logout/expiry; runtime API smoke |
| 27 | New/persisting/resolved/unknown | `report-diff` complete/incomplete/incompatible; demo release3 resolved; browser real comparison |
| 28 | Report totals/artifacts и bounded large pagination | `report-integration`, `report-memory`100k under96 MiB heap; demo mandatory artifacts/totals; Chromium10001 rows; explicit pipeline load10k/100k |

## Команды и интерпретация

`npm run check` запускает Vitest (включая `pilot-demo.test.ts`), lint/typecheck/build.
`npm run test:e2e` — только собственная панель. `npm run demo` можно выполнить отдельно
после build. `npm run benchmark:pipeline` — явная длительная generated нагрузка,
не часть каждого PR. CI имеет отдельный manual workflow для неё.

Demo запускает восемь scans на двух logical sites с отдельными профилями fault cases,
проверяет stable finding IDs, положительные/отрицательные случаи и release diff.
Demo содержит13 размеченных classification cases (13/13,0 false P0); всего33 assertions.
Это не статистическая оценка точности на произвольном каталоге: обязательные размеченные
positive/negative cases проверяются assertion, а не обещанием «95%» для реальных данных.
В `seo-rules` дополнительно каждый зарегистрированный rule имеет positive/negative fixtures;
P0 negative cases включают неполный/неизвестный backend snapshot, deleted/unpublished,
401/403/429/5xx и неподтверждённый404. Ноль false P0 относится только к этому набору.

## Границы принятия

- Автоматическая матрица не заменяет приёмку оператором реальных credentials, DNS/TLS,
  firewall, backup permissions и конкретного Entity Feed snapshot contract.
- Полная HTTP chain сохранена в `urls.jsonl`; Finding DTO показывает HTTP status/source/
  expected/actual/excerpt, но не всю chain. Панель явно сообщает эту границу.
- Discovery может закончиться в пределах конфигурации, при этом report coverage остаётся
  ограниченным из-за skipped_robots. Такой after не доказывает resolved. В demo robots
  проверен отдельным scan, release diff использует полный сопоставимый dataset.
- Chromium basic accessibility/responsive checks (включая long-name/scheduled-ID reflow390px) не равны полному WCAG или cross-browser audit.
- 10k/100k replay нагрузка не моделирует сеть, retries, server throttling и длительность
  реального каталога. Скорость/лимиты HTTP проверены независимыми real socket tests.
- Human business/security sign-off и необязательный production pilot имеют отдельные gates
  в [pilot.md](pilot.md); автоматический агент не подписывает их от имени владельца.
