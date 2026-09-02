import test from 'node:test';
import assert from 'node:assert/strict';
import C from '../src/chart.js';

const bars = [
  {
    date_ms: Date.UTC(2025, 0, 30),
    open_price: 10,
    high_price: 12,
    low_price: 9,
    close_price: 11,
    volume: 100
  },
  {
    date_ms: Date.UTC(2025, 0, 31),
    open_price: 11,
    high_price: 14,
    low_price: 10,
    close_price: 13,
    volume: 200
  },
  {
    date_ms: Date.UTC(2025, 1, 3),
    open_price: 13,
    high_price: 15,
    low_price: 12,
    close_price: 14,
    volume: 300
  },
  {
    date_ms: Date.UTC(2026, 0, 2),
    open_price: 14,
    high_price: 16,
    low_price: 13,
    close_price: 15,
    volume: 400
  }
];

test('月 K 聚合保留开高低收并汇总成交量', () => {
  const monthly = C.aggregateBars(bars, 'month');
  assert.equal(monthly.length, 3);
  assert.deepEqual(monthly[0], {
    ...bars[1],
    open_price: 10,
    high_price: 14,
    low_price: 9,
    close_price: 13,
    volume: 300
  });
});

test('年 K 聚合跨月汇总，日 K 保持排序', () => {
  const yearly = C.aggregateBars(bars, 'year');
  assert.equal(yearly.length, 2);
  assert.equal(yearly[0].open_price, 10);
  assert.equal(yearly[0].close_price, 14);
  assert.equal(yearly[0].high_price, 15);
  assert.equal(yearly[0].low_price, 9);
  assert.equal(yearly[0].volume, 600);
  assert.deepEqual(
    C.aggregateBars([...bars].reverse(), 'day').map((bar) => bar.date_ms),
    bars.map((bar) => bar.date_ms)
  );
});

test('横轴日期随 K 线周期变化', () => {
  assert.equal(C.formatAxisDate(bars[0].date_ms, 'day'), '01-30');
  assert.equal(C.formatAxisDate(bars[0].date_ms, 'month'), '2025-01');
  assert.equal(C.formatAxisDate(bars[0].date_ms, 'year'), '2025');
});
