# Отчёты и сравнение — EPIC-06

Worker после завершённого анализа автоматически создаёт JSONL, CSV, summary, seek/ID
индексы и HTML (если `reports.htmlEnabled`). Данные берутся только до подтверждённой
границы WAL. Ошибки источников и анализа остаются в отдельных JSONL, не становятся
SEO-находками. Неполный скан явно помечен в summary и HTML.

## Файлы и совместимость

Исходные `manifest.json`, `urls.jsonl`, `findings.jsonl`, `summary.json` (discovery1.0),
`analysis-summary.json`, `analysis_errors.jsonl` сохраняют контракты EPIC-04/05.
См. ADR-014: общий report summary добавлен как `report-summary.json`, чтобы не ломать
сохранённые данные. Внутри каждого bundle `summary.json` уже имеет ReportSummary1.0.

```text
scan/
  reports.json                      атомарный pointer, публикуется последним
  report-summary.json               удобный alias текущего report summary
  findings.csv                      удобный alias
  report.html                       удобный alias (если включён)
  finding_index.json                удобный alias descriptor
  reports/GENERATION/
    findings.jsonl                  точный снимок committed findings
    findings.csv
    report.html                     если включён
    summary.json
    finding_index.json              context, counters, SHA256 JSONL, размеры
    indexes/all.idx                 offset:uint64BE + length:uint32BE
    indexes/DIMENSION/VALUE.idx      такие же pointers
    ids/root.json                   корень hash-trie
    ids/PREFIX.json                 leaf/branch metadata
    ids/PREFIX.bin                  SHA256:32 bytes + pointer:12 bytes
  comparisons/BEFORE_SCAN/
    diff.json                       атомарный pointer
    GENERATION/
      diff.jsonl
      diff.csv
      diff.html
      summary.json
      index.json
      indexes/all.idx
      indexes/STATUS.idx
```

Авторитетны pointer и immutable generation, а не отдельные корневые aliases: во время
публикации aliases могут относиться к разным поколениям. Reader проверяет версии,
identity, checkpoint checksum, текущий статус manifest и размеры. Active/stale отчёт
не обслуживается; открытый reader закрепляет выбранное immutable поколение.
SHA256 JSONL записан для проверки целостности/архивации; каждый page не перечитывает
весь файл ради checksum. Runtime-валидация каждой прочитанной строки обязательна.

Duration считается до конца наблюдений (автоэкспорт) либо сохранённого finishedAt (пересборка);
время, прошедшее после скана, не увеличивает duration при повторном экспорте.

Сначала пишется staging, затем fsync файлов/директорий, rename поколения и pointer.
Ошибка/отмена не заменяет предыдущий pointer. При ошибке автоматического экспорта
worker сохраняет `incomplete/report_generation_failed`: `scan --action resume`
повторяет отчёты из сохранённого анализа без GET. Крах может оставить `.tmp` либо
завершённое orphan generation; оно не читается по pointer. Старые поколения сохранены
для открытых readers; их жизненный цикл совпадает с retention всего scan. Повторная
ручная пересборка увеличивает место на диске; удаления/GC поколений в EPIC-06 нет.
Сравнение хранится в новом scan; его исторические данные живут до retention этого scan,
даже если baseline уже удалён. Это явно сохранённое сравнение указанных generations;
пересборка исходных отчётов не переписывает его автоматически.

## CLI без сетевого обхода

После `npm run build`, под тем же UID и DATA_DIR, что worker:

```bash
npm run reports -- --action build --data ./data --project-id shop --scan-id run-2
npm run reports -- --action page --data ./data --project-id shop --scan-id run-2 --limit 50
npm run reports -- --action page --data ./data --project-id shop --scan-id run-2 --filter '{"severity":"P1","source":"backend"}'
npm run reports -- --action find --data ./data --project-id shop --scan-id run-2 --id sha256:REPLACE_WITH_64_HEX
npm run reports -- --action compare --data ./data --project-id shop --before-id run-1 --scan-id run-2
npm run reports -- --action diff-page --data ./data --project-id shop --before-id run-1 --scan-id run-2 --status unknown
```

Build/compare берут project flock; конкурентный writer получает exit3. Успех exit0,
ошибка exit1 с обезличенным кодом. Build требует завершённую фазу анализа1.1 и stopped
manifest. Для legacy discovery-only1.0 отчёт SEO не выдумывается. Это CLI оператора,
не публичный API; web/root/private routes по-прежнему 401 до EPIC-07.

CSV по умолчанию UTF-8 BOM + RFC4180 CRLF; `build/compare --no-bom` отключает BOM.
Все ячейки quoted; `= + - @`, включая whitespace/control/bidi prefixes, нейтрализованы
апострофом. HTML self-contained, без JS/CDN/активных ссылок; все значения escaped,
добавлена CSP. JSONL остаётся структурированными фактами, HTML-escape к нему не применяется.

## Постраничное чтение

`FileReportReader.page` принимает `filter`, `limit` (1…200, default50), `cursor`,
`sort` (`asc/desc` по порядку появления в committed findings). Это не глобальная
сортировка по любому столбцу: её API/UI контракт ещё предстоит определить в EPIC-07/08.
Фильтры AND: `severity`, `ruleId`, `verdict`, `confidence`, `source`, `entityType`,
`httpStatus`, `entityId`, `urlContains` (case-sensitive). Статус самого scan находится
в descriptor; `verdict` различает finding/needs_review. Diff page фильтрует `status`.

Выбирается самый короткий индекс по измерениям; text/entityId проверяются по строкам.
За один вызов просмотрено не больше 10 000 кандидатов. Поэтому страница поиска может
быть пустой с непустым nextCursor: продолжать до null. `total` точен для нуля/одного
индексного фильтра, иначе null; `candidateCount` — не число совпадений. Cursor привязан
к generation, фильтрам и направлению; изменение параметров требует начать с первой
страницы. Он не является разрешением доступа: будущий API обязан проверять сессию,
проект и scan при каждом запросе. Readers не создают Map/array всех findings.

Writer держит до 2 МиБ заполненных buffers (выделенные фиксированные blocks до
32 КиБ × 512 paths = 16 МиБ; разовый bounded record обрабатывается отдельно), до 512 buffered paths и до 4096 ID records на сортируемый leaf.
ID trie перепартиционирует переполненные buckets, включая перекошенные hashes.
Merge diff держит две текущие находки. Последняя страница использует seek без чтения
всех предыдущих строк. 100k fixture проверяет именно reports/index/diff; это не полный
нагрузочный тест crawler/Entity Feed на 100k URL.

## Правила сравнения

ID EPIC-05 не включает scanId: project/rule/normalized target/entity identity.
Одинаковый ID → persisting, новый → new; фиксируются изменения severity/verdict,
firstSeenAt берётся из двух наблюдений, lastSeenAt — из последнего наблюдения.
Это сравнение двух запусков, а не глобальный реестр истории всех запусков.

Отсутствующий прежний finding → resolved только если второй отчёт полный и совместим
по scopeHash/policyHash/engine/ruleVersion. Иначе unknown с причиной. Отсутствие
прежнего needs_review всегда unknown. Robots exclusions также делают полноту evidence отчёта ограниченной, даже если discovery completed.
Неполный новый скан может подтвердить persisting
или new, но не resolved. Resolved означает отсутствие воспроизведения в сопоставимом
скане, а не доказанную причину исправления и не состояние индекса поисковой системы.

Scope учитывает base URL/allowlist/discovery/feed; policy — HTTP/canonical/rule options.
Изменение severity само по себе не ломает сравнение, изменение охвата/семантики — ломает.
Оба scan должны принадлежать одному проекту; before.createdAt ≤ after.createdAt.

## Проверки

`npm run check` включает safety/consistency/recovery/CLI и отдельный child benchmark:
`node --max-old-space-size=96 tests/fixtures/reports/benchmark.mjs`.
Он создаёт 100k JSONL/CSV/HTML строк, сверяет totals, делает seek последних 10,
проверяет ID/filter/text budget и diff100k→empty incomplete без false-resolved.
Проверка собранного контейнера (синтетический локальный сайт, nonroot /data,
временные данные удаляются, production targets не запрашиваются):

```bash
DOCKER_CONFIG=/workspace/.docker-hsi docker compose -f deploy/compose.yaml exec -T inspector-worker node --input-type=module < scripts/smoke-reports.mjs
```

AC-25/27 проверяются здесь; AC-28 покрыт для файлов/пагинации, UI часть — EPIC-08.
