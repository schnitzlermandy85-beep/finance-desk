import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadSrc = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');

function loadPreload() {
  let exposed = null;
  const ipcRenderer = { invoke: async (channel, ...args) => ({ channel, args }) };
  const contextBridge = {
    exposeInMainWorld: (name, api) => {
      exposed = api;
    }
  };
  const sandbox = {
    require: (mod) => {
      if (mod === 'electron') return { contextBridge, ipcRenderer };
      throw new Error('unexpected require: ' + mod);
    },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(preloadSrc, sandbox, { filename: 'preload.js' });
  return { exposed, ipcRenderer };
}

const EXPECTED_TOP_LEVEL = [
  'search',
  'snapshot',
  'valuations',
  'income',
  'balance',
  'cashflow',
  'indicators',
  'historical',
  'indexSnapshot',
  'indexHistorical',
  'indexConstituents',
  'fundProfile',
  'fundNav',
  'fundReturns',
  'fundMarketSnapshot',
  'fundMarketHistorical',
  'exportData',
  'claude',
  'db',
  'settings'
];

test('preload 只暴露白名单顶层 API', () => {
  const { exposed } = loadPreload();
  assert.ok(exposed);
  assert.deepEqual(Object.keys(exposed).sort(), EXPECTED_TOP_LEVEL.sort());
});

test('preload 不向渲染层暴露 ipcRenderer / require / process', () => {
  const { exposed } = loadPreload();
  assert.equal(exposed.ipcRenderer, undefined);
  assert.equal(exposed.require, undefined);
  assert.equal(exposed.process, undefined);
  assert.equal(exposed.module, undefined);
});

test('settings 子对象只暴露安全设置方法', () => {
  const { exposed } = loadPreload();
  assert.deepEqual(
    Object.keys(exposed.settings).sort(),
    ['clearKey', 'hithinkStatus', 'saveKey', 'status', 'syncHithinkKey'].sort()
  );
});

test('preload 方法走正确 IPC 通道并校验参数', async () => {
  const { exposed } = loadPreload();
  assert.deepEqual(await exposed.snapshot('600519.SH'), { channel: 'finance:snapshot', args: ['600519.SH'] });
  assert.deepEqual(await exposed.search(' 茅台 '), { channel: 'finance:search', args: ['茅台'] });
});

test('preload 拒绝非法参数类型', () => {
  const { exposed } = loadPreload();
  assert.throws(() => exposed.search(123), /字符串/);
  assert.throws(() => exposed.settings.saveKey(''), /字符串/);
  assert.throws(() => exposed.historical('600519.SH', {}), /起止时间/);
});

test('preload 指数/基金方法走正确 IPC 通道', async () => {
  const { exposed } = loadPreload();
  assert.deepEqual(await exposed.indexSnapshot('000300.SH'), {
    channel: 'finance:index-snapshot',
    args: ['000300.SH']
  });
  const idx = await exposed.indexHistorical('000300.SH', { start: 1, end: 2 });
  assert.equal(idx.channel, 'finance:index-historical');
  assert.equal(idx.args[0], '000300.SH');
  assert.equal(idx.args[1].start, 1);
  assert.equal(idx.args[1].end, 2);
  assert.deepEqual(await exposed.fundProfile('025480.OF', 'fund-otc'), {
    channel: 'finance:fund-profile',
    args: ['025480.OF', 'fund-otc']
  });
});

test('preload fundProfile 拒绝非基金 asset_type', () => {
  const { exposed } = loadPreload();
  assert.throws(() => exposed.fundProfile('025480.OF', 'a-share'), /基金类型/);
});

test('preload exportData 校验并清洗导出载荷', async () => {
  const { exposed } = loadPreload();
  const result = await exposed.exportData({
    format: 'json',
    columns: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B', extra: 1 }
    ],
    rows: [{ a: 1 }],
    defaultName: 'x'
  });
  assert.equal(result.channel, 'export:save');
  assert.equal(result.args[0].format, 'json');
  assert.equal(result.args[0].defaultName, 'x');
  assert.equal(result.args[0].columns.length, 2);
  assert.equal(result.args[0].columns[0].key, 'a');
  assert.equal(result.args[0].columns[1].key, 'b');
  assert.equal(result.args[0].columns[1].label, 'B');
  assert.equal(result.args[0].columns[1].extra, undefined);
});

test('preload db 子对象只暴露 status/query', async () => {
  const { exposed } = loadPreload();
  assert.deepEqual(Object.keys(exposed.db).sort(), ['query', 'status'].sort());
  assert.deepEqual(await exposed.db.query('SELECT 1'), { channel: 'db:query', args: ['SELECT 1'] });
});

test('preload claude 子对象只暴露状态与受控研究启动', async () => {
  const { exposed } = loadPreload();
  assert.deepEqual(Object.keys(exposed.claude).sort(), ['launchResearch', 'status']);
  const result = await exposed.claude.launchResearch({
    asset: { name: '贵州茅台', thscode: '600519.SH', assetType: 'A 股' },
    quote: { lastPrice: '—' },
    sections: []
  });
  assert.equal(result.channel, 'claude:launchResearch');
  assert.equal(result.args[0].asset.thscode, '600519.SH');
  assert.throws(() => exposed.claude.launchResearch({}), /研究上下文/);
});
