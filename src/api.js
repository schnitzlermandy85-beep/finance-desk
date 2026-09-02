// 纯 Node 模块：封装对同花顺金融数据服务 REST API 的请求与业务信封解析。
// 不依赖 electron，便于单元测试注入 mock fetch 与 getKey。
// 契约以源仓库 docs/api/ 为准：统一 X-api-key 头认证，HTTP 200 仍需检查业务信封 code===0。

const ApiErrorKind = Object.freeze({
  NO_KEY: 'no-key',
  AUTH: 'auth',
  RATE_LIMIT: 'rate-limit',
  NETWORK: 'network',
  BAD_REQUEST: 'bad-request',
  API: 'api',
  UNKNOWN: 'unknown'
});

class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

function buildApiUrl(base, endpoint, params = {}) {
  const url = new URL(`${base}${endpoint}`);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, value);
  });
  return url.toString();
}

// 已确认的业务错误码 → 用户可操作的简短提示。不包含认证头或原始回显。
const CODE_HINTS = {
  1001: '缺少必要参数，请检查查询条件。',
  1002: '参数格式不正确，请检查证券代码或报告期。',
  1003: '参数超出允许范围（例如单次时间跨度超过 10 年）。',
  1004: '参数组合冲突（例如同时使用 limit 与时间区间）。',
  3001: '未找到对应基金，请核对基金代码与类型。',
  3002: '数据尚未准备，请稍后再试。',
  3004: '该基金类型不支持此能力。'
};

// 将元信息里的 asset_type 映射为基金端点要求的 fund_type（otc / exchange / reits）。
function fundTypeFor(assetType) {
  switch (assetType) {
    case 'fund-otc':
      return 'otc';
    case 'fund-etf':
    case 'fund-lof':
      return 'exchange';
    case 'fund-reits':
      return 'reits';
    default:
      return null;
  }
}

function parseEnvelope(body) {
  if (!body || typeof body !== 'object') {
    throw new ApiError(ApiErrorKind.UNKNOWN, '服务返回了无法解析的响应。');
  }
  if (body.code !== undefined && body.code !== 0) {
    const code = body.code;
    if (CODE_HINTS[code]) throw new ApiError(ApiErrorKind.BAD_REQUEST, CODE_HINTS[code]);
    throw new ApiError(ApiErrorKind.API, body.message || `业务请求失败（code=${code}）。`);
  }
  return body.data;
}

function createApiClient({ base, fetchFn, getKey }) {
  async function apiGet(endpoint, params = {}) {
    const key = getKey();
    if (!key) throw new ApiError(ApiErrorKind.NO_KEY, '请先在“连接设置”中保存 API Key。');

    const url = buildApiUrl(base, endpoint, params);
    let response;
    try {
      response = await fetchFn(url, { headers: { 'X-api-key': key } });
    } catch (err) {
      throw new ApiError(ApiErrorKind.NETWORK, '无法连接到数据服务，请检查网络连接。');
    }

    if (response.status === 401 || response.status === 403) {
      throw new ApiError(ApiErrorKind.AUTH, 'API Key 无效或已失效，请在“连接设置”中重新创建并保存。');
    }
    if (response.status === 429) {
      throw new ApiError(ApiErrorKind.RATE_LIMIT, '请求过于频繁，请稍后重试。');
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(ApiErrorKind.API, (body && body.message) || `请求失败（HTTP ${response.status}）。`);
    }
    return parseEnvelope(body);
  }

  return {
    search: (q, limit = 8, assetType) => apiGet('/meta/tickers/search', { q, limit, asset_type: assetType }),
    snapshot: (thscodes) => apiGet('/a-share/prices/snapshot', { thscodes }),
    valuations: (thscodes) => apiGet('/a-share/valuations/snapshot', { thscodes }),
    income: (thscode, limit = 4) =>
      apiGet('/a-share/financials/income-statements', { thscode, period: 'annual', limit }),
    balance: (thscode, limit = 5) =>
      apiGet('/a-share/financials/balance-sheets', { thscode, period: 'annual', limit }),
    cashflow: (thscode, limit = 5) =>
      apiGet('/a-share/financials/cash-flow-statements', { thscode, period: 'annual', limit }),
    indicators: (thscode, report) => apiGet('/a-share/financials/indicators', { thscode, report }),
    historical: (thscode, { start, end, adjust = 'forward' } = {}) =>
      apiGet('/a-share/prices/historical', { thscode, interval: '1d', start, end, adjust }),

    // 指数：快照/历史（无复权概念）/成分股。
    indexSnapshot: (thscodes) => apiGet('/a-share-index/prices/snapshot', { thscodes }),
    indexHistorical: (thscode, { start, end } = {}) =>
      apiGet('/a-share-index/prices/historical', { thscode, interval: '1d', start, end }),
    indexConstituents: (thscode) => apiGet('/a-share-index/constituents/ths-stock-list', { thscode }),

    // 基金：基本资料 / 净值 / 区间收益 / 场内行情与历史 K 线。
    fundProfile: (thscode, fundType) => apiGet('/fund/profile/detail', { thscode, fund_type: fundType }),
    fundNav: (thscode, fundType, range) =>
      apiGet('/fund/performance/nav', { thscode, fund_type: fundType, range, nav_type: 'unit,adj' }),
    fundReturns: (thscode, fundType) => apiGet('/fund/performance/returns', { thscode, fund_type: fundType }),
    fundMarketSnapshot: (thscode) => apiGet('/fund/market/snapshot', { thscode }),
    fundMarketHistorical: (thscode, { start, end } = {}) =>
      apiGet('/fund/market/historical', { thscode, interval: '1d', start, end })
  };
}

module.exports = { ApiError, ApiErrorKind, fundTypeFor, buildApiUrl, parseEnvelope, createApiClient };
