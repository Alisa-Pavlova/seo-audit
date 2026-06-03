import lighthouse, { type RunnerResult } from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, "seo_reports");

interface LighthouseMetrics {
  FCP: number;
  LCP: number;
  TBT: number;
  CLS: number | string;
  SI: number;
}

interface LighthouseScore {
  score: number;
  metrics: LighthouseMetrics;
}

interface AverageLighthouseScore extends LighthouseScore {
  validCount: number;
  totalCount: number;
}

interface PreviousReport {
  timestamp: string;
  lighthouse?: LighthouseScore | null;
  seo?: unknown;
}

interface AuditResult {
  url: string;
  lhResult: AverageLighthouseScore | null;
}

interface TableRow {
  url: string;
  score: number | string;
  lcp: number | string;
  tbt: number | string;
  cls: number | string;
  status: string;
}

interface ColumnWidths {
  url: number;
  score: number;
  lcp: number;
  tbt: number;
  cls: number;
  status: number;
}

interface SummaryReportResult {
  report: string;
  dateStr: string;
}

interface SummaryJsonData {
  timestamp: string;
  baseUrl: string;
  overallScore: number | null;
  pages: Array<{
    url: string;
    score: number | null;
    metrics: LighthouseMetrics | null;
    validCount: number | null;
    totalCount: number | null;
  }>;
}

async function getLighthouseScore(
  url: string,
): Promise<LighthouseScore | null> {
  let chrome: chromeLauncher.LaunchedChrome | undefined;
  try {
    chrome = await chromeLauncher.launch({
      chromeFlags: [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const options = {
      logLevel: "error" as const,
      output: "json" as const,
      port: chrome.port,
      onlyCategories: ["performance"],
      formFactor: "mobile" as const,
      screenEmulation: {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false,
      },
    };

    const runnerResult = (await lighthouse(url, options)) as RunnerResult;
    const lhr = runnerResult.lhr;

    chrome.kill();
    return {
      score: Math.round(lhr.categories.performance.score * 100),
      metrics: {
        FCP: Math.round(
          lhr.audits["first-contentful-paint"].numericValue as number,
        ),
        LCP: Math.round(
          lhr.audits["largest-contentful-paint"].numericValue as number,
        ),
        TBT: Math.round(
          lhr.audits["total-blocking-time"].numericValue as number,
        ),
        CLS: lhr.audits["cumulative-layout-shift"].numericValue as number,
        SI: Math.round(lhr.audits["speed-index"].numericValue as number),
      },
    };
  } catch (error) {
    console.error("❌ Ошибка Lighthouse:", (error as Error).message);
    if (chrome) chrome.kill();
    return null;
  }
}

async function loadPreviousReport(url: string): Promise<PreviousReport | null> {
  try {
    const files = await fs.readdir(REPORTS_DIR);
    const slug = url.replace(/[^a-z0-9]/gi, "_");
    const matching = files
      .filter((f) => f.startsWith(`report_${slug}_`) && f.endsWith(".json"))
      .sort()
      .slice(-2);

    if (matching.length < 1) return null;

    const prev = matching[matching.length - 1];
    const content = await fs.readFile(path.join(REPORTS_DIR, prev), "utf-8");
    return JSON.parse(content) as PreviousReport;
  } catch {
    return null;
  }
}

function delta(
  current: number,
  previous: number | undefined | null,
  higherIsBetter: boolean = true,
): string {
  if (previous === null || previous === undefined) return "";
  const diff = current - previous;
  if (diff === 0) return " (→ без изменений)";
  const sign = diff > 0 ? "+" : "";
  const good = higherIsBetter ? diff > 0 : diff < 0;
  return ` (${good ? "▲" : "▼"} ${sign}${diff})`;
}

function deltaMs(current: number, previous: number | undefined | null): string {
  if (previous === null || previous === undefined) return "";
  const diff = current - previous;
  if (diff === 0) return " (→ без изменений)";
  const sign = diff > 0 ? "+" : "";
  const good = diff < 0;
  return ` (${good ? "✅" : "❗️"} ${sign}${diff}ms)`;
}

function generateReport(
  url: string,
  lhResult: LighthouseScore | null,
  prev: PreviousReport | null,
): string {
  const timestamp = new Date().toLocaleString("ru-RU");
  const prevLh = prev?.lighthouse;
  const prevDate = prev
    ? new Date(prev.timestamp).toLocaleString("ru-RU")
    : null;

  let report = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 URL: ${url}
📅 Дата: ${timestamp}
${prevDate ? `📅 Предыдущий аудит: ${prevDate}` : "📅 Предыдущий аудит: —"}


`;

  if (lhResult) {
    const score = lhResult.score;
    const m = lhResult.metrics;
    const emoji = score >= 90 ? "🟢" : score >= 50 ? "🟡" : "🔴";

    report += `${emoji} Performance Score: ${score}/100${delta(score, prevLh?.score)}\n\n`;
    report += `   Core Web Vitals:\n`;
    report += `   • FCP (First Contentful Paint): ${m.FCP}ms${deltaMs(m.FCP, prevLh?.metrics?.FCP)}\n`;
    report += `   • LCP (Largest Contentful Paint): ${m.LCP}ms${deltaMs(m.LCP, prevLh?.metrics?.LCP)}\n`;
    report += `   • TBT (Total Blocking Time):      ${m.TBT}ms${deltaMs(m.TBT, prevLh?.metrics?.TBT)}\n`;
    report += `   • CLS (Cumulative Layout Shift):  ${m.CLS}${deltaMs(
      parseFloat(m.CLS as unknown as string) * 1000,
      prevLh?.metrics
        ? parseFloat(prevLh.metrics.CLS as unknown as string) * 1000
        : undefined,
    ).replace("ms", "")}\n`;
    report += `   • SI  (Speed Index):              ${m.SI}ms${deltaMs(m.SI, prevLh?.metrics?.SI)}\n`;

    report += `\n   Порог Google: LCP < 2500ms, TBT < 200ms, CLS < 0.1\n`;
    if (m.LCP > 2500) report += `   ⚠️  LCP превышает норму\n`;
    if (m.TBT > 200) report += `   ⚠️  TBT превышает норму\n`;
    if (parseFloat(m.CLS as unknown as string) > 0.1)
      report += `   ⚠️  CLS превышает норму\n`;
  } else {
    report += `❌ Не удалось получить данные Lighthouse\n`;
  }

  const tasks: string[] = [];

  if (lhResult) {
    report += `

 ПРИОРИТЕТНЫЕ ЗАДАЧИ

`;

    if (lhResult.metrics.LCP > 2500)
      tasks.push(`🔴 LCP ${lhResult.metrics.LCP}ms → нужно < 2500ms`);
    if (lhResult.metrics.TBT > 200)
      tasks.push(`🟡 TBT ${lhResult.metrics.TBT}ms → нужно < 200ms`);
    if (parseFloat(lhResult.metrics.CLS as unknown as string) > 0.1)
      tasks.push(`🟡 CLS ${lhResult.metrics.CLS} → нужно < 0.1`);
  }

  if (tasks.length > 0) {
    tasks.forEach((t, i) => {
      report += `${i + 1}. ${t}\n`;
    });
  }

  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  return report;
}

async function saveJsonReport(
  url: string,
  lhResult: LighthouseScore | null,
  filename: string,
): Promise<void> {
  const report = {
    url,
    timestamp: new Date().toISOString(),
    lighthouse: lhResult
      ? { score: lhResult.score, metrics: lhResult.metrics }
      : null,
  };
  await fs.writeFile(filename, JSON.stringify(report, null, 2), "utf-8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SI_THRESHOLD = 10000; // 10 seconds
const LCP_THRESHOLD = 10000; // 10 seconds
const FCP_THRESHOLD = 8000; // 8 seconds
const TBT_THRESHOLD = 3000; // 3 seconds

function getMetricsOutlierInfo(metrics: LighthouseMetrics): {
  isOutlier: boolean;
  details: string;
} {
  const outliers: string[] = [];

  if (metrics.SI > SI_THRESHOLD) {
    outliers.push(`SI ${metrics.SI}ms > ${SI_THRESHOLD}ms`);
  }
  if (metrics.LCP > LCP_THRESHOLD) {
    outliers.push(`LCP ${metrics.LCP}ms > ${LCP_THRESHOLD}ms`);
  }
  if (metrics.FCP > FCP_THRESHOLD) {
    outliers.push(`FCP ${metrics.FCP}ms > ${FCP_THRESHOLD}ms`);
  }
  if (metrics.TBT > TBT_THRESHOLD) {
    outliers.push(`TBT ${metrics.TBT}ms > ${TBT_THRESHOLD}ms`);
  }

  return {
    isOutlier: outliers.length > 0,
    details: outliers.join(", "),
  };
}

async function getAverageLighthouseScore(
  url: string,
  baseUrl: string,
): Promise<AverageLighthouseScore | null> {
  const results: LighthouseScore[] = [];
  let attempt = 0;
  const MAX_ATTEMPTS = 4;

  while (results.length < 3 && attempt < MAX_ATTEMPTS) {
    attempt++;
    process.stdout.write(`   Попытка ${attempt}/${MAX_ATTEMPTS}... `);
    const score = await getLighthouseScore(baseUrl + url);

    if (score && score.score >= 10 && score.score <= 100) {
      const outlierInfo = getMetricsOutlierInfo(score.metrics);
      if (outlierInfo.isOutlier) {
        console.log(`⚠️  ${outlierInfo.details}`);
      } else {
        console.log("✅");
        results.push(score);
      }
    } else {
      console.log("❌");
    }

    if (results.length < 3 && attempt < MAX_ATTEMPTS) {
      await delay(8000);
    }
  }

  if (results.length === 0) {
    console.error(
      `   ❌ ОШИБКА: Все ${MAX_ATTEMPTS} попытки выбросили выбросы или недействительные результаты. Метрики не сохранены.`,
    );
    return null;
  }

  const avgScore = Math.round(
    results.reduce((sum, r) => sum + r.score, 0) / results.length,
  );

  const avgMetrics: LighthouseMetrics = {
    FCP: Math.round(
      results.reduce((sum, r) => sum + r.metrics.FCP, 0) / results.length,
    ),
    LCP: Math.round(
      results.reduce((sum, r) => sum + r.metrics.LCP, 0) / results.length,
    ),
    TBT: Math.round(
      results.reduce((sum, r) => sum + r.metrics.TBT, 0) / results.length,
    ),
    CLS: (
      results.reduce(
        (sum, r) => sum + parseFloat(r.metrics.CLS as unknown as string),
        0,
      ) / results.length
    ).toFixed(3),
    SI: Math.round(
      results.reduce((sum, r) => sum + r.metrics.SI, 0) / results.length,
    ),
  };

  return {
    score: avgScore,
    metrics: avgMetrics,
    validCount: results.length,
    totalCount: attempt,
  };
}

function generateSummaryReport(
  results: AuditResult[],
  baseUrl: string,
): SummaryReportResult {
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}-${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}-${now.getFullYear()}`;

  const validScores = results
    .filter((r) => r.lhResult !== null)
    .map((r) => r.lhResult!.score);
  const overallAvgScore =
    validScores.length > 0
      ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
      : 0;

  const rows: TableRow[] = results.map((r) => {
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

  const colWidths: ColumnWidths = {
    url: Math.max(5, ...rows.map((r) => String(r.url).length)),
    score: Math.max(5, ...rows.map((r) => String(r.score).length)),
    lcp: Math.max(8, ...rows.map((r) => String(r.lcp).length)),
    tbt: Math.max(8, ...rows.map((r) => String(r.tbt).length)),
    cls: Math.max(3, ...rows.map((r) => String(r.cls).length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };

  const padRight = (str: string | number, width: number): string =>
    String(str).padEnd(width);
  const padLeft = (str: string | number, width: number): string =>
    String(str).padStart(width);

  const separator = `┌─${"-".repeat(colWidths.url)}─┬─${"-".repeat(colWidths.score)}─┬─${"-".repeat(
    colWidths.lcp,
  )}─┬─${"-".repeat(colWidths.tbt)}─┬─${"-".repeat(colWidths.cls)}─┬─${"-".repeat(colWidths.status)}─┐`;
  const divider = `├─${"-".repeat(colWidths.url)}─┼─${"-".repeat(colWidths.score)}─┼─${"-".repeat(
    colWidths.lcp,
  )}─┼─${"-".repeat(colWidths.tbt)}─┼─${"-".repeat(colWidths.cls)}─┼─${"-".repeat(colWidths.status)}─┤`;
  const footer = `└─${"-".repeat(colWidths.url)}─┴─${"-".repeat(colWidths.score)}─┴─${"-".repeat(
    colWidths.lcp,
  )}─┴─${"-".repeat(colWidths.tbt)}─┴─${"-".repeat(colWidths.cls)}─┴─${"-".repeat(colWidths.status)}─┘`;

  const tableLines: string[] = [separator];

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

async function runSeoAuditBatch(baseUrl: string): Promise<void> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });

  const urls: string[] = [
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
    "/charts/altcoin-index",
  ];

  const results: AuditResult[] = [];

  for (let idx = 0; idx < urls.length; idx++) {
    const url = urls[idx];
    const fullUrl = baseUrl + url;

    console.log(`\n📍 Страница ${idx + 1}/${urls.length}: ${url || "/"}`);

    console.log("⚡ Запуск Lighthouse...");
    const lhResult = await getAverageLighthouseScore(url, baseUrl);

    const prev = await loadPreviousReport(url);

    const report = generateReport(fullUrl, lhResult, prev);
    console.log(report);

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
    await saveJsonReport(fullUrl, lhResult, jsonFilename);

    results.push({ url, lhResult });

    if (idx < urls.length - 1) {
      console.log("⏳ Пауза перед следующей страницей (15 сек)...");
      await delay(15000);
    }
  }

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

  const summaryTxtFilename = path.join(
    REPORTS_DIR,
    `audit_${dateStr}_${Date.now()}.txt`,
  );
  const summaryJsonFilename = path.join(
    REPORTS_DIR,
    `audit_${dateStr}_${Date.now()}.json`,
  );

  await fs.writeFile(summaryTxtFilename, summaryReport, "utf-8");

  const summaryJsonData: SummaryJsonData = {
    timestamp: new Date().toISOString(),
    baseUrl,
    overallScore:
      results.filter((r) => r.lhResult).length > 0
        ? Math.round(
            results
              .filter((r) => r.lhResult)
              .map((r) => r.lhResult!.score)
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

const baseUrl = process.argv[2] || "https://cryptorank.io";
runSeoAuditBatch(baseUrl).catch(console.error);
