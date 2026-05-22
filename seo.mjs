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

// ------------------- 1. Lighthouse (настройки как у Google PSI) -------------------
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

// ------------------- 2. HTTP запрос -------------------
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      timeout,
    };

    const req = protocol.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, data }),
      );
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });
    req.end();
  });
}

// ------------------- 3. Парсинг HTML -------------------
async function parseHtmlHeaders(url) {
  try {
    const response = await fetchUrl(url, 15000);

    if (response.statusCode !== 200) {
      throw new Error(`HTTP ${response.statusCode}`);
    }

    const dom = new JSDOM(response.data);
    const document = dom.window.document;

    const title = document.querySelector("title");
    const titleText = title ? title.textContent.trim() : null;

    const metaDesc = document.querySelector('meta[name="description"]');
    const descText = metaDesc ? metaDesc.getAttribute("content").trim() : null;

    const metaRobots = document.querySelector('meta[name="robots"]');
    const robotsText = metaRobots
      ? metaRobots.getAttribute("content").trim()
      : null;

    const canonical = document.querySelector('link[rel="canonical"]');
    const canonicalUrl = canonical
      ? canonical.getAttribute("href").trim()
      : null;

    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');

    const h1Elements = document.querySelectorAll("h1");
    const h2Elements = document.querySelectorAll("h2");
    const h3Elements = document.querySelectorAll("h3");

    return {
      statusCode: response.statusCode,
      title: titleText,
      titleLength: titleText ? titleText.length : 0,
      metaDescription: descText,
      metaDescriptionLength: descText ? descText.length : 0,
      metaRobots: robotsText,
      canonical: canonicalUrl,
      ogTitle: ogTitle ? ogTitle.getAttribute("content") : null,
      ogDescription: ogDesc ? ogDesc.getAttribute("content") : null,
      h1: h1Elements.length > 0 ? h1Elements[0].textContent.trim() : null,
      h1Count: h1Elements.length,
      h2Count: h2Elements.length,
      h3Count: h3Elements.length,
      h1List: Array.from(h1Elements).map((el) => el.textContent.trim()),
    };
  } catch (error) {
    console.error("❌ Ошибка загрузки страницы:", error.message);
    return { error: error.message };
  }
}

// ------------------- 4. Загрузка предыдущего отчета -------------------
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

// ------------------- 5. Генерация отчета -------------------
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
  return ` (${good ? "▲" : "▼"} ${sign}${diff}ms)`;
}

function generateReport(url, lhResult, htmlData, prev) {
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

  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 SEO ЭЛЕМЕНТЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  if (htmlData && !htmlData.error) {
    report += `📡 HTTP Status: ${htmlData.statusCode}\n\n`;

    // Title
    if (!htmlData.title) {
      report += `🏷️  Title: ❌ Отсутствует\n`;
    } else {
      const titleChange =
        prevSeo?.title && prevSeo.title !== htmlData.title
          ? " ⚡ изменился"
          : "";
      report += `🏷️  Title (${htmlData.titleLength} симв.${delta(
        htmlData.titleLength,
        prevSeo?.titleLength,
      )}${titleChange}):\n`;
      report += `   "${htmlData.title}"\n`;
      if (htmlData.titleLength < 30)
        report += `   ⚠️  Слишком короткий (норма: 30–60)\n`;
      else if (htmlData.titleLength > 70)
        report += `   ⚠️  Слишком длинный, обрежется в выдаче (норма: 30–60)\n`;
      else report += `   ✅ Длина в норме\n`;
    }

    // Meta Description
    report += `\n📄 Meta Description`;
    if (!htmlData.metaDescription) {
      report += `: ❌ Отсутствует\n`;
    } else {
      const descChange =
        prevSeo?.metaDescription &&
        prevSeo.metaDescription !== htmlData.metaDescription
          ? " ⚡ изменилось"
          : "";
      report += ` (${htmlData.metaDescriptionLength} симв.${delta(
        htmlData.metaDescriptionLength,
        prevSeo?.metaDescriptionLength,
      )}${descChange}):\n`;
      report += `   "${htmlData.metaDescription}"\n`;
      if (htmlData.metaDescriptionLength < 50)
        report += `   ⚠️  Слишком короткое (норма: 50–160)\n`;
      else if (htmlData.metaDescriptionLength > 160)
        report += `   ⚠️  Слишком длинное (норма: 50–160)\n`;
      else report += `   ✅ Длина в норме\n`;
    }

    // OG теги
    report += `\n🔵 OG Title: ${htmlData.ogTitle || "❌ Не задан"}\n`;
    report += `🔵 OG Description: ${htmlData.ogDescription || "❌ Не задан"}\n`;

    // Robots & Canonical
    report += `\n🤖 Meta Robots: ${htmlData.metaRobots || "❌ Не задан"}\n`;
    report += `🔗 Canonical: ${htmlData.canonical || "❌ Не задан"}\n`;
    if (htmlData.canonical && htmlData.canonical !== url) {
      report += `   ℹ️  Canonical указывает на другой URL\n`;
    }

    // H1
    report += `\n📌 H1 (${htmlData.h1Count} шт.${delta(htmlData.h1Count, prevSeo?.h1Count)}):\n`;
    if (htmlData.h1Count === 0) {
      report += `   ❌ Отсутствует\n`;
    } else {
      report += `   "${htmlData.h1}"\n`;
      if (htmlData.h1Count > 1) {
        report += `   ⚠️  Несколько H1: ${htmlData.h1List.join(" | ").substring(0, 200)}\n`;
      } else {
        report += `   ✅ Один H1\n`;
      }
      if (htmlData.title && htmlData.h1 === htmlData.title) {
        report += `   ℹ️  H1 совпадает с Title — лучше разнообразить\n`;
      }
    }

    // Структура заголовков
    report += `\n📊 Заголовки: H2: ${htmlData.h2Count}${delta(htmlData.h2Count, prevSeo?.h2Count)} | H3: ${
      htmlData.h3Count
    }${delta(htmlData.h3Count, prevSeo?.h3Count)}\n`;
    if (htmlData.h2Count === 0)
      report += `   ⚠️  Нет H2 — добавьте для структуры контента\n`;
  } else if (htmlData?.error) {
    report += `❌ Не удалось загрузить страницу: ${htmlData.error}\n`;
  }

  // Итоговые рекомендации
  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ПРИОРИТЕТНЫЕ ЗАДАЧИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  const tasks = [];
  if (htmlData && !htmlData.error) {
    if (!htmlData.title) tasks.push("🔴 Добавить <title>");
    if (!htmlData.metaDescription) tasks.push("🟡 Добавить meta description");
    if (htmlData.h1Count === 0) tasks.push("🔴 Добавить H1");
    if (htmlData.h1Count > 1) tasks.push("🟡 Оставить один H1");
    if (htmlData.titleLength > 70)
      tasks.push("🟡 Сократить title до 60 символов");
    if (htmlData.titleLength < 30 && htmlData.title)
      tasks.push("🟡 Расширить title до 30–60 символов");
    if (htmlData.metaDescriptionLength > 160)
      tasks.push("🟡 Сократить meta description до 160 символов");
    if (htmlData.metaDescriptionLength < 50 && htmlData.metaDescription)
      tasks.push("🟡 Расширить meta description до 50–160 символов");
    if (htmlData.h2Count === 0 && htmlData.h1Count > 0)
      tasks.push("📑 Добавить H2 для структуры");
    if (!htmlData.ogTitle) tasks.push("🔵 Добавить og:title");
    if (!htmlData.ogDescription) tasks.push("🔵 Добавить og:description");
  }
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
  const validResults = results.filter((r) => r.score >= 20 && r.score <= 95);

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

    console.log("📡 Анализ HTML структуры...");
    const htmlData = await parseHtmlHeaders(fullUrl);

    console.log("⚡ Запуск Lighthouse (3 попытки)...");
    const lhResult = await getAverageLighthouseScore(url, baseUrl);

    // Загружаем предыдущий отчет для сравнения
    const prev = await loadPreviousReport(url);

    const report = generateReport(fullUrl, lhResult, htmlData, prev);
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
  const summaryTxtFilename = path.join(REPORTS_DIR, `audit_${dateStr}.txt`);
  const summaryJsonFilename = path.join(REPORTS_DIR, `audit_${dateStr}.json`);

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
