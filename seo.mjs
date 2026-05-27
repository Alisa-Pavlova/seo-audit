import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { JSDOM } from "jsdom";
import { promises as fs } from "fs";
import https from "https";
import http from "http";
import { URL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, "seo_reports");

async function getLighthouseScore(url) {
  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromeFlags: [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    // throttlingMethod: 'simulate' — дефолт, именно его использует Google PSI
    const options = {
      logLevel: "error",
      output: "json",
      port: chrome.port,
      onlyCategories: ["performance"],
      formFactor: "mobile",
      screenEmulation: {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false,
      },
    };

    const runnerResult = await lighthouse(url, options);
    const lhr = runnerResult.lhr;

    chrome.kill();
    return {
      score: Math.round(lhr.categories.performance.score * 100),
      metrics: {
        FCP: Math.round(lhr.audits["first-contentful-paint"].numericValue),
        LCP: Math.round(lhr.audits["largest-contentful-paint"].numericValue),
        TBT: Math.round(lhr.audits["total-blocking-time"].numericValue),
        CLS: lhr.audits["cumulative-layout-shift"].numericValue,
        SI: Math.round(lhr.audits["speed-index"].numericValue),
      },
    };
  } catch (error) {
    console.error("❌ Ошибка Lighthouse:", error.message);
    if (chrome) chrome.kill();
    return null;
  }
}

async function loadPreviousReport(url) {
  try {
    const files = await fs.readdir(REPORTS_DIR);
    const slug = url.replace(/[^a-z0-9]/gi, "_");
    const matching = files
      .filter((f) => f.startsWith(`report_${slug}_`) && f.endsWith(".json"))
      .sort()
      .slice(-2); // берём последние два

    if (matching.length < 1) return null;

    // Второй с конца — предыдущий (последний — это текущий, который ещё не сохранён)
    const prev = matching[matching.length - 1];
    const content = await fs.readFile(path.join(REPORTS_DIR, prev), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function delta(current, previous, higherIsBetter = true) {
  if (previous === null || previous === undefined) return "";
  const diff = current - previous;
  if (diff === 0) return " (→ без изменений)";
  const sign = diff > 0 ? "+" : "";
  const good = higherIsBetter ? diff > 0 : diff < 0;
  return ` (${good ? "▲" : "▼"} ${sign}${diff})`;
}

function deltaMs(current, previous) {
  if (previous === null || previous === undefined) return "";
  const diff = current - previous;
  if (diff === 0) return " (→ без изменений)";
  const sign = diff > 0 ? "+" : "";
  const good = diff < 0;
  return ` (${good ? "✅" : "❗️"} ${sign}${diff}ms)`;
}

function generateReport(url, lhResult, prev) {
  const timestamp = new Date().toLocaleString("ru-RU");
  const prevLh = prev?.lighthouse;
  const prevSeo = prev?.seo;
  const prevDate = prev
    ? new Date(prev.timestamp).toLocaleString("ru-RU")
    : null;

  let report = `
╔══════════════════════════════════════════════════════════════╗
║                    📊 SEO АУДИТ САЙТА                        ║
╚══════════════════════════════════════════════════════════════╝

🌐 URL: ${url}
📅 Дата: ${timestamp}
${prevDate ? `📅 Предыдущий аудит: ${prevDate}` : "📅 Предыдущий аудит: —"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 ПРОИЗВОДИТЕЛЬНОСТЬ (Google PageSpeed Insights / mobile)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  if (lhResult) {
    const score = lhResult.score;
    const m = lhResult.metrics;
    let emoji = score >= 90 ? "🟢" : score >= 50 ? "🟡" : "🔴";

    report += `${emoji} Performance Score: ${score}/100${delta(score, prevLh?.score)}\n\n`;
    report += `   Core Web Vitals:\n`;
    report += `   • FCP (First Contentful Paint): ${m.FCP}ms${deltaMs(m.FCP, prevLh?.metrics?.FCP)}\n`;
    report += `   • LCP (Largest Contentful Paint): ${m.LCP}ms${deltaMs(m.LCP, prevLh?.metrics?.LCP)}\n`;
    report += `   • TBT (Total Blocking Time):      ${m.TBT}ms${deltaMs(m.TBT, prevLh?.metrics?.TBT)}\n`;
    report += `   • CLS (Cumulative Layout Shift):  ${m.CLS}${deltaMs(
      parseFloat(m.CLS) * 1000,
      prevLh?.metrics ? parseFloat(prevLh.metrics.CLS) * 1000 : undefined,
    ).replace("ms", "")}\n`;
    report += `   • SI  (Speed Index):              ${m.SI}ms${deltaMs(m.SI, prevLh?.metrics?.SI)}\n`;

    report += `\n   Порог Google: LCP < 2500ms, TBT < 200ms, CLS < 0.1\n`;
    if (m.LCP > 2500) report += `   ⚠️  LCP превышает норму\n`;
    if (m.TBT > 200) report += `   ⚠️  TBT превышает норму\n`;
    if (parseFloat(m.CLS) > 0.1) report += `   ⚠️  CLS превышает норму\n`;
  } else {
    report += `❌ Не удалось получить данные Lighthouse\n`;
  }

  // Итоговые рекомендации
  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ПРИОРИТЕТНЫЕ ЗАДАЧИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  const tasks = [];

  if (lhResult) {
    if (lhResult.metrics.LCP > 2500)
      tasks.push(`🔴 LCP ${lhResult.metrics.LCP}ms → нужно < 2500ms`);
    if (lhResult.metrics.TBT > 200)
      tasks.push(`🟡 TBT ${lhResult.metrics.TBT}ms → нужно < 200ms`);
    if (parseFloat(lhResult.metrics.CLS) > 0.1)
      tasks.push(`🟡 CLS ${lhResult.metrics.CLS} → нужно < 0.1`);
  }

  if (tasks.length === 0) {
    report += `✨ Критических проблем не обнаружено\n`;
  } else {
    tasks.forEach((t, i) => {
      report += `${i + 1}. ${t}\n`;
    });
  }

  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Аудит завершен
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  return report;
}

// ------------------- 6. Сохранение JSON -------------------
async function saveJsonReport(url, lhResult, htmlData, filename) {
  const report = {
    url,
    timestamp: new Date().toISOString(),
    lighthouse: lhResult
      ? { score: lhResult.score, metrics: lhResult.metrics }
      : null,
    seo:
      htmlData && !htmlData.error
        ? { ...htmlData }
        : { error: htmlData?.error || "Unknown error" },
  };
  await fs.writeFile(filename, JSON.stringify(report, null, 2), "utf-8");
}

// ------------------- 7. Вспомогательные функции -------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAverageLighthouseScore(url, baseUrl) {
  const results = [];

  for (let i = 0; i < 3; i++) {
    console.log(`   Попытка ${i + 1}/3...`);
    const score = await getLighthouseScore(baseUrl + url);
    if (score) {
      results.push(score);
    }
    if (i < 2) {
      await delay(8000); // 8 секунд между попытками (чтобы не забанили)
    }
  }

  // Фильтруем ошибочные результаты (скор < 20 или > 95)
  const validResults = results.filter((r) => r.score >= 10 && r.score <= 100);

  if (validResults.length === 0) {
    console.log(`   ⚠️  Все результаты отсечены как ошибочные`);
    return null;
  }

  // Считаем среднее
  const avgScore = Math.round(
    validResults.reduce((sum, r) => sum + r.score, 0) / validResults.length,
  );

  // Усредняем метрики
  const avgMetrics = {
    FCP: Math.round(
      validResults.reduce((sum, r) => sum + r.metrics.FCP, 0) /
        validResults.length,
    ),
    LCP: Math.round(
      validResults.reduce((sum, r) => sum + r.metrics.LCP, 0) /
        validResults.length,
    ),
    TBT: Math.round(
      validResults.reduce((sum, r) => sum + r.metrics.TBT, 0) /
        validResults.length,
    ),
    CLS: (
      validResults.reduce((sum, r) => sum + parseFloat(r.metrics.CLS), 0) /
      validResults.length
    ).toFixed(3),
    SI: Math.round(
      validResults.reduce((sum, r) => sum + r.metrics.SI, 0) /
        validResults.length,
    ),
  };

  return {
    score: avgScore,
    metrics: avgMetrics,
    validCount: validResults.length,
    totalCount: results.length,
  };
}

function generateSummaryReport(results, baseUrl) {
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}-${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}-${now.getFullYear()}`;

  const validScores = results
    .filter((r) => r.lhResult !== null)
    .map((r) => r.lhResult.score);
  const overallAvgScore =
    validScores.length > 0
      ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
      : 0;

  // Подготовка данных для таблицы
  const rows = results.map((r) => {
    const scoreEmoji =
      r.lhResult?.score >= 90 ? "🟢" : r.lhResult?.score >= 50 ? "🟡" : "🔴";
    return {
      url: r.url.length > 30 ? r.url.substring(0, 27) + "..." : r.url,
      score: r.lhResult?.score ?? "N/A",
      lcp: r.lhResult?.metrics?.LCP ?? "N/A",
      tbt: r.lhResult?.metrics?.TBT ?? "N/A",
      cls: r.lhResult?.metrics?.CLS ?? "N/A",
      status: r.lhResult
        ? `${scoreEmoji} ${r.lhResult.validCount}/${r.lhResult.totalCount}`
        : "❌",
    };
  });

  // Вычисление ширины столбцов
  const colWidths = {
    url: Math.max(5, ...rows.map((r) => String(r.url).length)),
    score: Math.max(5, ...rows.map((r) => String(r.score).length)),
    lcp: Math.max(8, ...rows.map((r) => String(r.lcp).length)),
    tbt: Math.max(8, ...rows.map((r) => String(r.tbt).length)),
    cls: Math.max(3, ...rows.map((r) => String(r.cls).length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };

  // Функция для форматирования строки таблицы
  const padRight = (str, width) => String(str).padEnd(width);
  const padLeft = (str, width) => String(str).padStart(width);

  // Построение разделителя
  const separator = `┌─${"-".repeat(colWidths.url)}─┬─${"-".repeat(colWidths.score)}─┬─${"-".repeat(
    colWidths.lcp,
  )}─┬─${"-".repeat(colWidths.tbt)}─┬─${"-".repeat(colWidths.cls)}─┬─${"-".repeat(colWidths.status)}─┐`;
  const divider = `├─${"-".repeat(colWidths.url)}─┼─${"-".repeat(colWidths.score)}─┼─${"-".repeat(
    colWidths.lcp,
  )}─┼─${"-".repeat(colWidths.tbt)}─┼─${"-".repeat(colWidths.cls)}─┼─${"-".repeat(colWidths.status)}─┤`;
  const footer = `└─${"-".repeat(colWidths.url)}─┴─${"-".repeat(colWidths.score)}─┴─${"-".repeat(
    colWidths.lcp,
  )}─┴─${"-".repeat(colWidths.tbt)}─┴─${"-".repeat(colWidths.cls)}─┴─${"-".repeat(colWidths.status)}─┘`;

  // Построение таблицы
  let tableLines = [separator];

  // Заголовок
  tableLines.push(
    `│ ${padRight("URL", colWidths.url)} │ ${padLeft("Score", colWidths.score)} │ ${padLeft(
      "LCP (ms)",
      colWidths.lcp,
    )} │ ${padLeft("TBT (ms)", colWidths.tbt)} │ ${padLeft("CLS", colWidths.cls)} │ ${padRight(
      "Статус",
      colWidths.status,
    )} │`,
  );
  tableLines.push(divider);

  // Строки данных
  rows.forEach((r) => {
    tableLines.push(
      `│ ${padRight(r.url, colWidths.url)} │ ${padLeft(r.score, colWidths.score)} │ ${padLeft(
        r.lcp,
        colWidths.lcp,
      )} │ ${padLeft(r.tbt, colWidths.tbt)} │ ${padLeft(r.cls, colWidths.cls)} │ ${padRight(
        r.status,
        colWidths.status,
      )} │`,
    );
  });

  tableLines.push(footer);

  const table = tableLines.join("\n");

  let report = `
╔══════════════════════════════════════════════════════════════╗
║              📊 SEO АУДИТ - ИТОГОВЫЙ ОТЧЕТ                  ║
╚══════════════════════════════════════════════════════════════╝

🌐 Сайт: ${baseUrl}
📅 Дата: ${now.toLocaleString("ru-RU")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 ОБЩИЕ ПОКАЗАТЕЛИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Средний Performance Score по всем страницам: ${overallAvgScore}/100

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 РЕЗУЛЬТАТЫ ПО СТРАНИЦАМ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${table}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Аудит завершен
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  return { report, dateStr };
}

// ------------------- 8. Основная функция -------------------
async function runSeoAuditBatch(baseUrl) {
  await fs.mkdir(REPORTS_DIR, { recursive: true });

  const urls = [
    "",
    "/drophunting",
    "/funding-rounds",
    "/all-coins-list",
    "/funds",
    "/insights/research/coinhold-by-emcd-fee-based-yield-on-a-mining-ecosystem",
    "/upcoming-ico",
    "/price/bitcoin",
    "/token-unlock",
    "/trending",
    "/plans",
    "/gainers",
  ];

  const results = [];

  for (let idx = 0; idx < urls.length; idx++) {
    const url = urls[idx];
    const fullUrl = baseUrl + url;

    console.log(`\n📍 Страница ${idx + 1}/${urls.length}: ${url}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    console.log("⚡ Запуск Lighthouse (3 запуска)...");
    const lhResult = await getAverageLighthouseScore(url, baseUrl);

    // Загружаем предыдущий отчет для сравнения
    const prev = await loadPreviousReport(url);

    const report = generateReport(fullUrl, lhResult, prev);
    console.log(report);

    // Сохраняем
    const slug = url.replace(/[^a-z0-9]/gi, "_");
    const auditTimestamp = Date.now();
    const txtFilename = path.join(
      REPORTS_DIR,
      `report_${slug}_${auditTimestamp}.txt`,
    );
    const jsonFilename = path.join(
      REPORTS_DIR,
      `report_${slug}_${auditTimestamp}.json`,
    );

    await fs.writeFile(txtFilename, report, "utf-8");
    await saveJsonReport(fullUrl, lhResult, htmlData, jsonFilename);

    results.push({ url, lhResult, htmlData });

    // Задержка перед следующей страницей
    if (idx < urls.length - 1) {
      console.log("⏳ Пауза перед следующей страницей (15 сек)...");
      await delay(15000);
    }
  }

  // Генерируем итоговый отчет
  console.log(
    "\n\n═══════════════════════════════════════════════════════════",
  );
  console.log("📊 ФОРМИРОВАНИЕ ИТОГОВОГО ОТЧЕТА");
  console.log("═══════════════════════════════════════════════════════════\n");

  const { report: summaryReport, dateStr } = generateSummaryReport(
    results,
    baseUrl,
  );
  console.log(summaryReport);

  // Сохраняем итоговый отчет
  const summaryTxtFilename = path.join(
    REPORTS_DIR,
    `audit_${Date.now()}_${dateStr}.txt`,
  );
  const summaryJsonFilename = path.join(
    REPORTS_DIR,
    `audit_${Date.now()}_${dateStr}.json`,
  );

  await fs.writeFile(summaryTxtFilename, summaryReport, "utf-8");

  const summaryJsonData = {
    timestamp: new Date().toISOString(),
    baseUrl,
    overallScore:
      results.filter((r) => r.lhResult).length > 0
        ? Math.round(
            results
              .filter((r) => r.lhResult)
              .map((r) => r.lhResult.score)
              .reduce((a, b) => a + b, 0) /
              results.filter((r) => r.lhResult).length,
          )
        : null,
    pages: results.map((r) => ({
      url: r.url,
      score: r.lhResult?.score ?? null,
      metrics: r.lhResult?.metrics ?? null,
      validCount: r.lhResult?.validCount ?? null,
      totalCount: r.lhResult?.totalCount ?? null,
    })),
  };
  await fs.writeFile(
    summaryJsonFilename,
    JSON.stringify(summaryJsonData, null, 2),
    "utf-8",
  );

  console.log(`\n💾 Все отчеты сохранены в ./seo_reports/`);
  console.log(`📄 Итоговый отчет: audit_${dateStr}.txt`);
}

// ------------------- 9. Запуск -------------------
const baseUrl = process.argv[2] || "https://cryptorank.io";
runSeoAuditBatch(baseUrl).catch(console.error);
