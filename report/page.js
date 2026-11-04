(() => {
  const R = window.REPORT;
  const isSnapshot = new URLSearchParams(location.search).has("snapshot");
  if (isSnapshot) document.body.classList.add("snapshot");

  // ---- Утилиты ----
  const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const fmtDay = (ts) => {
    const d = new Date(ts);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  };
  const fmtFullDay = (ts) => `${fmtDay(ts)} ${new Date(ts).getUTCFullYear()}`;
  const zoneOf = (s) => (s >= 90 ? "good" : s >= 50 ? "warn" : "bad");
  const ZONE_NAME = { good: "хорошо", warn: "средне", bad: "плохо" };
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Только резкие изменения подсвечиваются цветом, остальные — приглушённо
  const deltaHtml = (d, { alert = false } = {}) => {
    if (d === null) return '<span class="delta flat">—</span>';
    if (d === 0) return '<span class="delta flat">±0</span>';
    const dir = d > 0 ? "up" : "down";
    const arrow = d > 0 ? "▲" : "▼";
    if (!alert) return `<span class="delta flat">${arrow}${Math.abs(d)}</span>`;
    return `<span class="delta chip ${dir}"><span class="arrow ${dir}">${arrow}</span>${Math.abs(d)}</span>`;
  };

  const METRICS = {
    FCP: { name: "First Contentful Paint", good: 1800, poor: 3000 },
    LCP: { name: "Largest Contentful Paint", good: 2500, poor: 4000 },
    TBT: { name: "Total Blocking Time", good: 200, poor: 600 },
    CLS: { name: "Cumulative Layout Shift", good: 0.1, poor: 0.25 },
    SI: { name: "Speed Index", good: 3400, poor: 5800 },
  };
  const fmtMetric = (key, v) => {
    if (v === null || Number.isNaN(v)) return "—";
    if (key === "CLS") return v.toFixed(3);
    if (key === "TBT") return `${Math.round(v)} мс`;
    return `${(v / 1000).toFixed(1)} с`;
  };
  const metricZone = (key, v) =>
    v <= METRICS[key].good ? "good" : v <= METRICS[key].poor ? "warn" : "bad";

  // ---- Тултип ----
  const tip = document.getElementById("tooltip");
  const showTip = (html, x, y) => {
    tip.innerHTML = html;
    tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const left = x + 14 + width > innerWidth ? x - 14 - width : x + 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, y - height - 10)}px`;
  };
  const hideTip = () => (tip.hidden = true);

  // Диапазон оси Y по данным, шаг 10, не уже minSpan
  const yRange = (values, minSpan) => {
    const vals = values.filter((v) => v !== null);
    let lo = Math.floor((Math.min(...vals) - 5) / 10) * 10;
    let hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
    lo = Math.max(0, lo);
    hi = Math.min(100, hi);
    while (hi - lo < minSpan) {
      if (lo > 0) lo = Math.max(0, lo - 10);
      if (hi - lo < minSpan && hi < 100) hi = Math.min(100, hi + 10);
    }
    return [lo, hi];
  };

  // Путь линии с разрывами на пропущенных днях
  const linePath = (values, px, py) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) return (pen = false);
      d += `${pen ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const lastIndex = (values) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
    return -1;
  };

  // ---- Линейный график с зонами, медианой и ховером ----
  function lineChart(el, { values, height, baseline, label }) {
    const width = el.clientWidth;
    const m = { top: 12, right: 40, bottom: 26, left: 30 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const [lo, hi] = yRange(values, 30);
    const n = values.length;
    const px = (i) => m.left + (n === 1 ? w : (i / (n - 1)) * w);
    const py = (v) => m.top + h - ((v - lo) / (hi - lo)) * h;

    const bands = [
      ["bad", 0, 50],
      ["warn", 50, 90],
      ["good", 90, 100],
    ]
      .map(([z, a, b]) => {
        const top = Math.min(b, hi);
        const bottom = Math.max(a, lo);
        if (top <= bottom) return "";
        return `<rect class="band-${z}" x="${m.left}" y="${py(top)}" width="${w}" height="${py(bottom) - py(top)}"/>`;
      })
      .join("");

    const step = hi - lo > 50 ? 20 : 10;
    let grid = "";
    for (let v = lo; v <= hi; v += step) {
      grid += `<line class="gridline" x1="${m.left}" x2="${m.left + w}" y1="${py(v)}" y2="${py(v)}"/>`;
      grid += `<text class="axis-label" x="${m.left - 8}" y="${py(v) + 4}" text-anchor="end">${v}</text>`;
    }

    // Подписи дат — каждые 7 дней, считая от последнего
    let xLabels = "";
    for (let i = n - 1; i >= 0; i -= 7) {
      const anchor = i === n - 1 ? "end" : i < 3 ? "start" : "middle";
      xLabels += `<text class="axis-label" x="${px(i)}" y="${height - 6}" text-anchor="${anchor}">${fmtDay(R.dates[i])}</text>`;
    }

    let ref = "";
    if (baseline !== null) {
      ref =
        `<line class="ref-line" x1="${m.left}" x2="${m.left + w}" y1="${py(baseline)}" y2="${py(baseline)}"/>` +
        `<text class="ref-label" x="${m.left + 6}" y="${py(baseline) - 6}">медиана ${baseline}</text>`;
    }

    const li = lastIndex(values);
    const end =
      li < 0
        ? ""
        : `<circle class="end-dot ${zoneOf(values[li])}" cx="${px(li)}" cy="${py(values[li])}" r="5.5"/>` +
          `<text class="end-label" x="${px(li) + 10}" y="${py(values[li]) + 5}">${values[li]}</text>`;

    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" height="${height}" role="img" aria-label="${esc(label)}">
      ${bands}${grid}${xLabels}${ref}
      <path class="series-line" d="${linePath(values, px, py)}"/>
      ${end}
      <g class="hover" visibility="hidden">
        <line class="crosshair" y1="${m.top}" y2="${m.top + h}"/>
        <circle class="hover-dot" r="5"/>
      </g>
      <rect x="${m.left}" y="0" width="${w}" height="${height}" fill="transparent"/>
    </svg>`;

    if (isSnapshot) return;
    const svg = el.querySelector("svg");
    const hover = svg.querySelector(".hover");
    svg.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * width;
      const i = Math.max(0, Math.min(n - 1, Math.round(((x - m.left) / w) * (n - 1))));
      const v = values[i];
      hover.setAttribute("visibility", "visible");
      hover.querySelector("line").setAttribute("x1", px(i));
      hover.querySelector("line").setAttribute("x2", px(i));
      const dot = hover.querySelector("circle");
      dot.setAttribute("visibility", v === null ? "hidden" : "visible");
      if (v !== null) {
        dot.setAttribute("cx", px(i));
        dot.setAttribute("cy", py(v));
      }
      const vsBase = v !== null && baseline !== null ? ` · к медиане ${v - baseline >= 0 ? "+" : ""}${v - baseline}` : "";
      showTip(
        `<b>${fmtFullDay(R.dates[i])}</b><br>` +
          (v === null ? "нет данных" : `Скор <b>${v}</b> — ${ZONE_NAME[zoneOf(v)]}${vsBase}`),
        e.clientX,
        e.clientY,
      );
    });
    svg.addEventListener("pointerleave", () => {
      hover.setAttribute("visibility", "hidden");
      hideTip();
    });
  }

  // ---- Спарклайн ----
  function sparkline(values) {
    const width = 180;
    const height = 34;
    const [lo, hi] = yRange(values, 20);
    const n = values.length;
    const px = (i) => 3 + (n === 1 ? width - 6 : (i / (n - 1)) * (width - 6));
    const py = (v) => 3 + (height - 6) * (1 - (v - lo) / (hi - lo));
    const li = lastIndex(values);
    const end = li < 0 ? "" : `<circle class="end-dot ${zoneOf(values[li])}" cx="${px(li)}" cy="${py(values[li])}" r="4"/>`;
    return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <path class="series-line" style="stroke-width:1.75" d="${linePath(values, px, py)}"/>${end}
    </svg>`;
  }

  // ---- Разметка ----
  const avg = R.average;
  const today = R.dates[R.dates.length - 1];
  const alerts = R.pages.filter((p) => p.alert);

  const kpiHtml = `
    <div class="kpis">
      <div class="card kpi kpi-main">
        <div style="flex:1">
          <div class="kpi-label">Средний скор</div>
          <div class="kpi-value">${avg.score}</div>
        </div>
        <div class="kpi-sub" style="text-align:right">
          <div style="font-size:22px">${deltaHtml(avg.delta, { alert: Math.abs(avg.delta ?? 0) >= R.alertDelta / 2 })}</div>
          к медиане ${R.windowDays} дн. (${avg.baseline ?? "—"})
        </div>
      </div>
      ${[
        ["good", "≥ 90"],
        ["warn", "50–89"],
        ["bad", "< 50"],
      ]
        .map(
          ([z, range]) => `
        <div class="card kpi">
          <div class="kpi-label"><span class="dot ${z}"></span>${range}</div>
          <div class="kpi-value">${R.counts[z]}</div>
          <div class="kpi-sub">${ZONE_NAME[z]}</div>
        </div>`,
        )
        .join("")}
    </div>`;

  const alertsHtml = alerts.length
    ? `<div class="card alerts">
        ${alerts
          .map(
            (p) => `
          <div class="alert">
            <span>${deltaHtml(p.delta, { alert: true })}</span>
            <span class="url" title="${esc(p.url)}">${esc(p.url)} — ${p.score}</span>
            <span class="why">${p.alert}, медиана ${p.baseline}</span>
          </div>`,
          )
          .join("")}
      </div>`
    : `<div class="card alerts calm">✓ Резких изменений нет — все страницы в пределах ±${R.alertDelta} от медианы за ${R.windowDays} дн.</div>`;

  const rowsHtml = R.pages
    .map(
      (p, idx) => `
    <div class="page">
      <div class="row" data-idx="${idx}" role="button" tabindex="0" aria-expanded="false">
        <div class="url" title="${esc(p.url)}"><span class="dot ${p.zone}"></span><span>${esc(p.url)}</span></div>
        <div class="bar-cell">
          <div class="bar">
            <div class="fill ${p.zone}" style="width:${p.score}%"></div>
            <div class="tick" style="left:50%"></div>
            <div class="tick" style="left:90%"></div>
            ${p.baseline === null ? "" : `<div class="median" style="left:${p.baseline}%"></div>`}
          </div>
        </div>
        <div class="num score">${p.score}</div>
        <div class="num">${deltaHtml(p.delta, { alert: !!p.alert })}</div>
        <div class="spark">${sparkline(p.scores)}</div>
      </div>
      <div class="detail interactive-only" hidden></div>
    </div>`,
    )
    .join("");

  const metricKeys = Object.keys(METRICS);
  document.getElementById("app").innerHTML = `
    <section id="snapshot">
      <header class="header">
        <h1>Lighthouse · ${esc(R.site)}</h1>
        <div class="when">${fmtFullDay(today)} · окно ${R.windowDays} дней · ${R.pages.length} страниц</div>
      </header>
      <div class="overview">
        ${kpiHtml}
        <div class="card">
          <div class="trend-head">
            <h2>Средний скор по дням</h2>
            <span class="muted">${fmtDay(R.dates[0])} — ${fmtDay(today)}</span>
          </div>
          <div class="chart" id="avg-chart"></div>
        </div>
      </div>
      ${alertsHtml}
      <div class="card">
        <h2>Страницы — от худшей к лучшей</h2>
        <div class="rows-head">
          <span>URL</span><span class="col-bar">Скор сегодня</span><span class="num">Скор</span>
          <span class="num">к медиане</span><span class="col-spark">${R.windowDays} дней</span>
        </div>
        ${rowsHtml}
        <div class="legend">
          <span><span class="dot good"></span>≥ 90 хорошо</span>
          <span><span class="dot warn"></span>50–89 средне</span>
          <span><span class="dot bad"></span>&lt; 50 плохо</span>
          <span><span class="key-median"></span>медиана за ${R.windowDays} дн.</span>
          <span>Цветом выделены изменения на ${R.alertDelta}+ пунктов</span>
        </div>
      </div>
    </section>

    <section class="section card interactive-only">
      <h2>Метрики Lighthouse сегодня</h2>
      <p class="secondary" style="margin:-4px 0 12px">Точка — оценка метрики по порогам Lighthouse. Наведите на значение, чтобы увидеть медиану за ${R.windowDays} дн. Клик по заголовку — сортировка.</p>
      <div class="table-wrap">
        <table class="full">
          <thead><tr>
            <th data-key="url">URL</th><th data-key="score" aria-sort="ascending">Скор</th><th data-key="delta">к медиане</th>
            ${metricKeys.map((k) => `<th data-key="${k}" title="${METRICS[k].name}">${k}</th>`).join("")}
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
    <p class="muted interactive-only" style="margin-top:16px">
      Обновлено ${new Date(R.generatedAt).toLocaleString("ru-RU", { timeZone: "UTC" })} UTC.
      Сравнение идёт с медианой скора за предыдущие ${R.windowDays} дн. (как окно CrUX у Google);
      резкое изменение — отклонение на ${R.alertDelta}+ пунктов.
    </p>`;

  // ---- Графики (перерисовка при ресайзе) ----
  const charts = [];
  const addChart = (el, opts) => {
    const draw = () => lineChart(el, opts);
    charts.push(draw);
    draw();
  };
  addChart(document.getElementById("avg-chart"), {
    values: avg.scores,
    height: 232,
    baseline: avg.baseline,
    label: "Средний скор по дням",
  });
  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => charts.forEach((draw) => draw()), 100);
  });

  if (isSnapshot) return;

  // ---- Деталка страницы по клику ----
  const metricRows = (p) =>
    metricKeys
      .map((k) => {
        const m = p.metrics?.[k];
        if (!m) return "";
        return `<tr>
          <td><span class="mv"><span class="dot ${metricZone(k, m.value)}"></span>${k}</span></td>
          <td><b>${fmtMetric(k, m.value)}</b></td>
          <td class="muted">медиана ${fmtMetric(k, m.baseline)}</td>
        </tr>`;
      })
      .join("");

  document.querySelectorAll(".row").forEach((row) => {
    const p = R.pages[row.dataset.idx];
    const detail = row.nextElementSibling;
    const toggle = () => {
      const open = detail.hidden;
      detail.hidden = !open;
      row.setAttribute("aria-expanded", open);
      if (open && !detail.dataset.ready) {
        detail.dataset.ready = "1";
        detail.innerHTML = `<div class="detail-grid">
          <div class="chart"></div>
          <table class="metrics"><tbody>${metricRows(p)}</tbody></table>
        </div>`;
        addChart(detail.querySelector(".chart"), {
          values: p.scores,
          height: 220,
          baseline: p.baseline,
          label: `Скор ${p.url} по дням`,
        });
      }
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    const spark = row.querySelector(".spark");
    spark.addEventListener("pointermove", (e) => {
      const rect = spark.firstElementChild.getBoundingClientRect();
      const n = p.scores.length;
      const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / rect.width) * (n - 1))));
      const v = p.scores[i];
      showTip(`<b>${fmtFullDay(R.dates[i])}</b><br>${v === null ? "нет данных" : `Скор <b>${v}</b>`}`, e.clientX, e.clientY);
    });
    spark.addEventListener("pointerleave", hideTip);

    row.querySelector(".bar").addEventListener("pointermove", (e) => {
      const scores = p.scores.filter((v) => v !== null);
      showTip(
        `<b>${esc(p.url)}</b><br>Сегодня <b>${p.score}</b> — ${ZONE_NAME[p.zone]}<br>` +
          `Медиана ${p.baseline ?? "—"} · мин ${Math.min(...scores)} · макс ${Math.max(...scores)}`,
        e.clientX,
        e.clientY,
      );
    });
    row.querySelector(".bar").addEventListener("pointerleave", hideTip);
  });

  // ---- Таблица метрик с сортировкой ----
  const tbody = document.querySelector("table.full tbody");
  const sortState = { key: "score", dir: 1 };
  const sortValue = (p, key) =>
    key === "url" ? p.url : key in METRICS ? (p.metrics?.[key]?.value ?? Infinity) : (p[key] ?? 0);

  const renderTable = () => {
    const rows = [...R.pages].sort((a, b) => {
      const va = sortValue(a, sortState.key);
      const vb = sortValue(b, sortState.key);
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sortState.dir;
    });
    tbody.innerHTML = rows
      .map(
        (p) => `<tr>
        <td>${esc(p.url)}</td>
        <td><span class="mv"><span class="dot ${p.zone}"></span><b>${p.score}</b></span></td>
        <td>${deltaHtml(p.delta, { alert: !!p.alert })}</td>
        ${metricKeys
          .map((k) => {
            const m = p.metrics?.[k];
            if (!m) return "<td>—</td>";
            return `<td title="Медиана за ${R.windowDays} дн.: ${fmtMetric(k, m.baseline)}"><span class="mv"><span class="dot ${metricZone(k, m.value)}"></span>${fmtMetric(k, m.value)}</span></td>`;
          })
          .join("")}
      </tr>`,
      )
      .join("");
  };
  document.querySelectorAll("table.full th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      sortState.dir = sortState.key === key ? -sortState.dir : 1;
      sortState.key = key;
      document.querySelectorAll("table.full th").forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sortState.dir === 1 ? "ascending" : "descending");
      renderTable();
    });
  });
  renderTable();
})();
