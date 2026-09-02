import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, buildApiUrl, parseEnvelope, fundTypeFor } from '../src/api.js';

test('buildApiUrl 忽略空参数', () => {
  const u = new URL(buildApiUrl('https://x/api', '/meta/tickers/search', { q: '贵州茅台', limit: 8, x: '' }));
  assert.equal(u.origin + u.pathname, 'https://x/api/meta/tickers/search');
  assert.equal(u.searchParams.get('q'), '贵州茅台');
  assert.equal(u.searchParams.get('limit'), '8');
  assert.equal(u.searchParams.has('x'), false);
});

test('parseEnvelope code===0 返回 data', () => {
  assert.deepEqual(parseEnvelope({ code: 0, data: { item: [1] } }), { item: [1] });
});

test('parseEnvelope 业务 code 抛 bad-request', () => {
  assert.throws(
    () => parseEnvelope({ code: 1003 }),
    (e) => e.kind === 'bad-request'
  );
});

test('parseEnvelope 非对象抛 unknown', () => {
  assert.throws(
    () => parseEnvelope(null),
    (e) => e.kind === 'unknown'
  );
});

function mockClient(responses, key = 'k') {
  let i = 0;
  const fetchFn = async (url, opts) => {
    const r = responses[i % responses.length];
    i += 1;
    return { ...r, url, opts };
  };
  const client = createApiClient({ base: 'https://x/api', fetchFn, getKey: () => key });
  return client;
}

test('无 Key 抛 no-key，且不发起请求', async () => {
  const client = createApiClient({
    base: 'https://x/api',
    fetchFn: async () => {
      throw new Error('should not call');
    },
    getKey: () => ''
  });
  await assert.rejects(client.search('x'), (e) => e.kind === 'no-key');
});

test('401 抛 auth', async () => {
  const client = mockClient([{ status: 401, ok: false, json: async () => ({ code: 0 }) }]);
  await assert.rejects(client.search('x'), (e) => e.kind === 'auth');
});

test('429 抛 rate-limit', async () => {
  const client = mockClient([{ status: 429, ok: false, json: async () => ({}) }]);
  await assert.rejects(client.search('x'), (e) => e.kind === 'rate-limit');
});

test('网络异常抛 network', async () => {
  const client = createApiClient({
    base: 'https://x/api',
    fetchFn: async () => {
      throw new Error('ENOTFOUND');
    },
    getKey: () => 'k'
  });
  await assert.rejects(client.search('x'), (e) => e.kind === 'network');
});

test('非 2xx 无 message 抛 api 并含 HTTP 状态码', async () => {
  const client = mockClient([{ status: 500, ok: false, json: async () => null }]);
  await assert.rejects(client.search('x'), (e) => e.kind === 'api' && /500/.test(e.message));
});

test('成功返回 data', async () => {
  const client = mockClient([
    { status: 200, ok: true, json: async () => ({ code: 0, data: { item: [{ thscode: '600519.SH' }] } }) }
  ]);
  const data = await client.search('600519');
  assert.equal(data.item[0].thscode, '600519.SH');
});

test('Key 只进 X-api-key 头，不泄露到 URL', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};
  const client = createApiClient({
    base: 'https://x/api',
    getKey: () => 'SECRET',
    fetchFn: async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return { status: 200, ok: true, json: async () => ({ code: 0, data: 1 }) };
    }
  });
  await client.search('x');
  assert.equal(capturedHeaders['X-api-key'], 'SECRET');
  assert.ok(!capturedUrl.includes('SECRET'));
});

test('historical 默认前复权并传 interval=1d', async () => {
  let capturedUrl = '';
  const client = createApiClient({
    base: 'https://x/api',
    getKey: () => 'k',
    fetchFn: async (url) => {
      capturedUrl = url;
      return { status: 200, ok: true, json: async () => ({ code: 0, data: { item: [] } }) };
    }
  });
  await client.historical('600519.SH', { start: 1000, end: 2000 });
  const u = new URL(capturedUrl);
  assert.equal(u.searchParams.get('interval'), '1d');
  assert.equal(u.searchParams.get('adjust'), 'forward');
  assert.equal(u.searchParams.get('start'), '1000');
  assert.equal(u.searchParams.get('end'), '2000');
});

function urlCapturingClient() {
  let capturedUrl = '';
  const client = createApiClient({
    base: 'https://x/api',
    getKey: () => 'k',
    fetchFn: async (url) => {
      capturedUrl = url;
      return { status: 200, ok: true, json: async () => ({ code: 0, data: { item: [] } }) };
    }
  });
  return { client, getUrl: () => new URL(capturedUrl) };
}

test('fundTypeFor 映射 asset_type → fund_type', () => {
  assert.equal(fundTypeFor('fund-otc'), 'otc');
  assert.equal(fundTypeFor('fund-etf'), 'exchange');
  assert.equal(fundTypeFor('fund-lof'), 'exchange');
  assert.equal(fundTypeFor('fund-reits'), 'reits');
  assert.equal(fundTypeFor('a-share'), null);
});

test('search 传入 asset_type 过滤', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.search('茅台', 8, 'fund-etf');
  assert.equal(getUrl().searchParams.get('asset_type'), 'fund-etf');
});

test('indexSnapshot 走指数快照端点并传 thscodes', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.indexSnapshot('000300.SH');
  assert.equal(getUrl().pathname, '/api/a-share-index/prices/snapshot');
  assert.equal(getUrl().searchParams.get('thscodes'), '000300.SH');
});

test('indexHistorical 无 adjust 参数且 interval=1d', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.indexHistorical('000300.SH', { start: 1000, end: 2000 });
  assert.equal(getUrl().pathname, '/api/a-share-index/prices/historical');
  assert.equal(getUrl().searchParams.get('interval'), '1d');
  assert.equal(getUrl().searchParams.has('adjust'), false);
});

test('indexConstituents 走成分股端点', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.indexConstituents('886042.TI');
  assert.equal(getUrl().pathname, '/api/a-share-index/constituents/ths-stock-list');
  assert.equal(getUrl().searchParams.get('thscode'), '886042.TI');
});

test('fundProfile 传 fund_type 与 thscode', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.fundProfile('025480.OF', 'otc');
  assert.equal(getUrl().pathname, '/api/fund/profile/detail');
  assert.equal(getUrl().searchParams.get('fund_type'), 'otc');
  assert.equal(getUrl().searchParams.get('thscode'), '025480.OF');
});

test('fundNav 传 nav_type=unit,adj', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.fundNav('025480.OF', 'otc', 'year');
  assert.equal(getUrl().pathname, '/api/fund/performance/nav');
  assert.equal(getUrl().searchParams.get('nav_type'), 'unit,adj');
  assert.equal(getUrl().searchParams.get('range'), 'year');
});

test('fundMarketHistorical 无 adjust 且 interval=1d', async () => {
  const { client, getUrl } = urlCapturingClient();
  await client.fundMarketHistorical('510300.SH', { start: 1000, end: 2000 });
  assert.equal(getUrl().pathname, '/api/fund/market/historical');
  assert.equal(getUrl().searchParams.get('interval'), '1d');
  assert.equal(getUrl().searchParams.has('adjust'), false);
});

test('parseEnvelope 基金专用 code 3002/3004 映射为 bad-request', () => {
  assert.throws(
    () => parseEnvelope({ code: 3002 }),
    (e) => e.kind === 'bad-request' && /稍后再试/.test(e.message)
  );
  assert.throws(
    () => parseEnvelope({ code: 3004 }),
    (e) => e.kind === 'bad-request' && /不支持/.test(e.message)
  );
});
