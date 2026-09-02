// 本地日频虚拟盘账本：不连接券商、不发出真实订单；与 UI 分离，便于测试与审计。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperTrading = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_CASH = 100000;

  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function createAccount(initialCash = DEFAULT_CASH) {
    const cash = number(initialCash, DEFAULT_CASH);
    return { version: 2, initialCash: cash, cash, candidates: [], holdings: [], trades: [], snapshots: [] };
  }

  function normalizeAccount(value) {
    if (!value || typeof value !== 'object') return createAccount();
    const account = createAccount(value.initialCash);
    account.cash = number(value.cash, account.initialCash);
    account.candidates = Array.isArray(value.candidates)
      ? value.candidates.filter((c) => c && c.thscode)
      : [];
    account.holdings = Array.isArray(value.holdings)
      ? value.holdings.filter((h) => h && h.thscode && number(h.quantity) > 0)
      : [];
    account.trades = Array.isArray(value.trades) ? value.trades.slice(0, 500) : [];
    account.snapshots = Array.isArray(value.snapshots) ? value.snapshots.slice(0, 1000) : [];
    return account;
  }

  function upsertCandidate(account, candidate) {
    const next = normalizeAccount(account);
    const item = {
      thscode: String(candidate.thscode || ''),
      name: String(candidate.name || candidate.thscode || ''),
      assetType: String(candidate.assetType || 'a-share'),
      lastPrice: number(candidate.lastPrice),
      updatedAt: number(candidate.updatedAt, Date.now())
    };
    if (!item.thscode || item.lastPrice <= 0) throw new Error('候选标的缺少有效参考价。');
    next.candidates = [item, ...next.candidates.filter((c) => c.thscode !== item.thscode)];
    return next;
  }

  function executeOrder(
    account,
    { side, thscode, quantity, price, feeRate = 0.0003, note = '', source = 'manual' }
  ) {
    const next = normalizeAccount(account);
    const qty = Math.floor(number(quantity));
    const px = number(price);
    const fee = Math.max(0, number(feeRate));
    if (!['buy', 'sell'].includes(side) || !thscode || qty <= 0 || px <= 0)
      throw new Error('模拟订单参数无效。');
    const gross = qty * px;
    const costs = gross * fee;
    const holding = next.holdings.find((h) => h.thscode === thscode);
    if (side === 'buy') {
      if (next.cash + 1e-8 < gross + costs) throw new Error('可用虚拟现金不足。');
      next.cash -= gross + costs;
      if (holding) {
        const totalCost = holding.averageCost * holding.quantity + gross + costs;
        holding.quantity += qty;
        holding.averageCost = totalCost / holding.quantity;
      } else {
        next.holdings.push({ thscode, quantity: qty, averageCost: (gross + costs) / qty });
      }
    } else {
      if (!holding || holding.quantity < qty) throw new Error('虚拟持仓数量不足。');
      next.cash += gross - costs;
      holding.quantity -= qty;
      if (holding.quantity === 0) next.holdings = next.holdings.filter((h) => h !== holding);
    }
    next.trades.unshift({
      side,
      thscode,
      quantity: qty,
      price: px,
      costs,
      note: String(note).slice(0, 500),
      source,
      createdAt: Date.now()
    });
    return next;
  }

  function metrics(account) {
    const next = normalizeAccount(account);
    const prices = new Map(next.candidates.map((c) => [c.thscode, number(c.lastPrice)]));
    const marketValue = next.holdings.reduce((sum, h) => sum + h.quantity * (prices.get(h.thscode) || 0), 0);
    const equity = next.cash + marketValue;
    const peak = Math.max(next.initialCash, ...next.snapshots.map((item) => number(item.equity, 0)), equity);
    const drawdownPct = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
    const totalCosts = next.trades.reduce((sum, item) => sum + number(item.costs), 0);
    const turnover = next.trades.reduce((sum, item) => sum + number(item.quantity) * number(item.price), 0);
    return {
      cash: next.cash,
      marketValue,
      equity,
      returnPct: ((equity - next.initialCash) / next.initialCash) * 100,
      peak,
      drawdownPct,
      totalCosts,
      turnover
    };
  }

  function recordSnapshot(account, prices, asOf = Date.now()) {
    const next = normalizeAccount(account);
    const m = metricsWithPrices(next, prices);
    const day = new Date(asOf).toISOString().slice(0, 10);
    const snapshot = {
      day,
      asOf: number(asOf, Date.now()),
      equity: m.equity,
      cash: m.cash,
      marketValue: m.marketValue
    };
    next.snapshots = [snapshot, ...next.snapshots.filter((item) => item.day !== day)].slice(0, 1000);
    return next;
  }

  function metricsWithPrices(account, prices) {
    const next = normalizeAccount(account);
    const priceMap = prices instanceof Map ? prices : new Map(Object.entries(prices || {}));
    const candidates = next.candidates.map((item) => ({
      ...item,
      lastPrice: number(priceMap.get(item.thscode), item.lastPrice)
    }));
    return metrics({ ...next, candidates });
  }

  function createBook(initialCash = DEFAULT_CASH) {
    return {
      version: 2,
      candidates: [],
      manual: createAccount(initialCash),
      strategy: createAccount(initialCash),
      strategyConfig: { shortWindow: 5, longWindow: 20, allocationPct: 20, lotSize: 100, version: 'MA-v1' },
      simulation: { mode: 'forward', backtestRuns: [], practice: null }
    };
  }

  function normalizeBook(value) {
    if (!value || typeof value !== 'object') return createBook();
    // 兼容旧版单账户：保留为人工盘，并创建相同初始资金的策略盘。
    if ('cash' in value || 'holdings' in value) {
      const manual = normalizeAccount(value);
      return { ...createBook(manual.initialCash), candidates: manual.candidates, manual };
    }
    const fallback = createBook(value.manual && value.manual.initialCash);
    const candidates = Array.isArray(value.candidates)
      ? value.candidates.filter((item) => item && item.thscode)
      : [];
    return {
      ...fallback,
      candidates,
      manual: normalizeAccount(value.manual),
      strategy: normalizeAccount(value.strategy),
      strategyConfig: { ...fallback.strategyConfig, ...(value.strategyConfig || {}) },
      simulation: {
        ...fallback.simulation,
        ...(value.simulation || {}),
        backtestRuns: Array.isArray(value.simulation && value.simulation.backtestRuns)
          ? value.simulation.backtestRuns.slice(0, 20)
          : []
      }
    };
  }

  function addBookCandidate(book, candidate) {
    const next = normalizeBook(book);
    const withCandidate = upsertCandidate({ ...next.manual, candidates: next.candidates }, candidate);
    next.candidates = withCandidate.candidates;
    return next;
  }

  function withBookCandidates(account, candidates) {
    return normalizeAccount({ ...account, candidates });
  }

  function movingAverage(values, window) {
    const valid = values.map(Number).filter(Number.isFinite);
    if (valid.length < window || window <= 0) return null;
    return valid.slice(-window).reduce((sum, value) => sum + value, 0) / window;
  }

  function runMovingAverageStrategy(account, candidates, historyByCode, config = {}) {
    let next = withBookCandidates(account, candidates);
    const settings = { shortWindow: 5, longWindow: 20, allocationPct: 20, lotSize: 100, ...config };
    if (settings.shortWindow >= settings.longWindow) throw new Error('短期均线窗口必须小于长期均线窗口。');
    const decisions = [];
    for (const candidate of candidates) {
      const closes = historyByCode && historyByCode[candidate.thscode];
      const shortMa = movingAverage(closes || [], settings.shortWindow);
      const longMa = movingAverage(closes || [], settings.longWindow);
      if (!shortMa || !longMa || candidate.lastPrice <= 0) {
        decisions.push({
          thscode: candidate.thscode,
          action: 'skip',
          reason: '历史日线不足，无法计算均线。'
        });
        continue;
      }
      const holding = next.holdings.find((item) => item.thscode === candidate.thscode);
      if (shortMa > longMa && !holding) {
        const budget = metrics(next).equity * (number(settings.allocationPct) / 100);
        const qty = Math.floor(budget / candidate.lastPrice / settings.lotSize) * settings.lotSize;
        if (qty > 0 && next.cash >= qty * candidate.lastPrice * 1.0003) {
          next = executeOrder(next, {
            side: 'buy',
            thscode: candidate.thscode,
            quantity: qty,
            price: candidate.lastPrice,
            source: 'strategy',
            note: `MA${settings.shortWindow} ${shortMa.toFixed(2)} > MA${settings.longWindow} ${longMa.toFixed(2)}`
          });
          decisions.push({
            thscode: candidate.thscode,
            action: 'buy',
            reason: '短期均线位于长期均线上方。',
            shortMa,
            longMa
          });
        } else
          decisions.push({
            thscode: candidate.thscode,
            action: 'hold',
            reason: '资金不足以按设定仓位买入。',
            shortMa,
            longMa
          });
      } else if (shortMa < longMa && holding) {
        next = executeOrder(next, {
          side: 'sell',
          thscode: candidate.thscode,
          quantity: holding.quantity,
          price: candidate.lastPrice,
          source: 'strategy',
          note: `MA${settings.shortWindow} ${shortMa.toFixed(2)} < MA${settings.longWindow} ${longMa.toFixed(2)}`
        });
        decisions.push({
          thscode: candidate.thscode,
          action: 'sell',
          reason: '短期均线位于长期均线下方。',
          shortMa,
          longMa
        });
      } else
        decisions.push({
          thscode: candidate.thscode,
          action: 'hold',
          reason: '当前策略条件未触发交易。',
          shortMa,
          longMa
        });
    }
    return { account: next, decisions };
  }

  function barDate(bar) {
    return number(bar && bar.date_ms);
  }

  function normalizedHistory(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({ date_ms: barDate(row), close_price: number(row.close_price) }))
      .filter((row) => row.date_ms > 0 && row.close_price > 0)
      .sort((a, b) => a.date_ms - b.date_ms);
  }

  // 逐日推进：策略只获得截至当天收盘的数据；本 MVP 以当天收盘价撮合，供学习和比较，不代表真实可成交性。
  function runHistoricalBacktest(candidates, historyByCode, config = {}) {
    const histories = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.thscode,
        normalizedHistory(historyByCode && historyByCode[candidate.thscode])
      ])
    );
    const dates = [
      ...new Set(
        Object.values(histories)
          .flat()
          .map((bar) => bar.date_ms)
      )
    ].sort((a, b) => a - b);
    let account = createAccount(config.initialCash || DEFAULT_CASH);
    const points = [];
    const allDecisions = [];
    for (const date of dates) {
      const active = candidates
        .map((candidate) => {
          const rows = histories[candidate.thscode];
          const current = rows.find((bar) => bar.date_ms === date);
          if (!current) return null;
          return { ...candidate, lastPrice: current.close_price };
        })
        .filter(Boolean);
      if (!active.length) continue;
      const visibleHistory = Object.fromEntries(
        active.map((candidate) => [
          candidate.thscode,
          histories[candidate.thscode].filter((bar) => bar.date_ms <= date).map((bar) => bar.close_price)
        ])
      );
      const run = runMovingAverageStrategy(account, active, visibleHistory, config);
      account = recordSnapshot(
        run.account,
        new Map(active.map((item) => [item.thscode, item.lastPrice])),
        date
      );
      const m = metrics(withBookCandidates(account, active));
      points.push({ date_ms: date, equity: m.equity, returnPct: m.returnPct, drawdownPct: m.drawdownPct });
      allDecisions.push(...run.decisions.map((item) => ({ ...item, date_ms: date })));
    }
    return { account, points, decisions: allDecisions, dates: dates.length };
  }

  function createPracticeSession(candidates, historyByCode, startMs, endMs, initialCash = DEFAULT_CASH) {
    const start = number(startMs);
    const end = number(endMs);
    if (!start || !end || start > end) throw new Error('历史练习需要有效的起止日期。');
    const byCode = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.thscode,
        normalizedHistory(historyByCode && historyByCode[candidate.thscode]).filter(
          (bar) => bar.date_ms >= start && bar.date_ms <= end
        )
      ])
    );
    const dates = [
      ...new Set(
        Object.values(byCode)
          .flat()
          .map((bar) => bar.date_ms)
      )
    ].sort((a, b) => a - b);
    if (!dates.length) throw new Error('该日期范围没有可用于练习的日线。');
    return {
      version: 1,
      startMs: start,
      endMs: end,
      dates,
      cursor: 0,
      byCode,
      account: createAccount(initialCash)
    };
  }

  function practiceState(session, candidates) {
    if (
      !session ||
      !Array.isArray(session.dates) ||
      session.cursor < 0 ||
      session.cursor >= session.dates.length
    )
      return null;
    const dateMs = session.dates[session.cursor];
    const prices = new Map();
    for (const candidate of candidates) {
      const current = (session.byCode[candidate.thscode] || []).find((bar) => bar.date_ms === dateMs);
      if (current) prices.set(candidate.thscode, current.close_price);
    }
    return { dateMs, prices, isFinished: session.cursor >= session.dates.length - 1 };
  }

  function advancePracticeSession(session, candidates) {
    const next = { ...session, cursor: Math.min(session.cursor + 1, session.dates.length - 1) };
    const state = practiceState(next, candidates);
    next.account = recordSnapshot(withBookCandidates(next.account, candidates), state.prices, state.dateMs);
    return { session: next, state };
  }

  return {
    createAccount,
    normalizeAccount,
    upsertCandidate,
    executeOrder,
    metrics,
    recordSnapshot,
    metricsWithPrices,
    createBook,
    normalizeBook,
    addBookCandidate,
    withBookCandidates,
    movingAverage,
    runMovingAverageStrategy,
    runHistoricalBacktest,
    createPracticeSession,
    practiceState,
    advancePracticeSession
  };
});
