# Coverage map: SABOSPORTS audit → HSI MVP

**Назначение:** контроль охвата 18 исходных пунктов ТЗ. Это НЕ список доказанных ошибок на текущем сайте.

| № ТЗ | Тема | Проверка MVP | Степень достоверности / результат |
|---|---|---|---|
| 1 | Индексация | HTTP 200/404, robots, noindex, sitemap, backend expectation | Только техническая доступность; реальный индекс Google/Яндекса неизвестен |
| 2 | Главная | meta/H1, IDs, manifest, `<a href>`, image warnings | Да, по source HTML; popup/CLS/UX без браузера не проверить |
| 3 | Счётчики | Поиск JS-тегов/ID счётчиков в HTML | Частично; корректность событий неизвестна |
| 4 | Битые ссылки | Собрать href + source page, проверить HTTP и redirects | Да, источники ссылок видимы только если есть в SSR |
| 5 | Внутренние дубли | Нормализация, canonical, title/body hashes, entity feed | Частично, нельзя считать любой одинаковый контент ошибкой |
| 6 | Sitemap | XML/index/gzip, coverage backend, canonical/status | Да, если все источники собраны без ошибок |
| 7 | Внешние ссылки | href/rel и хосты | Да, но статус внешних доменов по умолчанию НЕ проверяем ради безопасности |
| 8 | Слеши | GET обеих форм, redirect chain, policy | Да; никакой универсальной «правильной» формы |
| 9 | .htaccess | Только наблюдаемое HTTP-поведение | Никакого доступа к конфигурации Next.js/nginx |
| 10 | Ошибка 404 | Unknown-route probes, expected entity checks | Да для конкретных кодов; soft404 иногда needs_review |
| 11 | Страница 404 | Статус, ссылки, title, контент | Частично; визуальный дизайн не оцениваем |
| 12 | JS-ссылки | `<a href>` и эвристика button nav | Частично: действие JS нельзя установить без браузера |
| 13 | Скорость | TTFB, total fetch time, размер HTML | Только серверные метрики нашего клиента, не PSI/LCP/INP/CLS |
| 14 | Микроразметка | JSON-LD parse/Product/Offer/AggregateRating | Да на уровне заявленных правил; показ rich results не гарантируется |
| 15 | HTML-валидация | DOM IDs / некоторые семантические сигналы | Частично; полный W3C-валидатор не включён |
| 16 | Статусы товаров | Entity feed expected vs current HTTP | Да для наших запросов; не ответ реального поискового робота |
| 17 | Блог | Факт `/blog/` при явном expected URL | Наличие блога не обязательный SEO-критерий |
| 18 | Canonical | Source HTML, duplicates, target HTTP, sitemap coherence | Да с профилем URL, не автоматическая нормализация со слешем |

**Что нельзя назвать доказанным без дополнительных источников:** ответы настоящего Googlebot и Яндекс.Бота, факт индексации в поисковых системах, качество мобильной UX и hydration, Core Web Vitals, необходимость редакционного блога, причины 404 в CDN/WAF/SSR.

### Case IDs для демонстрационного пилота

- `SABO-01`: published product + HTTP 200 → нет P0, даже при историческом сообщении о Googlebot 404.
- `SABO-02`: published product + HTTP 404 → P0 с entity ID, URL, временем ответа, retry evidence.
- `SABO-03`: `aggregateRating.ratingValue=5` без count → P1 JSON-LD rule.
- `SABO-04`: canonical без слеша при конфигурации `trailingSlash=without` → pass.
- `SABO-05`: неизвестный slug категории + fallback 200 → needs_review без уверенного признака, finding при подтверждённом API-контрактом отсутствии.
- `SABO-06`: страница с несколькими `id=deadlift-ii-red` → P2/INFO, не SEO P0.
- `SABO-07`: HTML, сохранённый из Chrome после JS-навигации, не используется как server HTML; запрос только через HTTP client.