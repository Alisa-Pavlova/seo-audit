import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { Launcher } from "chrome-launcher";

// ---- Настройки ----
const WINDOW_DAYS = 28; // окно истории и база для сравнения, как в CrUX
const ALERT_DELTA = 10; // |скор − медиана| ≥ 10 — резкое изменение
const DAY = 24 * 60 * 60 * 1000;

// ---- Утилиты ----
const parseFilename = (filename) => {
  const match = filename.match(/^audit_(\d{2})-(\d{2})-(\d{4})_(\d+)\.json$/);
  if (!match) return null;
  return {
    day: Date.parse(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`),
    runAt: Number(match[4]),
  };
};

const median = (values) => {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const zoneOf = (score) => (score >= 90 ? "good" : score >= 50 ? "warn" : "bad");

const ZONE_CROSSING = {
  "good>warn": "опустилась ниже 90",
  "good>bad": "опустилась ниже 50",
  "warn>bad": "опустилась ниже 50",
  "bad>warn": "поднялась выше 50",
  "bad>good": "поднялась до 90+",
  "warn>good": "поднялась до 90+",
};

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const formatDay = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

const formatDelta = (d) => (d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "±0");

// ---- Сбор истории ----
async function loadReports() {
  const files = await fs.readdir("seo_reports");

  // Один отчёт на день — последний запуск
  const byDay = new Map();
  for (const file of files) {
    const parsed = parseFilename(file);
    if (!parsed) continue;
    const prev = byDay.get(parsed.day);
    if (!prev || prev.runAt < parsed.runAt) byDay.set(parsed.day, { file, ...parsed });
  }

  const reports = [];
  for (const { file, day } of byDay.values()) {
    const content = JSON.parse(
      await fs.readFile(path.join("seo_reports", file), "utf8"),
    );
    reports.push({ ts: day, ...content });
  }
  return reports.sort((a, b) => a.ts - b.ts);
}

// ---- Модель отчёта: всё, что нужно и картинке, и HTML ----
function buildModel(reports) {
  const latest = reports[reports.length - 1];
  const recent = reports.filter((r) => r.ts > latest.ts - WINDOW_DAYS * DAY);
  const dates = recent.map((r) => r.ts);

  const pages = latest.pages.map((latestPage) => {
    const url = latestPage.url || "/";
    const runs = recent.map((r) => r.pages.find((p) => (p.url || "/") === url));
    const scores = runs.map((p) => p?.score ?? null);

    const score = latestPage.score;
    const baseline = median(scores.slice(0, -1));
    const delta = baseline === null ? null : score - baseline;

    // Переход между зонами сам по себе не алерт: страницы у границы 90
    // колеблются через неё почти каждый день
    let alert = null;
    if (delta !== null && Math.abs(delta) >= ALERT_DELTA) {
      alert =
        ZONE_CROSSING[`${zoneOf(baseline)}>${zoneOf(score)}`] ??
        (delta > 0 ? "резкий рост" : "резкое падение");
    }

    const metricHistory = (key) =>
      runs.map((p) => (p?.metrics ? Number(p.metrics[key]) : null));
    const metrics = latestPage.metrics
      ? Object.fromEntries(
          Object.keys(latestPage.metrics).map((key) => [
            key,
            {
              value: Number(latestPage.metrics[key]),
              baseline: median(metricHistory(key).slice(0, -1)),
            },
          ]),
        )
      : null;

    return { url, score, zone: zoneOf(score), baseline, delta, alert, scores, metrics };
  });

  pages.sort((a, b) => a.score - b.score);

  const average = dates.map((_, i) => {
    const values = pages.map((p) => p.scores[i]).filter((v) => v !== null);
    return values.length
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : null;
  });
  const avgScore = average[average.length - 1];
  const avgBaseline = median(average.slice(0, -1));

  return {
    site: new URL(latest.baseUrl).host,
    generatedAt: latest.timestamp,
    windowDays: WINDOW_DAYS,
    alertDelta: ALERT_DELTA,
    dates,
    average: {
      scores: average,
      score: avgScore,
      baseline: avgBaseline,
      delta: avgBaseline === null ? null : avgScore - avgBaseline,
    },
    counts: {
      good: pages.filter((p) => p.zone === "good").length,
      warn: pages.filter((p) => p.zone === "warn").length,
      bad: pages.filter((p) => p.zone === "bad").length,
    },
    pages,
  };
}

// ---- Текст для сообщения в Discord ----
function buildDiscordText(model) {
  const { average: avg } = model;
  const lines = [
    `📊 Lighthouse · ${model.site} · ${formatDay(model.dates.at(-1))}`,
    `Средний скор **${avg.score}**` +
      (avg.delta === null
        ? ""
        : ` (${formatDelta(avg.delta)} к медиане ${model.windowDays} дн.)`),
  ];
  const alerts = model.pages.filter((p) => p.alert);
  if (alerts.length === 0) {
    lines.push("✅ Резких изменений нет");
  } else {
    for (const p of alerts) {
      const icon = p.delta < 0 ? "🔻" : "🔺";
      lines.push(
        `${icon} \`${p.url}\` — **${p.score}** (${formatDelta(p.delta)} к медиане ${p.baseline}), ${p.alert}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

// ---- HTML-отчёт (интерактивный; верхний блок — картинка для Discord) ----
async function buildHtml(model) {
  const [css, js] = await Promise.all([
    fs.readFile("report/page.css", "utf8"),
    fs.readFile("report/page.js", "utf8"),
  ]);
  // "<" экранируется, чтобы URL страниц не могли закрыть <script>
  const data = JSON.stringify(model).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lighthouse · ${model.site}</title>
<style>${css}</style>
</head>
<body>
<main id="app"></main>
<div id="tooltip" role="tooltip" hidden></div>
<script>window.REPORT = ${data};</script>
<script>${js}</script>
</body>
</html>
`;
}

// ---- PNG для Discord: скриншот блока #snapshot ----
async function renderSnapshot(htmlPath, pngPath) {
  const executablePath =
    process.env.CHROME_PATH || Launcher.getInstallations()[0];
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "light" },
    ]);
    await page.goto(`${pathToFileURL(path.resolve(htmlPath)).href}?snapshot`, {
      waitUntil: "load",
    });
    const snapshot = await page.$("#snapshot");
    await snapshot.screenshot({ path: pngPath });
  } finally {
    await browser.close();
  }
}

// ---- Main ----
await fs.mkdir("docs", { recursive: true });
const reports = await loadReports();
const model = buildModel(reports);
const latest = reports[reports.length - 1];

await fs.writeFile("docs/index.html", await buildHtml(model));
await fs.writeFile("docs/discord.txt", buildDiscordText(model));
await fs.writeFile("docs/latest.json", JSON.stringify(latest, null, 2));
await renderSnapshot("docs/index.html", "docs/trends.png");

console.log("render ok");
