// Finance Desk 渲染层：交互、检索、数据展示与自选逻辑。
// 所有远端取数都经主进程白名单 IPC（window.financeDesk），渲染层不接触 Key 与文件系统。
const F = window.FinanceFormat;
const C = window.FinanceChart;
const P = window.PaperTrading;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const WATCH_KEY = 'finance-desk-watchlist';
const PAPER_KEY = 'finance-desk-paper-account';
const ABILITY_LABELS = {
  growth: '成长能力',
  profitability: '盈利能力',
  solvency: '偿债能力',
  operation: '营运能力',
  'cash-flow': '现金流指标'
};

const ASSET_TYPE_LABELS = {
  'a-share': 'A 股',
  'a-share-index': '指数',
  'fund-otc': '场外基金',
  'fund-etf': 'ETF',
  'fund-lof': 'LOF',
  'fund-reits': 'REITs'
};

// 区间收益字段 → 展示名（基金 endpoints-fund.md 第 4 节）
const RETURN_LABELS = [
  ['return_week', '近一周'],
  ['return_month', '近一月'],
  ['return_tmonth', '近三月'],
  ['return_hyear', '近半年'],
  ['return_year', '近一年'],
  ['return_twoyear', '近两年'],
  ['return_tyear', '近三年'],
  ['return_fyear', '近五年'],
  ['return_nowyear', '今年以来'],
  ['return_now', '成立以来']
];

let current = null; // 当前选中的标的 { name, thscode, asset_type }
let seq = 0; // 请求序号，防止乱序响应覆盖新结果
let chart = null; // 日 K 图实例
let chartPeriod = 'day';
let chartRequest = 0; // 防止切换周期时旧图覆盖新图
let latestStrategyDecisions = [];
let exportPayload = null; // 当前结果可导出的数据集 { columns, rows, defaultName }
let claudeResearchPayload = null; // 传给主进程的脱敏研究上下文，不含 API Key
let currentQuote = null; // 当前研究页已展示的快照，仅在用户主动导入时传给虚拟盘

// ---- 纯逻辑封装（可测试部分已下沉到 src/format.js） ----
function watchlist() {
  return F.dedupeWatchlist(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'));
}
function saveWatchlist(list) {
  localStorage.setItem(WATCH_KEY, JSON.stringify(list));
}
function inWatchlist(code) {
  return watchlist().some((item) => item.thscode === code);
}
function nextSeq() {
  return ++seq;
}
function fmtDate(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function periodLabel(row) {
  const y = row.fiscal_year ?? '';
  const pl = row.fiscal_period === 'FY' ? '年报' : row.fiscal_period || '';
  return `${y} ${pl}`.trim() || '—';
}

// 解包主进程返回的结构化结果；失败时抛出带 kind 的 Error。
function unwrap(result) {
  if (result && result.ok) return result.data;
  const error = (result && result.error) || { kind: 'unknown', message: '请求未完成，请稍后重试。' };
  const e = new Error(error.message || '请求未完成，请稍后重试。');
  e.kind = error.kind || 'unknown';
  throw e;
}
async function call(promise) {
  return unwrap(await promise);
}

// ---- 视图与通用 UI ----
function showView(name) {
  $$('.view, .nav').forEach((item) => item.classList.remove('active'));
  $(`#${name}`).classList.add('active');
  $$(`[data-view="${name}"]`).forEach((item) => item.classList.add('active'));
  if (name === 'watchlist') renderWatchlist();
  if (name === 'db') refreshDbStatus();
  if (name === 'paper') renderPaper();
}
function setNotice(message = '') {
  $('#notice').textContent = message;
}
function errorText(error) {
  return error && error.message ? error.message : '请求未完成，请稍后重试。';
}
function setBusy(on) {
  const btn = $('#search-button');
  if (btn) btn.disabled = on;
  const input = $('#search-input');
  if (input) input.disabled = on;
  $$('.candidate').forEach((b) => (b.disabled = on));
  document.body.classList.toggle('busy', on);
}
function updateConnection(status) {
  const pill = $('#connection');
  pill.textContent = status.configured ? '已配置 API Key' : '尚未配置 API Key';
  pill.className = `pill ${status.configured ? 'ok' : 'error'}`;
  const warn = $('#encrypt-warning');
  // 系统安全存储不可用时始终警告（无论是否已保存 Key），避免静默明文落盘。
  if (warn) warn.hidden = status.encrypted;
  const saveButton = $('#save-key-button');
  const keyInput = $('#key-input');
  if (saveButton) saveButton.textContent = status.configured ? '更新 API Key' : '安全保存';
  if (keyInput)
    keyInput.placeholder = status.configured ? '输入新 Key 后更新（当前 Key 不会显示）' : '粘贴 API Key';
}
function showResult() {
  $('#result').hidden = false;
}
function hideResult() {
  $('#result').hidden = true;
}
function clearCandidates() {
  $('#candidates').innerHTML = '';
}

// ---- 检索与标的选择 ----
async function doSearch(query) {
  const mySeq = nextSeq();
  setBusy(true);
  setNotice('正在搜索…');
  hideResult();
  clearCandidates();
  const assetType = $('#asset-filter').value;
  try {
    const data = await call(window.financeDesk.search(query, assetType || undefined));
    if (mySeq !== seq) return;
    const items = data.item || [];
    $('#candidates').innerHTML = items.length
      ? items
          .map(
            (asset) =>
              `<button class="candidate" data-code="${asset.thscode}"><span>${asset.name} · ${asset.thscode}</span><small>${asset.asset_type}</small></button>`
          )
          .join('')
      : '';
    $$('.candidate').forEach((button) =>
      button.addEventListener('click', () => {
        const asset = items.find((item) => item.thscode === button.dataset.code);
        if (asset) chooseAsset(asset);
      })
    );
    setNotice(items.length ? '请选择一个匹配标的。' : '没有找到匹配标的。');
  } catch (error) {
    if (mySeq !== seq) return;
    setNotice(errorText(error));
  } finally {
    if (mySeq === seq) setBusy(false);
  }
}

// 按资产类型路由到对应数据端点；不把 A 股参数套给指数或基金。
async function chooseAsset(asset) {
  current = asset;
  switch (asset.asset_type) {
    case 'a-share':
      await chooseAShare(asset);
      break;
    case 'a-share-index':
      await chooseIndex(asset);
      break;
    case 'fund-otc':
    case 'fund-etf':
    case 'fund-lof':
    case 'fund-reits':
      await chooseFund(asset);
      break;
    default:
      setNotice('该资产类型暂不支持，请选择 A 股、指数或基金标的。');
  }
}

async function chooseAShare(asset) {
  const mySeq = nextSeq();
  setBusy(true);
  setNotice('正在获取行情与财务数据…');
  hideResult();
  clearCandidates();
  updateWatchButton();
  try {
    const [snapshot, income, balance, cashflow] = await Promise.all([
      call(window.financeDesk.snapshot(asset.thscode)),
      call(window.financeDesk.income(asset.thscode)),
      call(window.financeDesk.balance(asset.thscode)),
      call(window.financeDesk.cashflow(asset.thscode))
    ]);
    if (mySeq !== seq) return;

    renderHeader(asset);
    resetPanels('a-share');
    renderStats((snapshot.item && snapshot.item[0]) || {});
    renderIncome(income.item || []);
    renderBalance(balance.item || []);
    renderCashflow(cashflow.item || []);
    setClaudeResearch(asset, (snapshot.item && snapshot.item[0]) || {}, [
      { title: '最近四期利润表', rows: (income.item || []).slice(0, 4) },
      { title: '最近四期资产负债表', rows: (balance.item || []).slice(0, 4) },
      { title: '最近四期现金流量表', rows: (cashflow.item || []).slice(0, 4) }
    ]);
    await renderIndicators(asset.thscode, income.item || [], mySeq);
    await loadChart(asset.thscode, mySeq);
    setExport(
      [
        { key: 'period', label: '报告期' },
        { key: 'operating_income', label: '营业收入' },
        { key: 'net_profit', label: '净利润' },
        { key: 'parent_holder_net_profit', label: '归母净利润' },
        { key: 'basic_eps', label: '基本每股收益' }
      ],
      (income.item || []).map((r) => ({
        period: periodLabel(r),
        operating_income: r.operating_income,
        net_profit: r.net_profit,
        parent_holder_net_profit: r.parent_holder_net_profit,
        basic_eps: r.basic_eps
      })),
      `${asset.thscode}-income`
    );
    setNotice('');
    showResult();
  } catch (error) {
    if (mySeq !== seq) return;
    setNotice(errorText(error));
  } finally {
    if (mySeq === seq) setBusy(false);
  }
}

// ---- 结果渲染 ----
function renderHeader(asset) {
  $('#asset-name').textContent = asset.name;
  $('#asset-code').textContent = asset.thscode;
  $('#asset-type').textContent = ASSET_TYPE_LABELS[asset.asset_type] || asset.asset_type;
  updateWatchButton();
}

// 依据资产类型切换面板可见性，并重置导出数据集。
function resetPanels(assetType) {
  $('#constituents-panel').hidden = assetType !== 'a-share-index';
  const isFund = assetType.startsWith('fund');
  $('#fund-panel').hidden = !isFund;
  $('#fin-tabs').hidden = assetType !== 'a-share';
  $$('#fin-tabs .tab').forEach((t) => t.classList.remove('active'));
  $$('#fin-tabs .tab-panel, #tab-income, #tab-balance, #tab-cashflow, #tab-indicators').forEach((p) =>
    p.classList.remove('active')
  );
  $('#tab-income').classList.add('active');
  $('#fin-tabs .tab[data-tab="income"]').classList.add('active');
  // 图表：A 股与指数、场内基金（ETF/LOF）展示，场外/REITs 隐藏。
  const showChart =
    assetType === 'a-share' ||
    assetType === 'a-share-index' ||
    assetType === 'fund-etf' ||
    assetType === 'fund-lof';
  $('#chart-wrap').parentElement.hidden = !showChart;
  updateChartTitle(assetType);
  exportPayload = null;
  $('#export-button').disabled = true;
  claudeResearchPayload = null;
  currentQuote = null;
  $('#ai-research-button').disabled = true;
  $('#paper-candidate-button').disabled = true;
}

function updateChartTitle(assetType = current && current.asset_type) {
  const periodName = (C.PERIODS[chartPeriod] || C.PERIODS.day).label;
  const prefix = assetType === 'a-share-index' ? '指数' : assetType === 'a-share' ? '' : '场内行情';
  $('#chart-title').textContent = `${prefix}${periodName}线`;
}

function setExport(columns, rows, defaultName) {
  exportPayload = { columns, rows, defaultName };
  $('#export-button').disabled = !rows.length;
}

function updateWatchButton() {
  const btn = $('#watch-button');
  if (!current) {
    btn.textContent = '加入自选';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = inWatchlist(current.thscode) ? '已加入自选' : '加入自选';
  btn.classList.toggle('secondary', inWatchlist(current.thscode));
}

function renderStats(quote = {}) {
  const items = [
    ['最新价', F.money(quote.last_price)],
    ['涨跌幅', F.formatPercent(quote.price_change_ratio_pct), F.signClass(quote.price_change_ratio_pct)],
    ['成交额', F.toYi(quote.turnover)],
    ['今日区间', `${F.money(quote.low_price)} — ${F.money(quote.high_price)}`]
  ];
  $('#stats').innerHTML = items
    .map(
      ([label, value, cls = '']) =>
        `<article class="stat"><label>${label}</label><strong class="${cls}">${value}</strong></article>`
    )
    .join('');
}

// 仅将已展示的研究数据摘要交给 Claude Code；Finance Desk 保存的 API Key 永不进入此对象。
function setClaudeResearch(asset, quote = {}, sections = []) {
  currentQuote = quote;
  claudeResearchPayload = {
    asset: {
      name: asset.name,
      thscode: asset.thscode,
      assetType: ASSET_TYPE_LABELS[asset.asset_type] || asset.asset_type
    },
    quote: {
      lastPrice: F.money(quote.last_price),
      changePct: F.formatPercent(quote.price_change_ratio_pct),
      turnover: F.toYi(quote.turnover),
      dayRange: `${F.money(quote.low_price)} — ${F.money(quote.high_price)}`
    },
    sections
  };
  $('#ai-research-button').disabled = false;
  $('#paper-candidate-button').disabled =
    !Number.isFinite(Number(quote.last_price)) || Number(quote.last_price) <= 0;
}

function table(columns, rows) {
  if (!rows.length) return '<p class="empty">暂无可展示数据。</p>';
  return `<table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function renderIncome(rows) {
  $('#tab-income').innerHTML = table(
    ['报告期', '发布日期', '营业收入', '净利润', '归母净利润', '基本每股收益'],
    rows.map((r) => [
      periodLabel(r),
      fmtDate(r.report_date_ms),
      F.toYi(r.operating_income),
      F.toYi(r.net_profit),
      F.toYi(r.parent_holder_net_profit),
      F.money(r.basic_eps)
    ])
  );
}

function renderBalance(rows) {
  $('#tab-balance').innerHTML = table(
    ['报告期', '资产总计', '负债合计', '所有者权益', '货币资金', '应收账款'],
    rows.map((r) => [
      periodLabel(r),
      F.toYi(r.assets_total),
      F.toYi(r.total_debt),
      F.toYi(r.holder_equity_total),
      F.toYi(r.cash),
      F.toYi(r.accounts_receivable)
    ])
  );
}

function renderCashflow(rows) {
  $('#tab-cashflow').innerHTML = table(
    ['报告期', '经营净现金流', '投资净现金流', '筹资净现金流', '现金净增加额'],
    rows.map((r) => [
      periodLabel(r),
      F.toYi(r.act_cash_flow_net),
      F.toYi(r.invest_cash_flow_net),
      F.toYi(r.financing_cash_flow_net),
      F.toYi(r.cash_equivalents_net_addition)
    ])
  );
}

async function renderIndicators(thscode, incomeRows, mySeq) {
  const panel = $('#tab-indicators');
  const latest = incomeRows[0];
  const report = latest && latest.fiscal_year ? `${latest.fiscal_year}-4` : null;
  if (!report) {
    panel.innerHTML = '<p class="empty">暂无可展示的财务指标。</p>';
    return;
  }
  panel.innerHTML = '<p class="loading">正在加载财务指标…</p>';
  let data;
  try {
    data = await call(window.financeDesk.indicators(thscode, report));
  } catch (error) {
    if (mySeq === seq) panel.innerHTML = `<p class="empty">财务指标加载失败：${errorText(error)}</p>`;
    return;
  }
  if (mySeq !== seq) return;
  const abilities = data.abilities || [];
  if (!abilities.length) {
    panel.innerHTML = '<p class="empty">该报告期暂无财务指标。</p>';
    return;
  }
  panel.innerHTML = abilities
    .map((ab) => {
      const rows = (ab.indicators || [])
        .map(
          (ind) =>
            `<div class="ind-row"><span>${F.humanizeIndexId(ind.index_id)}</span><strong>${ind.value == null ? '—' : ind.value}</strong></div>`
        )
        .join('');
      return `<div class="ind-group"><h4>${ABILITY_LABELS[ab.ability] || ab.ability}</h4>${rows || '<p class="empty">—</p>'}</div>`;
    })
    .join('');
}

// ---- K 图（canvas，无第三方依赖） ----
function createChart(canvas, tipEl) {
  const UP = '#49c5a8';
  const DOWN = '#f08089';
  const GRID = '#263755';
  const MUTED = '#94a6c4';
  const PAD_RIGHT = 68;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 22;
  let bars = [];
  let period = 'day';
  let hover = -1;

  function fmtVol(v) {
    return v >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿股` : v >= 1e4 ? `${(v / 1e4).toFixed(2)} 万股` : String(v);
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width || 1;
    const H = rect.height || 1;
    // CSS 尺寸与画布内部像素尺寸必须同步；否则 Retina/宽窗口会拉伸、裁切 300×150 默认画布。
    const pixelW = Math.max(1, Math.round(W * dpr));
    const pixelH = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!bars.length) return;

    const plotW = Math.max(1, W - PAD_RIGHT);
    const chartH = Math.max(1, H - PAD_BOTTOM - PAD_TOP);
    const volH = Math.max(0, chartH * 0.18);
    const priceH = chartH - volH;

    let minL = Infinity;
    let maxH = -Infinity;
    let maxV = 0;
    for (const b of bars) {
      const lo = Math.min(b.low_price, b.open_price, b.close_price);
      const hi = Math.max(b.high_price, b.open_price, b.close_price);
      if (lo < minL) minL = lo;
      if (hi > maxH) maxH = hi;
      if (b.volume > maxV) maxV = b.volume;
    }
    if (!Number.isFinite(minL)) return;
    const pad = (maxH - minL) * 0.06 || maxH * 0.01 || 1;
    const lo = minL - pad;
    const hi = maxH + pad;

    const n = bars.length;
    const slot = plotW / n;
    const bodyW = Math.max(1, Math.min(14, slot * 0.68));
    const x = (i) => (i + 0.5) * slot;
    const py = (p) => PAD_TOP + priceH - ((p - lo) / (hi - lo)) * priceH;
    const vy = (v) => PAD_TOP + chartH - (maxV ? (v / maxV) * volH : 0);

    ctx.strokeStyle = GRID;
    ctx.fillStyle = MUTED;
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    // 将价格间隔收敛到 1/2/2.5/5 × 10^n，切换到月/年线也保持易读刻度。
    const rawStep = (hi - lo) / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
    const multiplier = [1, 2, 2.5, 5, 10].find((value) => value * magnitude >= rawStep) || 10;
    const step = multiplier * magnitude;
    const firstTick = Math.ceil(lo / step) * step;
    const lastTick = Math.floor(hi / step) * step;
    for (let price = firstTick; price <= lastTick + step / 1000; price += step) {
      const yy = py(price);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(F.money(price), plotW + 6, yy + 4);
    }

    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const up = b.close_price >= b.open_price;
      const color = up ? UP : DOWN;
      const cx = x(i);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx, py(b.high_price));
      ctx.lineTo(cx, py(b.low_price));
      ctx.stroke();
      const yOpen = py(b.open_price);
      const yClose = py(b.close_price);
      const top = Math.min(yOpen, yClose);
      const h = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(cx - bodyW / 2, top, bodyW, h);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(cx - bodyW / 2, vy(b.volume), bodyW, PAD_TOP + chartH - vy(b.volume));
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    const maxLabels = Math.max(
      2,
      Math.floor(plotW / (period === 'year' ? 45 : period === 'month' ? 65 : 58))
    );
    const labelCount = Math.min(n, maxLabels);
    const idxs = [
      ...new Set(Array.from({ length: labelCount }, (_, i) => Math.round((i * (n - 1)) / (labelCount - 1))))
    ];
    for (const i of idxs) ctx.fillText(C.formatAxisDate(bars[i].date_ms, period), x(i), H - 6);

    if (hover >= 0 && hover < n) {
      const cx = x(hover);
      ctx.strokeStyle = MUTED;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, PAD_TOP);
      ctx.lineTo(cx, PAD_TOP + chartH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function positionTip(i) {
    const rect = canvas.getBoundingClientRect();
    const slot = (rect.width - PAD_RIGHT) / bars.length;
    const cx = (i + 0.5) * slot;
    tipEl.style.left = `${Math.min(cx + 12, rect.width - 170)}px`;
    tipEl.style.top = '8px';
  }

  function onMove(ev) {
    if (!bars.length) return;
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - PAD_RIGHT;
    const i = Math.min(
      bars.length - 1,
      Math.max(0, Math.floor((ev.clientX - rect.left) / (plotW / bars.length)))
    );
    hover = i;
    const b = bars[i];
    const up = b.close_price >= b.open_price;
    tipEl.hidden = false;
    tipEl.innerHTML =
      `<div class="tt-date">${fmtDate(b.date_ms)}</div>` +
      `<div>开 ${F.money(b.open_price)}&nbsp; 高 ${F.money(b.high_price)}</div>` +
      `<div>低 ${F.money(b.low_price)}&nbsp; 收 <b style="color:${up ? UP : DOWN}">${F.money(b.close_price)}</b></div>` +
      `<div>量 ${fmtVol(b.volume)}</div>`;
    positionTip(i);
    draw();
  }

  function onLeave() {
    hover = -1;
    tipEl.hidden = true;
    draw();
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  window.addEventListener('resize', draw);

  return {
    setData(next, nextPeriod = 'day') {
      // API 响应顺序不作为图表顺序假设；过滤损坏 OHLC，并始终让时间从左向右推进。
      bars = (Array.isArray(next) ? next : [])
        .map((row) => ({
          ...row,
          date_ms: Number(row.date_ms),
          open_price: Number(row.open_price),
          high_price: Number(row.high_price),
          low_price: Number(row.low_price),
          close_price: Number(row.close_price),
          volume: Number(row.volume) || 0
        }))
        .filter((row) =>
          [row.date_ms, row.open_price, row.high_price, row.low_price, row.close_price].every(Number.isFinite)
        )
        .sort((a, b) => a.date_ms - b.date_ms);
      period = nextPeriod;
      hover = -1;
      tipEl.hidden = true;
      draw();
    }
  };
}

async function loadChartGeneric(fetchFn, mySeq, adjustLabel) {
  const panel = $('#chart-wrap');
  const meta = $('#chart-meta');
  if (!chart) chart = createChart($('#chart'), $('#chart-tip'));
  panel.classList.add('loading');
  meta.textContent = '';
  chart.setData([], chartPeriod);
  const request = ++chartRequest;
  const periodConfig = C.PERIODS[chartPeriod] || C.PERIODS.day;
  const end = Date.now();
  const start = end - periodConfig.years * 365 * 24 * 3600 * 1000;
  let data;
  try {
    data = await call(fetchFn(start, end));
  } catch (error) {
    if (mySeq === seq && request === chartRequest) {
      panel.classList.remove('loading');
      meta.textContent = `K 线加载失败：${errorText(error)}`;
    }
    return;
  }
  if (mySeq !== seq || request !== chartRequest) return;
  panel.classList.remove('loading');
  const bars = C.aggregateBars(data.item || [], chartPeriod);
  chart.setData(bars, chartPeriod);
  meta.textContent = bars.length
    ? `${adjustLabel} · ${periodConfig.label} · ${fmtDate(bars[0].date_ms)} ~ ${fmtDate(bars[bars.length - 1].date_ms)} · 共 ${bars.length} 根`
    : '暂无历史行情数据。';
}

async function loadChart(thscode, mySeq) {
  return loadChartGeneric(
    (start, end) => window.financeDesk.historical(thscode, { start, end, adjust: 'forward' }),
    mySeq,
    '前复权'
  );
}

async function loadIndexChart(thscode, mySeq) {
  return loadChartGeneric(
    (start, end) => window.financeDesk.indexHistorical(thscode, { start, end }),
    mySeq,
    '未复权'
  );
}

async function loadFundChart(thscode, mySeq) {
  return loadChartGeneric(
    (start, end) => window.financeDesk.fundMarketHistorical(thscode, { start, end }),
    mySeq,
    '未复权'
  );
}

function reloadCurrentChart() {
  if (!current) return;
  const mySeq = seq;
  updateChartTitle(current.asset_type);
  if (current.asset_type === 'a-share') loadChart(current.thscode, mySeq);
  if (current.asset_type === 'a-share-index') loadIndexChart(current.thscode, mySeq);
  if (current.asset_type === 'fund-etf' || current.asset_type === 'fund-lof')
    loadFundChart(current.thscode, mySeq);
}

// ---- 指数研究 ----
async function chooseIndex(asset) {
  const mySeq = nextSeq();
  setBusy(true);
  setNotice('正在获取指数行情与成分股…');
  hideResult();
  clearCandidates();
  updateWatchButton();
  try {
    const [snapshot, constituents] = await Promise.all([
      call(window.financeDesk.indexSnapshot(asset.thscode)),
      call(window.financeDesk.indexConstituents(asset.thscode))
    ]);
    if (mySeq !== seq) return;

    renderHeader(asset);
    resetPanels('a-share-index');
    renderStats((snapshot.item && snapshot.item[0]) || {});
    renderConstituents(constituents.item || []);
    setClaudeResearch(asset, (snapshot.item && snapshot.item[0]) || {}, [
      { title: '指数当前成分股（最多 8 项）', rows: (constituents.item || []).slice(0, 8) }
    ]);
    await loadIndexChart(asset.thscode, mySeq);
    setExport(
      [
        { key: 'thscode', label: '代码' },
        { key: 'ticker', label: '纯代码' },
        { key: 'name', label: '名称' }
      ],
      (constituents.item || []).map((c) => ({ thscode: c.thscode, ticker: c.ticker, name: c.name })),
      `${asset.thscode}-constituents`
    );
    setNotice('');
    showResult();
  } catch (error) {
    if (mySeq !== seq) return;
    setNotice(errorText(error));
  } finally {
    if (mySeq === seq) setBusy(false);
  }
}

function renderConstituents(rows) {
  $('#constituents-meta').textContent = rows.length ? `共 ${rows.length} 只（当前成分，非历史调入调出）` : '';
  $('#constituents').innerHTML = rows.length
    ? table(
        ['代码', '纯代码', '名称'],
        rows.map((c) => [c.thscode, c.ticker, c.name])
      )
    : '<p class="empty">暂无成分股数据。</p>';
}

// ---- 基金研究 ----
function isExchangeFund(assetType) {
  return assetType === 'fund-etf' || assetType === 'fund-lof';
}

async function chooseFund(asset) {
  const mySeq = nextSeq();
  setBusy(true);
  setNotice('正在获取基金资料与收益…');
  hideResult();
  clearCandidates();
  updateWatchButton();
  const exchange = isExchangeFund(asset.asset_type);
  try {
    const tasks = [
      call(window.financeDesk.fundProfile(asset.thscode, asset.asset_type)),
      call(window.financeDesk.fundReturns(asset.thscode, asset.asset_type))
    ];
    // 场内基金取实时行情 + 历史 K；场外 / REITs 取近一年净值走势。
    if (exchange) tasks.push(call(window.financeDesk.fundMarketSnapshot(asset.thscode)));
    else tasks.push(call(window.financeDesk.fundNav(asset.thscode, asset.asset_type, 'year')));
    const results = await Promise.all(tasks);
    if (mySeq !== seq) return;

    const [profile, returns, marketOrNav] = results;
    renderHeader(asset);
    resetPanels(asset.asset_type);
    if (exchange) {
      renderStats((marketOrNav.item && marketOrNav.item[0]) || {});
      await loadFundChart(asset.thscode, mySeq);
    } else {
      renderFundStats((profile.item && profile.item[0]) || {}, (returns.item && returns.item[0]) || {});
      renderFundNav(marketOrNav.item || []);
    }
    renderFundProfile((profile.item && profile.item[0]) || {});
    renderFundReturns((returns.item && returns.item[0]) || {});
    setClaudeResearch(asset, exchange ? (marketOrNav.item && marketOrNav.item[0]) || {} : {}, [
      { title: '基金资料', rows: (profile.item || []).slice(0, 1) },
      { title: '区间收益', rows: (returns.item || []).slice(0, 1) },
      { title: '近一年净值（最多 8 项）', rows: exchange ? [] : (marketOrNav.item || []).slice(0, 8) }
    ]);

    const retRow = (returns.item && returns.item[0]) || {};
    setExport(
      RETURN_LABELS.map(([key, label]) => ({ key, label })),
      [Object.fromEntries(RETURN_LABELS.map(([key]) => [key, retRow[key]]))],
      `${asset.thscode}-returns`
    );
    setNotice('');
    showResult();
  } catch (error) {
    if (mySeq !== seq) return;
    setNotice(errorText(error));
  } finally {
    if (mySeq === seq) setBusy(false);
  }
}

function renderFundStats(profile, returns) {
  const items = [
    ['单位净值', F.money(profile.unit_nav)],
    ['基金规模', F.toYi(profile.fund_scale)],
    ['近一年', F.formatPercent(returns.return_year), F.signClass(returns.return_year)],
    ['成立以来', F.formatPercent(returns.return_now), F.signClass(returns.return_now)]
  ];
  $('#stats').innerHTML = items
    .map(
      ([label, value, cls = '']) =>
        `<article class="stat"><label>${label}</label><strong class="${cls}">${value}</strong></article>`
    )
    .join('');
}

function fundItem(label, value, cls = '') {
  const text = value == null || value === '' ? F.EMPTY : value;
  return `<div class="fund-item"><label>${label}</label><strong class="${cls}">${text}</strong></div>`;
}

function renderFundProfile(profile) {
  $('#fund-profile').innerHTML = [
    fundItem('基金名称', profile.fund_name),
    fundItem('管理人', profile.mgmt_name),
    fundItem('基金经理', profile.manager_name),
    fundItem('成立日期', fmtDate(profile.estab_date)),
    fundItem('基金规模', F.toYi(profile.fund_scale)),
    fundItem('单位净值', F.money(profile.unit_nav))
  ].join('');
}

function renderFundReturns(ret) {
  $('#fund-returns').innerHTML = RETURN_LABELS.map(([key, label]) =>
    fundItem(label, F.formatPercent(ret[key]), F.signClass(ret[key]))
  ).join('');
}

function renderFundNav(rows) {
  $('#fund-nav').innerHTML = rows.length
    ? table(
        ['净值日期', '单位净值', '累计净值'],
        rows.map((r) => [fmtDate(r.nav_date), F.money(r.unit_nav), F.money(r.adj_nav)])
      )
    : '<p class="empty">暂无净值数据。</p>';
}

// ---- 数据导出 ----
async function exportCurrent() {
  if (!exportPayload || !exportPayload.rows.length) return;
  const format = $('#export-format').value === 'json' ? 'json' : 'csv';
  try {
    const data = await call(window.financeDesk.exportData({ ...exportPayload, format }));
    if (data && data.canceled) {
      setNotice('已取消导出。');
      return;
    }
    setNotice(`已导出 ${data.rows} 行（${data.format.toUpperCase()}）到 ${data.path}`);
  } catch (error) {
    setNotice(errorText(error));
  }
}

async function launchClaudeResearch() {
  if (!claudeResearchPayload) return;
  const button = $('#ai-research-button');
  button.disabled = true;
  try {
    const result = await window.financeDesk.claude.launchResearch(claudeResearchPayload);
    setNotice(
      `已在 Terminal 启动 Claude Code（${result.version}）。研究上下文不会包含 Finance Desk API Key。`
    );
  } catch (error) {
    setNotice(errorText(error));
  } finally {
    button.disabled = !claudeResearchPayload;
  }
}

// ---- 本地数据库 ----
async function refreshDbStatus() {
  const pill = $('#db-status');
  try {
    const status = await window.financeDesk.db.status();
    pill.textContent = status.available ? `CLI 可用（${status.version}）` : '未检测到 CLI';
    pill.className = `pill ${status.available ? 'ok' : 'error'}`;
  } catch {
    pill.textContent = '检测失败';
    pill.className = 'pill error';
  }
}

async function runDbQuery() {
  const sql = $('#db-sql').value.trim();
  const out = $('#db-result');
  if (!sql) {
    out.innerHTML = '<p class="empty">请输入 SQL。</p>';
    return;
  }
  out.innerHTML = '<p class="loading">正在查询…</p>';
  const result = await window.financeDesk.db.query(sql);
  if (result && result.ok) {
    const rows = result.data || [];
    if (!rows.length) {
      out.innerHTML = '<p class="empty">查询无结果。</p>';
      return;
    }
    const cols = Object.keys(rows[0]);
    out.innerHTML = table(
      cols,
      rows.map((r) => cols.map((c) => (r[c] == null ? F.EMPTY : r[c])))
    );
  } else {
    const msg = (result && result.error && result.error.message) || '查询失败。';
    out.innerHTML = `<p class="empty">${msg}</p>`;
  }
}

// ---- 自选观察 ----
function addToWatchlist() {
  if (!current) return;
  if (inWatchlist(current.thscode)) return;
  const list = watchlist();
  list.push(
    F.normalizeWatchlistItem({ name: current.name, thscode: current.thscode, asset_type: current.asset_type })
  );
  saveWatchlist(list);
  updateWatchButton();
}

function removeFromWatchlist(code) {
  if (!window.confirm('确定从自选中移除该标的吗？')) return;
  saveWatchlist(watchlist().filter((item) => item.thscode !== code));
  updateWatchButton();
  renderWatchlist();
}

async function fetchWatchQuotes(data) {
  const quotes = {};
  const aShare = data.filter((i) => i.asset_type === 'a-share').map((i) => i.thscode);
  const idx = data.filter((i) => i.asset_type === 'a-share-index').map((i) => i.thscode);
  const exch = data.filter((i) => isExchangeFund(i.asset_type)).map((i) => i.thscode);

  const jobs = [];
  if (aShare.length) {
    jobs.push(
      call(window.financeDesk.snapshot(aShare.join(','))).then((s) =>
        (s.item || []).forEach((q) => (quotes[q.thscode] = q))
      )
    );
  }
  if (idx.length) {
    jobs.push(
      call(window.financeDesk.indexSnapshot(idx.join(','))).then((s) =>
        (s.item || []).forEach((q) => (quotes[q.thscode] = q))
      )
    );
  }
  // 场内基金快照为单标的端点，逐个请求。
  for (const code of exch) {
    jobs.push(
      call(window.financeDesk.fundMarketSnapshot(code)).then((s) =>
        (s.item || []).forEach((q) => (quotes[q.thscode] = q))
      )
    );
  }
  await Promise.allSettled(jobs);
  return quotes;
}

async function renderWatchlist() {
  const content = $('#watchlist-content');
  const data = watchlist();
  if (!data.length) {
    content.innerHTML =
      '<article class="panel"><h3>还没有自选标的</h3><p>在市场研究页查询标的后，点击“加入自选”。数据仅保存在本机。</p></article>';
    return;
  }
  content.innerHTML = '<p class="loading">正在获取自选行情…</p>';
  const quotes = await fetchWatchQuotes(data);
  content.innerHTML = renderWatchItems(data, quotes, Object.keys(quotes).length === 0);
  attachWatchHandlers(data);
}

// ---- 虚拟盘实验：本地双账户账本。人工盘和策略盘共用候选与成交规则，不连接券商。 ----
function paperBook() {
  return P.normalizeBook(JSON.parse(localStorage.getItem(PAPER_KEY) || 'null'));
}

function savePaperBook(book) {
  localStorage.setItem(PAPER_KEY, JSON.stringify(book));
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]
  );
}

function addCurrentToPaper() {
  if (!current || !currentQuote) return;
  try {
    const book = P.addBookCandidate(paperBook(), {
      thscode: current.thscode,
      name: current.name,
      assetType: current.asset_type,
      lastPrice: currentQuote.last_price,
      updatedAt: Date.now()
    });
    savePaperBook(book);
    setNotice(`${current.name} 已作为参考价候选加入虚拟盘实验。`);
    $('#paper-candidate-button').textContent = '已更新虚拟盘候选';
  } catch (error) {
    setNotice(errorText(error));
  }
}

function dateInputMs(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`).getTime();
}

function yyyyMmDd(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function paperCandidatesForMode(book) {
  const session = book.simulation && book.simulation.mode === 'practice' && book.simulation.practice;
  const state = session && P.practiceState(session, book.candidates);
  if (!state) return { candidates: book.candidates, practiceState: null };
  return {
    candidates: book.candidates
      .filter((item) => state.prices.has(item.thscode))
      .map((item) => ({ ...item, lastPrice: state.prices.get(item.thscode), updatedAt: state.dateMs })),
    practiceState: state
  };
}

async function fetchPaperHistories(candidates, start, end) {
  const aShares = candidates.filter((item) => item.assetType === 'a-share').slice(0, 10);
  if (!aShares.length) throw new Error('当前候选没有 A 股；历史回测与练习暂仅支持 A 股日线。');
  const pairs = await Promise.all(
    aShares.map(async (item) => [
      item.thscode,
      await call(window.financeDesk.historical(item.thscode, { start, end, adjust: 'forward' }))
    ])
  );
  return {
    candidates: aShares,
    historyByCode: Object.fromEntries(pairs.map(([code, result]) => [code, result.item || []]))
  };
}

function renderPaper() {
  const book = paperBook();
  const mode = book.simulation.mode;
  const modeData = paperCandidatesForMode(book);
  const candidates = modeData.candidates;
  const prices = new Map(candidates.map((c) => [c.thscode, c.lastPrice]));
  const manualBase =
    mode === 'practice' && book.simulation.practice ? book.simulation.practice.account : book.manual;
  const manual = P.withBookCandidates(manualBase, candidates);
  const strategy = P.withBookCandidates(book.strategy, candidates);
  const manualMetrics = P.metrics(manual);
  const strategyMetrics = P.metrics(strategy);
  $('#paper-metrics').innerHTML = [
    ['人工盘净值', F.money(manualMetrics.equity)],
    ['人工盘收益', F.formatPercent(manualMetrics.returnPct), F.signClass(manualMetrics.returnPct)],
    ['人工盘当前回撤', F.formatPercent(manualMetrics.drawdownPct), F.signClass(manualMetrics.drawdownPct)],
    ['策略盘净值', F.money(strategyMetrics.equity)],
    ['策略盘收益', F.formatPercent(strategyMetrics.returnPct), F.signClass(strategyMetrics.returnPct)],
    [
      '策略盘当前回撤',
      F.formatPercent(strategyMetrics.drawdownPct),
      F.signClass(strategyMetrics.drawdownPct)
    ],
    [
      '收益差（人工－策略）',
      F.formatPercent(manualMetrics.returnPct - strategyMetrics.returnPct),
      F.signClass(manualMetrics.returnPct - strategyMetrics.returnPct)
    ],
    ['累计模拟成交额', F.money(manualMetrics.turnover + strategyMetrics.turnover)]
  ]
    .map(
      ([label, value, cls = '']) =>
        `<article class="stat"><label>${label}</label><strong class="${cls}">${value}</strong></article>`
    )
    .join('');

  $('#simulation-mode').value = mode;
  if (!$('#simulation-start').value)
    $('#simulation-start').value = yyyyMmDd(Date.now() - 365 * 24 * 3600 * 1000);
  if (!$('#simulation-end').value) $('#simulation-end').value = yyyyMmDd(Date.now());
  $('#practice-panel').hidden = mode !== 'practice';
  $('#backtest-panel').hidden = mode !== 'backtest';
  $('#manual-order-title').textContent =
    mode === 'practice' ? '人工历史练习：手动订单' : '人工盘：手动模拟订单';
  $('#simulation-mode-hint').textContent =
    mode === 'forward'
      ? '当前：策略前向模拟'
      : mode === 'backtest'
        ? '当前：策略历史回测'
        : '当前：人工历史练习';
  $('#practice-status').textContent = modeData.practiceState
    ? `练习日期：${fmtDate(modeData.practiceState.dateMs)}${modeData.practiceState.isFinished ? '（已到终点）' : ''}`
    : '请点击“应用模式”载入指定日期区间。';
  $('#practice-advance').disabled = !modeData.practiceState || modeData.practiceState.isFinished;
  const backtestRuns = book.simulation.backtestRuns || [];
  $('#backtest-results').innerHTML = backtestRuns.length
    ? table(
        ['运行时间', '区间', '交易日', '收益率', '最大回撤', '订单数'],
        backtestRuns.map((run) => [
          new Date(run.createdAt).toLocaleString('zh-CN'),
          `${fmtDate(run.start)} ~ ${fmtDate(run.end)}`,
          F.money(run.days),
          F.formatPercent(run.returnPct),
          F.formatPercent(run.maxDrawdownPct),
          F.money(run.trades)
        ])
      )
    : '<p class="empty">选择历史区间并运行策略后，这里会保留最近 20 次回测摘要。</p>';

  const option = $('#paper-symbol');
  option.innerHTML = candidates.length
    ? candidates
        .map(
          (c) =>
            `<option value="${escapeHtml(c.thscode)}">${escapeHtml(c.name)} · ${escapeHtml(c.thscode)}</option>`
        )
        .join('')
    : '<option value="">请先从研究页导入候选</option>';
  $('#paper-submit').disabled = !candidates.length;
  const selected = candidates.find((c) => c.thscode === option.value) || candidates[0];
  $('#paper-order-hint').textContent = selected
    ? `参考价：${F.money(selected.lastPrice)}；更新于 ${fmtDate(selected.updatedAt)}。模拟费率固定为成交额的 0.03%。`
    : '研究页打开标的后，点击“加入虚拟盘候选”即可导入其最新已显示快照。';

  $('#paper-candidates').innerHTML = candidates.length
    ? table(
        ['标的', '参考价', '更新时间', 'AI 复盘'],
        candidates.map((c) => [
          `${escapeHtml(c.name)}<br /><small>${escapeHtml(c.thscode)}</small>`,
          F.money(c.lastPrice),
          fmtDate(c.updatedAt),
          `<button class="text-button paper-ai" data-paper-ai="${escapeHtml(c.thscode)}">交给 AI 复盘</button>`
        ])
      )
    : '<p class="empty">暂无候选。候选只会从你主动导入的研究页标的创建。</p>';
  const names = new Map(candidates.map((c) => [c.thscode, c.name]));
  const holdingRows = [...new Set([...manual.holdings, ...strategy.holdings].map((h) => h.thscode))].map(
    (thscode) => {
      const price = prices.get(thscode) || 0;
      const mh = manual.holdings.find((h) => h.thscode === thscode);
      const sh = strategy.holdings.find((h) => h.thscode === thscode);
      const result = (holding) => {
        if (!holding) return '—';
        const profit = price ? (price / holding.averageCost - 1) * 100 : null;
        return `${F.money(holding.quantity)} 股<br /><small>成本 ${F.money(holding.averageCost)} / ${F.formatPercent(profit)}</small>`;
      };
      return [
        `${escapeHtml(names.get(thscode) || thscode)}<br /><small>${escapeHtml(thscode)}</small>`,
        F.money(price),
        result(mh),
        result(sh)
      ];
    }
  );
  $('#paper-holdings').innerHTML = holdingRows.length
    ? table(['标的', '参考价', '人工盘：数量 / 浮盈', '策略盘：数量 / 浮盈'], holdingRows)
    : '<p class="empty">尚无虚拟持仓。</p>';
  const allTrades = [
    ...manual.trades.map((trade) => ({ ...trade, account: '人工盘' })),
    ...strategy.trades.map((trade) => ({ ...trade, account: '策略盘' }))
  ].sort((a, b) => b.createdAt - a.createdAt);
  $('#paper-trades').innerHTML = allTrades.length
    ? table(
        ['时间', '账户', '操作', '代码', '数量', '成交额', '理由 / 规则'],
        allTrades
          .slice(0, 20)
          .map((t) => [
            new Date(t.createdAt).toLocaleString('zh-CN'),
            t.account,
            t.side === 'buy' ? '模拟买入' : '模拟卖出',
            escapeHtml(t.thscode),
            F.money(t.quantity),
            F.money(t.quantity * t.price),
            escapeHtml(t.note || (t.source === 'strategy' ? '规则策略订单' : '未记录'))
          ])
      )
    : '<p class="empty">暂无模拟订单。</p>';
  $('#strategy-short').value = book.strategyConfig.shortWindow;
  $('#strategy-long').value = book.strategyConfig.longWindow;
  $('#strategy-allocation').value = book.strategyConfig.allocationPct;
  $('#strategy-decisions').innerHTML = latestStrategyDecisions.length
    ? table(
        ['标的', '结果', '依据'],
        latestStrategyDecisions.map((item) => [
          escapeHtml(names.get(item.thscode) || item.thscode),
          escapeHtml(item.action),
          escapeHtml(item.reason)
        ])
      )
    : '<p class="hint">运行后会记录本次策略信号与执行结果。</p>';
  $$('.paper-ai').forEach((button) =>
    button.addEventListener('click', () => launchPaperReview(button.dataset.paperAi))
  );
}

function submitPaperOrder() {
  const book = paperBook();
  const modeData = paperCandidatesForMode(book);
  const thscode = $('#paper-symbol').value;
  const candidate = modeData.candidates.find((c) => c.thscode === thscode);
  if (!candidate) return;
  try {
    const account =
      book.simulation.mode === 'practice' && book.simulation.practice
        ? book.simulation.practice.account
        : book.manual;
    let manual = P.executeOrder(P.withBookCandidates(account, modeData.candidates), {
      side: $('#paper-side').value,
      thscode,
      quantity: $('#paper-quantity').value,
      price: candidate.lastPrice,
      note: $('#paper-note').value
    });
    manual = P.recordSnapshot(manual, new Map(modeData.candidates.map((c) => [c.thscode, c.lastPrice])));
    const nextBook =
      book.simulation.mode === 'practice' && book.simulation.practice
        ? {
            ...book,
            simulation: { ...book.simulation, practice: { ...book.simulation.practice, account: manual } }
          }
        : { ...book, manual };
    savePaperBook(nextBook);
    $('#paper-quantity').value = '';
    $('#paper-note').value = '';
    renderPaper();
  } catch (error) {
    window.alert(errorText(error));
  }
}

async function refreshPaperPrices(book) {
  const aShares = book.candidates.filter((item) => item.assetType === 'a-share');
  if (!aShares.length) return book;
  const snapshot = await call(window.financeDesk.snapshot(aShares.map((item) => item.thscode).join(',')));
  const updates = new Map((snapshot.item || []).map((item) => [item.thscode, Number(item.last_price)]));
  const candidates = book.candidates.map((item) => {
    const price = updates.get(item.thscode);
    return Number.isFinite(price) && price > 0 ? { ...item, lastPrice: price, updatedAt: Date.now() } : item;
  });
  return { ...book, candidates };
}

async function runStrategyForward() {
  const button = $('#strategy-run');
  let book = paperBook();
  if (book.simulation.mode === 'backtest') return runHistoricalBacktest();
  if (book.simulation.mode === 'practice') {
    return window.alert('历史练习由人工逐日推进；请切换到“策略前向模拟”或“策略历史回测”运行策略。');
  }
  if (!book.candidates.length) return window.alert('请先在研究页将 A 股标的加入虚拟盘候选。');
  const config = {
    ...book.strategyConfig,
    shortWindow: Number($('#strategy-short').value),
    longWindow: Number($('#strategy-long').value),
    allocationPct: Number($('#strategy-allocation').value)
  };
  if (
    !Number.isInteger(config.shortWindow) ||
    !Number.isInteger(config.longWindow) ||
    config.shortWindow >= config.longWindow ||
    config.allocationPct <= 0 ||
    config.allocationPct > 100
  ) {
    return window.alert('请填写有效参数：短均线小于长均线，仓位为 1–100%。');
  }
  button.disabled = true;
  $('#strategy-status').textContent = '正在同步行情并计算信号…';
  try {
    book = await refreshPaperPrices(book);
    const aShares = book.candidates.filter((item) => item.assetType === 'a-share');
    if (!aShares.length) throw new Error('当前候选没有 A 股；内置均线策略暂只支持 A 股日线。');
    const start = Date.now() - Math.max(config.longWindow * 3, 90) * 24 * 3600 * 1000;
    const histories = await Promise.all(
      aShares.map(async (item) => [
        item.thscode,
        await call(window.financeDesk.historical(item.thscode, { start, end: Date.now(), adjust: 'forward' }))
      ])
    );
    const historyByCode = Object.fromEntries(
      histories.map(([code, result]) => [code, (result.item || []).map((row) => row.close_price)])
    );
    const run = P.runMovingAverageStrategy(
      P.withBookCandidates(book.strategy, book.candidates),
      aShares,
      historyByCode,
      config
    );
    const prices = new Map(book.candidates.map((item) => [item.thscode, item.lastPrice]));
    const strategy = P.recordSnapshot(run.account, prices);
    latestStrategyDecisions = run.decisions;
    savePaperBook({ ...book, strategy, strategyConfig: config });
    $('#strategy-status').textContent = `已完成 ${new Date().toLocaleTimeString('zh-CN')} 的前向模拟。`;
    renderPaper();
  } catch (error) {
    $('#strategy-status').textContent = `策略未运行：${errorText(error)}`;
  } finally {
    button.disabled = false;
  }
}

async function runHistoricalBacktest() {
  const button = $('#strategy-run');
  const book = paperBook();
  const start = dateInputMs($('#simulation-start').value);
  const end = dateInputMs($('#simulation-end').value, true);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return window.alert('请选择有效的历史回测起止日期。');
  const config = {
    ...book.strategyConfig,
    shortWindow: Number($('#strategy-short').value),
    longWindow: Number($('#strategy-long').value),
    allocationPct: Number($('#strategy-allocation').value)
  };
  if (
    !Number.isInteger(config.shortWindow) ||
    !Number.isInteger(config.longWindow) ||
    config.shortWindow >= config.longWindow
  ) {
    return window.alert('短均线必须是小于长均线的整数。');
  }
  button.disabled = true;
  $('#strategy-status').textContent = '正在加载历史日线并逐日回测…';
  try {
    const { candidates, historyByCode } = await fetchPaperHistories(book.candidates, start, end);
    const result = P.runHistoricalBacktest(candidates, historyByCode, config);
    const summary = {
      createdAt: Date.now(),
      start,
      end,
      days: result.dates,
      returnPct: P.metrics(result.account).returnPct,
      maxDrawdownPct: Math.min(0, ...result.points.map((item) => item.drawdownPct)),
      trades: result.account.trades.length,
      config
    };
    latestStrategyDecisions = result.decisions.slice(-30);
    savePaperBook({
      ...book,
      strategyConfig: config,
      simulation: {
        ...book.simulation,
        backtestRuns: [summary, ...(book.simulation.backtestRuns || [])].slice(0, 20)
      }
    });
    $('#strategy-status').textContent = `历史回测完成：${result.dates} 个交易日。`;
    renderPaper();
  } catch (error) {
    $('#strategy-status').textContent = `回测未完成：${errorText(error)}`;
  } finally {
    button.disabled = false;
  }
}

async function applySimulationMode() {
  const mode = $('#simulation-mode').value;
  let book = paperBook();
  const start = dateInputMs($('#simulation-start').value);
  const end = dateInputMs($('#simulation-end').value, true);
  if (mode !== 'practice') {
    savePaperBook({ ...book, simulation: { ...book.simulation, mode } });
    renderPaper();
    return;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return window.alert('请选择有效的历史练习起止日期。');
  const button = $('#simulation-apply');
  button.disabled = true;
  $('#simulation-mode-hint').textContent = '正在载入历史练习数据…';
  try {
    const { candidates, historyByCode } = await fetchPaperHistories(book.candidates, start, end);
    const practice = P.createPracticeSession(candidates, historyByCode, start, end, book.manual.initialCash);
    savePaperBook({ ...book, simulation: { ...book.simulation, mode: 'practice', practice } });
    renderPaper();
  } catch (error) {
    $('#simulation-mode-hint').textContent = `历史练习未启动：${errorText(error)}`;
  } finally {
    button.disabled = false;
  }
}

function advancePractice() {
  const book = paperBook();
  if (!book.simulation.practice) return;
  const result = P.advancePracticeSession(book.simulation.practice, book.candidates);
  savePaperBook({ ...book, simulation: { ...book.simulation, practice: result.session } });
  renderPaper();
}

async function launchPaperReview(thscode) {
  const book = paperBook();
  const candidate = book.candidates.find((c) => c.thscode === thscode);
  if (!candidate) return;
  const holding = book.manual.holdings.find((h) => h.thscode === thscode);
  try {
    await window.financeDesk.claude.launchResearch({
      asset: { name: candidate.name, thscode: candidate.thscode, assetType: candidate.assetType },
      quote: {
        lastPrice: F.money(candidate.lastPrice),
        changePct: '未随虚拟盘刷新',
        turnover: '—',
        dayRange: '—'
      },
      sections: [
        {
          title: '虚拟盘实验上下文（仅供复盘）',
          rows: [
            {
              quantity: holding ? holding.quantity : 0,
              averageCost: holding ? holding.averageCost : '—',
              referencePrice: candidate.lastPrice
            }
          ]
        }
      ]
    });
    setNotice('已启动 Claude Code 复盘会话。它不会执行虚拟盘订单。');
  } catch (error) {
    setNotice(errorText(error));
  }
}

async function launchStrategyReview() {
  const book = paperBook();
  const candidate = book.candidates[0];
  if (!candidate) return window.alert('请先在研究页加入至少一个候选标的。');
  const manual = P.metrics(P.withBookCandidates(book.manual, book.candidates));
  const strategy = P.metrics(P.withBookCandidates(book.strategy, book.candidates));
  try {
    await window.financeDesk.claude.launchResearch({
      asset: { name: candidate.name, thscode: candidate.thscode, assetType: candidate.assetType },
      quote: {
        lastPrice: F.money(candidate.lastPrice),
        changePct: '请通过 Skill 核验',
        turnover: '请通过 Skill 核验',
        dayRange: '请通过 Skill 核验'
      },
      sections: [
        {
          title: '虚拟盘策略审阅上下文（不能直接下单）',
          rows: [
            {
              strategyVersion: book.strategyConfig.version,
              parameters: `MA${book.strategyConfig.shortWindow}/MA${book.strategyConfig.longWindow}，单标的 ${book.strategyConfig.allocationPct}%`,
              manualReturnPct: manual.returnPct,
              manualDrawdownPct: manual.drawdownPct,
              strategyReturnPct: strategy.returnPct,
              strategyDrawdownPct: strategy.drawdownPct,
              instruction:
                '请审阅规则假设、数据泄漏风险、交易成本和复盘问题；不要给出买卖指令或直接操作虚拟盘。'
            }
          ]
        }
      ]
    });
    setNotice('已启动 Claude Code 策略审阅会话。AI 不会执行模拟订单。');
  } catch (error) {
    setNotice(errorText(error));
  }
}

function renderWatchItems(data, quotes, failed) {
  const rows = data
    .map((item) => {
      const q = quotes ? quotes[item.thscode] : null;
      const price = q ? F.money(q.last_price) : '—';
      const change = q ? F.formatPercent(q.price_change_ratio_pct) : '—';
      const cls = q ? F.signClass(q.price_change_ratio_pct) : '';
      return `<tr>
      <td><div class="w-name">${item.name}</div><small class="w-code">${item.thscode}</small></td>
      <td class="num">${price}</td>
      <td class="num ${cls}">${change}</td>
      <td class="num">${q ? F.toYi(q.turnover) : '—'}</td>
      <td class="actions">
        <button class="text-button open" data-open="${item.thscode}">打开研究页</button>
        <button class="text-button remove" data-remove="${item.thscode}">移除</button>
      </td>
    </tr>`;
    })
    .join('');
  return (
    `<table class="watch-table"><thead><tr><th>标的</th><th class="num">最新价</th><th class="num">涨跌幅</th><th class="num">成交额</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>` +
    (failed ? '' : '<p class="hint">行情为最近一次快照，非逐笔实时；点击“刷新行情”更新。</p>')
  );
}

function attachWatchHandlers(data) {
  $$('#watchlist-content [data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const asset = data.find((item) => item.thscode === b.dataset.open);
      if (asset) {
        showView('research');
        chooseAsset(asset);
      }
    })
  );
  $$('#watchlist-content [data-remove]').forEach((b) =>
    b.addEventListener('click', () => removeFromWatchlist(b.dataset.remove))
  );
}

// ---- 设置 ----
async function refreshConnectionStatus() {
  const status = await window.financeDesk.settings.status();
  updateConnection(status);
}

async function refreshHithinkStatus() {
  const statusEl = $('#hithink-status');
  try {
    const status = await window.financeDesk.settings.hithinkStatus();
    if (!status.available) {
      statusEl.textContent = '未检测到 hithink-finance CLI。请先在 Claude Code 环境安装。';
      return;
    }
    statusEl.textContent = status.configured
      ? 'CLI 已检测到，且统一 API Key 已配置。'
      : 'CLI 已检测到，但尚未配置统一 API Key。';
  } catch {
    statusEl.textContent = '无法读取 CLI 认证状态。';
  }
}

// ---- 事件绑定 ----
$$('.nav').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) return;
  doSearch(query);
});

$('#watch-button').addEventListener('click', addToWatchlist);
$('#refresh-watchlist').addEventListener('click', renderWatchlist);
$('#export-button').addEventListener('click', exportCurrent);
$('#ai-research-button').addEventListener('click', launchClaudeResearch);
$('#paper-candidate-button').addEventListener('click', addCurrentToPaper);
$('#db-run').addEventListener('click', runDbQuery);
$('#paper-submit').addEventListener('click', submitPaperOrder);
$('#paper-symbol').addEventListener('change', renderPaper);
$('#strategy-run').addEventListener('click', runStrategyForward);
$('#strategy-ai').addEventListener('click', launchStrategyReview);
$('#simulation-apply').addEventListener('click', applySimulationMode);
$('#practice-advance').addEventListener('click', advancePractice);
$('#chart-period').addEventListener('change', (event) => {
  chartPeriod = event.target.value in C.PERIODS ? event.target.value : 'day';
  reloadCurrentChart();
});
$('#paper-reset').addEventListener('click', () => {
  if (!window.confirm('确定重置本机虚拟盘账户、候选与订单日志吗？此操作不会影响自选或真实账户。')) return;
  latestStrategyDecisions = [];
  savePaperBook(P.createBook());
  renderPaper();
});

$$('#fin-tabs .tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('#fin-tabs .tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  })
);

$('#key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = event.target.querySelector('button');
  btn.disabled = true;
  try {
    const result = await window.financeDesk.settings.saveKey($('#key-input').value);
    $('#key-input').value = '';
    updateConnection(result);
    refreshHithinkStatus();
    setNotice('API Key 已安全保存。');
    showView('research');
  } catch (error) {
    window.alert(errorText(error));
  } finally {
    btn.disabled = false;
  }
});

$('#clear-key').addEventListener('click', async () => {
  const result = await window.financeDesk.settings.clearKey();
  updateConnection(result);
  setNotice('本机保存的 Key 已移除。');
});

$('#sync-hithink-key').addEventListener('click', async () => {
  if (!window.confirm('将 Finance Desk 已保存的 API Key 同步到 hithink-finance CLI 的本机凭据库？')) return;
  const button = $('#sync-hithink-key');
  button.disabled = true;
  try {
    await window.financeDesk.settings.syncHithinkKey();
    await refreshHithinkStatus();
    setNotice('已同步到 hithink-finance CLI。现在可重新打开 AI 研究助手进行真实取数。');
    showView('research');
  } catch (error) {
    window.alert(errorText(error));
  } finally {
    button.disabled = false;
  }
});

// 初始连接状态
refreshConnectionStatus();
refreshHithinkStatus();
