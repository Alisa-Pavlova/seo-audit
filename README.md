# SEO Audit

Инструмент для аудита SEO с использованием Lighthouse и парсингом HTML.

## Установка

```bash
npm ci
```

## Использование

```bash
npm run audit
```

или для конкретного домена:

```bash
node seo.mjs https://example.com
```

## Отчеты

Отчеты сохраняются в папку `seo_reports/`:
- `report_[page]_[timestamp].json` — структурированные данные
- `report_[page]_[timestamp].txt` — читаемый отчет
- `audit_[дата].json` и `audit_[дата].txt` — итоговые отчеты по всем страницам
