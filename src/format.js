// 纯函数模块：金额/百分比格式化、自选去重与校验。
// 同时兼容浏览器(<script> 挂到 window.FinanceFormat)与 Node(require)，便于单元测试。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FinanceFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EMPTY = '—';

  function isNil(value) {
    return value === undefined || value === null || value === '';
  }

  function money(value) {
    if (isNil(value)) return EMPTY;
    const n = Number(value);
    if (!Number.isFinite(n)) return EMPTY;
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(n);
  }

  function toYi(value) {
    if (isNil(value)) return EMPTY;
    const n = Number(value);
    if (!Number.isFinite(n)) return EMPTY;
    return `${(n / 1e8).toFixed(2)} 亿`;
  }

  function formatPercent(value) {
    if (isNil(value)) return EMPTY;
    const n = Number(value);
    if (!Number.isFinite(n)) return EMPTY;
    return `${n >= 0 ? '+' : ''}${money(n)}%`;
  }

  function signClass(value) {
    if (isNil(value)) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n > 0 ? 'positive' : n < 0 ? 'negative' : '';
  }

  function dedupeWatchlist(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const code = item.thscode;
      if (typeof code !== 'string' || !code) return false;
      if (seen.has(code)) return false;
      seen.add(code);
      return true;
    });
  }

  function humanizeIndexId(id) {
    // 后端指标 ID 未在仓库文档中提供中文对照，这里只做可读化，不伪造中文语义。
    return String(id || '')
      .replace(/^calculate_/, '')
      .replace(/_/g, ' ');
  }

  function normalizeWatchlistItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.thscode !== 'string' || !item.thscode) return null;
    return {
      name: typeof item.name === 'string' ? item.name : item.thscode,
      thscode: item.thscode,
      asset_type: typeof item.asset_type === 'string' ? item.asset_type : 'a-share',
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      note: typeof item.note === 'string' ? item.note : ''
    };
  }

  return {
    EMPTY,
    isNil,
    money,
    toYi,
    formatPercent,
    signClass,
    dedupeWatchlist,
    normalizeWatchlistItem,
    humanizeIndexId
  };
});
