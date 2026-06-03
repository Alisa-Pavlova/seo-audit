# SEO Audit

Инструмент для аудита SEO с использованием Lighthouse.

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
tsx seo.ts https://cryptorank.io
```

## Отчеты

Отчеты сохраняются в папку `seo_reports/`:

- `report_[page]_[timestamp].json` — структурированные данные
- `report_[page]_[timestamp].txt` — читаемый отчет
- `audit_[дата]_[timestamp].json` и `audit_[дата]_[timestamp].txt` — итоговые отчеты по всем страницам
