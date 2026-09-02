import test from 'node:test';
import assert from 'node:assert/strict';
import F from '../src/format.js';
import P from '../src/paper.js';

test('money 格式化与空值', () => {
  assert.equal(F.money(1234.5), '1,234.5');
  assert.equal(F.money(0), '0');
  assert.equal(F.money(null), '—');
  assert.equal(F.money(undefined), '—');
  assert.equal(F.money(''), '—');
  assert.equal(F.money('abc'), '—');
});

test('toYi 转亿', () => {
  assert.equal(F.toYi(100000000), '1.00 亿');
  assert.equal(F.toYi(null), '—');
  assert.equal(F.toYi('abc'), '—');
});

test('formatPercent 符号', () => {
  assert.equal(F.formatPercent(1.74), '+1.74%');
  assert.equal(F.formatPercent(-2.5), '-2.5%');
  assert.equal(F.formatPercent(null), '—');
});

test('signClass 涨跌分类', () => {
  assert.equal(F.signClass(1), 'positive');
  assert.equal(F.signClass(-1), 'negative');
  assert.equal(F.signClass(0), '');
  assert.equal(F.signClass(null), '');
});

test('dedupeWatchlist 按 thscode 去重并剔除无效项', () => {
  const list = [
    { thscode: '600519.SH', name: 'a' },
    { thscode: '600519.SH', name: 'b' },
    { thscode: '000001.SZ', name: 'c' },
    null,
    { name: '无代码' },
    { thscode: '' }
  ];
  assert.deepEqual(
    F.dedupeWatchlist(list).map((i) => i.thscode),
    ['600519.SH', '000001.SZ']
  );
});

test('normalizeWatchlistItem 补默认值', () => {
  const item = F.normalizeWatchlistItem({ thscode: '600519.SH', name: '贵州茅台' });
  assert.equal(item.name, '贵州茅台');
  assert.equal(item.asset_type, 'a-share');
  assert.equal(typeof item.createdAt, 'number');
  assert.equal(item.note, '');
  assert.equal(F.normalizeWatchlistItem({}), null);
  assert.equal(F.normalizeWatchlistItem(null), null);
});

test('humanizeIndexId 可读化', () => {
  assert.equal(
    F.humanizeIndexId('calculate_operating_income_yoy_growth_ratio'),
    'operating income yoy growth ratio'
  );
  assert.equal(F.humanizeIndexId(''), '');
});

test('虚拟盘候选、买入、卖出与账户指标', () => {
  let account = P.createAccount(1000);
  account = P.upsertCandidate(account, {
    thscode: '600519.SH',
    name: '测试股',
    lastPrice: 100,
    updatedAt: 1
  });
  account = P.executeOrder(account, {
    side: 'buy',
    thscode: '600519.SH',
    quantity: 5,
    price: 100,
    feeRate: 0
  });
  assert.equal(account.cash, 500);
  assert.equal(account.holdings[0].quantity, 5);
  assert.equal(P.metrics(account).equity, 1000);
  account = P.executeOrder(account, {
    side: 'sell',
    thscode: '600519.SH',
    quantity: 2,
    price: 110,
    feeRate: 0
  });
  assert.equal(account.cash, 720);
  assert.equal(account.holdings[0].quantity, 3);
  assert.equal(P.metrics(account).equity, 1020);
});

test('双账户账本迁移、回撤快照与均线策略保持独立', () => {
  let book = P.createBook(10000);
  book = P.addBookCandidate(book, { thscode: '600519.SH', name: '测试股', lastPrice: 10 });
  let manual = P.withBookCandidates(book.manual, book.candidates);
  manual = P.executeOrder(manual, {
    side: 'buy',
    thscode: '600519.SH',
    quantity: 100,
    price: 10,
    note: '人工计划'
  });
  manual = P.recordSnapshot(manual, new Map([['600519.SH', 8]]), Date.UTC(2025, 0, 2));
  const manualMetrics = P.metrics(P.withBookCandidates(manual, [{ ...book.candidates[0], lastPrice: 8 }]));
  assert.ok(manualMetrics.drawdownPct < 0);
  const run = P.runMovingAverageStrategy(
    P.withBookCandidates(book.strategy, book.candidates),
    book.candidates,
    { '600519.SH': [8, 8, 9, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] },
    { shortWindow: 3, longWindow: 5, allocationPct: 20, lotSize: 100 }
  );
  assert.equal(run.account.trades[0].source, 'strategy');
  assert.equal(run.decisions[0].action, 'buy');
  assert.equal(book.manual.trades.length, 0);
  const migrated = P.normalizeBook(P.createAccount(12345));
  assert.equal(migrated.manual.initialCash, 12345);
  assert.equal(migrated.strategy.initialCash, 12345);
});

test('历史回测逐日使用可见日线，历史练习按日推进', () => {
  const candidate = { thscode: '600519.SH', name: '测试股', lastPrice: 10, assetType: 'a-share' };
  const rows = [10, 10, 11, 12, 13, 14].map((close_price, index) => ({
    date_ms: Date.UTC(2025, 0, index + 2),
    close_price
  }));
  const backtest = P.runHistoricalBacktest(
    [candidate],
    { '600519.SH': rows },
    { shortWindow: 2, longWindow: 3, allocationPct: 20, lotSize: 100, initialCash: 10000 }
  );
  assert.equal(backtest.dates, 6);
  assert.equal(backtest.points.length, 6);
  assert.ok(backtest.account.trades.length > 0);
  const session = P.createPracticeSession(
    [candidate],
    { '600519.SH': rows },
    rows[0].date_ms,
    rows.at(-1).date_ms,
    10000
  );
  const initial = P.practiceState(session, [candidate]);
  assert.equal(initial.dateMs, rows[0].date_ms);
  const advanced = P.advancePracticeSession(session, [candidate]);
  assert.equal(advanced.state.dateMs, rows[1].date_ms);
  assert.equal(advanced.session.account.snapshots.length, 1);
});
