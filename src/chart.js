// K 线周期聚合：接口只取日线，月线/年线在本地从完整日线聚合而成。
// 同时兼容浏览器与 Node，方便在不启动 Electron 的情况下测试。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FinanceChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PERIODS = {
    day: { label: '日 K', years: 1 },
    month: { label: '月 K', years: 5 },
    year: { label: '年 K', years: 10 }
  };

  function periodKey(dateMs, period) {
    const date = new Date(Number(dateMs));
    const year = date.getFullYear();
    if (period === 'year') return String(year);
    return `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function aggregateBars(rows, period = 'day') {
    const bars = (Array.isArray(rows) ? rows : [])
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
    if (period === 'day') return bars;

    const groups = new Map();
    for (const bar of bars) {
      const key = periodKey(bar.date_ms, period);
      const previous = groups.get(key);
      if (!previous) {
        groups.set(key, { ...bar });
        continue;
      }
      previous.high_price = Math.max(previous.high_price, bar.high_price);
      previous.low_price = Math.min(previous.low_price, bar.low_price);
      previous.close_price = bar.close_price;
      previous.volume += bar.volume;
      // 使用这一周期最后一个交易日，悬浮提示与横坐标更贴近收盘数据。
      previous.date_ms = bar.date_ms;
    }
    return [...groups.values()];
  }

  function formatAxisDate(dateMs, period) {
    const date = new Date(Number(dateMs));
    if (!Number.isFinite(date.getTime())) return '—';
    if (period === 'year') return String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return period === 'month'
      ? `${date.getFullYear()}-${month}`
      : `${month}-${String(date.getDate()).padStart(2, '0')}`;
  }

  return { PERIODS, aggregateBars, formatAxisDate };
});
