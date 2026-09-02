const { contextBridge, ipcRenderer } = require('electron');

// 白名单校验：只允许字符串入参，阻断任意对象/执行逻辑注入。
function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}必须是字符串。`);
  return value.trim();
}

function assertCodes(value) {
  // 批量端点接受逗号分隔的 thscode 列表。
  return assertString(value, '证券代码');
}

function assertRangeOptions(opts) {
  // 指数/基金历史端点无复权概念，仅接受有序起止时间。
  if (opts == null) return {};
  const start = Number(opts.start);
  const end = Number(opts.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('历史行情需要有效的起止时间。');
  return { start, end };
}

function assertHistoricalOptions(opts) {
  if (opts == null) return {};
  const start = Number(opts.start);
  const end = Number(opts.end);
  const adjust = opts.adjust === 'none' || opts.adjust === 'backward' ? opts.adjust : 'forward';
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('历史行情需要有效的起止时间。');
  return { start, end, adjust };
}

function assertFundType(assetType) {
  const type = assertString(assetType, '基金类型');
  if (!['fund-otc', 'fund-etf', 'fund-lof', 'fund-reits'].includes(type)) {
    throw new Error('不支持的基金类型。');
  }
  return type;
}

function assertExportPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('导出参数无效。');
  if (!Array.isArray(payload.columns) || !Array.isArray(payload.rows)) throw new Error('导出数据无效。');
  const columns = payload.columns
    .filter((c) => c && typeof c.key === 'string' && typeof c.label === 'string')
    .map((c) => ({ key: c.key, label: c.label }));
  return {
    format: payload.format === 'json' ? 'json' : 'csv',
    columns,
    rows: payload.rows,
    defaultName:
      typeof payload.defaultName === 'string' && payload.defaultName
        ? payload.defaultName
        : 'finance-desk-export'
  };
}

function assertResearchPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.asset || typeof payload.asset !== 'object') {
    throw new Error('研究上下文无效。');
  }
  const asset = payload.asset;
  ['name', 'thscode', 'assetType'].forEach((key) => assertString(asset[key], '研究标的'));
  const quote = payload.quote && typeof payload.quote === 'object' ? payload.quote : {};
  const sections = Array.isArray(payload.sections) ? payload.sections.slice(0, 4) : [];
  return {
    asset: { name: asset.name.trim(), thscode: asset.thscode.trim(), assetType: asset.assetType.trim() },
    quote,
    sections
  };
}

// 受限 contextBridge API：仅暴露白名单方法，不暴露 ipcRenderer / require / process。
contextBridge.exposeInMainWorld('financeDesk', {
  settings: {
    status: () => ipcRenderer.invoke('settings:status'),
    saveKey: (key) => ipcRenderer.invoke('settings:saveKey', assertString(key, 'API Key')),
    clearKey: () => ipcRenderer.invoke('settings:clearKey'),
    syncHithinkKey: () => ipcRenderer.invoke('settings:syncHithinkKey'),
    hithinkStatus: () => ipcRenderer.invoke('settings:hithinkStatus')
  },
  search: (query, assetType) => {
    const q = assertString(query, '搜索词');
    return assetType
      ? ipcRenderer.invoke('finance:search', q, assertString(assetType, '资产类型'))
      : ipcRenderer.invoke('finance:search', q);
  },
  snapshot: (codes) => ipcRenderer.invoke('finance:snapshot', assertCodes(codes)),
  valuations: (codes) => ipcRenderer.invoke('finance:valuations', assertCodes(codes)),
  income: (code) => ipcRenderer.invoke('finance:income', assertString(code, '证券代码')),
  balance: (code) => ipcRenderer.invoke('finance:balance', assertString(code, '证券代码')),
  cashflow: (code) => ipcRenderer.invoke('finance:cashflow', assertString(code, '证券代码')),
  indicators: (code, report) =>
    ipcRenderer.invoke('finance:indicators', assertString(code, '证券代码'), assertString(report, '报告期')),
  historical: (code, opts) =>
    ipcRenderer.invoke('finance:historical', assertString(code, '证券代码'), assertHistoricalOptions(opts)),

  indexSnapshot: (codes) => ipcRenderer.invoke('finance:index-snapshot', assertCodes(codes)),
  indexHistorical: (code, opts) =>
    ipcRenderer.invoke('finance:index-historical', assertString(code, '指数代码'), assertRangeOptions(opts)),
  indexConstituents: (code) =>
    ipcRenderer.invoke('finance:index-constituents', assertString(code, '指数代码')),

  fundProfile: (code, assetType) =>
    ipcRenderer.invoke('finance:fund-profile', assertString(code, '基金代码'), assertFundType(assetType)),
  fundNav: (code, assetType, range) =>
    ipcRenderer.invoke(
      'finance:fund-nav',
      assertString(code, '基金代码'),
      assertFundType(assetType),
      range ? assertString(range, '净值区间') : undefined
    ),
  fundReturns: (code, assetType) =>
    ipcRenderer.invoke('finance:fund-returns', assertString(code, '基金代码'), assertFundType(assetType)),
  fundMarketSnapshot: (code) =>
    ipcRenderer.invoke('finance:fund-market-snapshot', assertString(code, '基金代码')),
  fundMarketHistorical: (code, opts) =>
    ipcRenderer.invoke(
      'finance:fund-market-historical',
      assertString(code, '基金代码'),
      assertRangeOptions(opts)
    ),

  exportData: (payload) => ipcRenderer.invoke('export:save', assertExportPayload(payload)),
  claude: {
    status: () => ipcRenderer.invoke('claude:status'),
    launchResearch: (payload) => ipcRenderer.invoke('claude:launchResearch', assertResearchPayload(payload))
  },
  db: {
    status: () => ipcRenderer.invoke('db:status'),
    query: (sql) => ipcRenderer.invoke('db:query', assertString(sql, 'SQL'))
  }
});
