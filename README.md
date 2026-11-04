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

- `audit_[дата]_[timestamp].json` — итоговый отчет по всем страницам (скор и метрики Lighthouse)

Подробный отчет по каждой странице выводится в консоль.
