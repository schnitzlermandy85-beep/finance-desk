const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { createApiClient, ApiError, fundTypeFor } = require('./src/api');

const API_BASE = 'https://fuyao.aicubes.cn/api';
const STORE_FILE = () => path.join(app.getPath('userData'), 'settings.bin');
const CLAUDE_CONTEXT_DIR = () => path.join(app.getPath('userData'), 'ai-research');

function loadKey() {
  try {
    const value = fs.readFileSync(STORE_FILE());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8');
  } catch {
    return '';
  }
}

function saveKey(key) {
  if (!key || typeof key !== 'string' || !key.trim()) throw new Error('API Key 不能为空。');
  const value = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key.trim())
    : Buffer.from(key.trim(), 'utf8');
  fs.writeFileSync(STORE_FILE(), value, { mode: 0o600 });
}

function clearKey() {
  try {
    fs.unlinkSync(STORE_FILE());
  } catch {
    /* Key 文件不存在时无需处理 */
  }
}

// 主进程持有 Key，仅通过白名单 IPC 暴露受控数据访问；渲染层不接触文件系统与 Key。
const api = createApiClient({ base: API_BASE, fetchFn: fetch, getKey: loadKey });

// 将 ApiError 转成结构化结果返回，避免 Electron IPC 序列化只保留 message、丢失 kind。
function toResult(promise) {
  return promise
    .then((data) => ({ ok: true, data }))
    .catch((error) => {
      if (error instanceof ApiError) {
        return { ok: false, error: { kind: error.kind, message: error.message } };
      }
      return { ok: false, error: { kind: 'unknown', message: '请求未完成，请稍后重试。' } };
    });
}

// ---- 数据导出：主进程弹保存框，落盘 CSV/JSON（仅有限结果） ----
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serializeCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...body].join('\n');
}

async function saveExport(payload) {
  const format = payload.format === 'json' ? 'json' : 'csv';
  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const defaultName =
    typeof payload.defaultName === 'string' && payload.defaultName
      ? payload.defaultName
      : 'finance-desk-export';
  const ext = format === 'json' ? 'json' : 'csv';

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出数据',
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }]
  });
  if (canceled || !filePath) return { ok: true, data: { canceled: true } };

  const text = format === 'json' ? JSON.stringify(rows, null, 2) : serializeCsv(columns, rows);
  fs.writeFileSync(filePath, text, 'utf8');
  return { ok: true, data: { canceled: false, path: filePath, rows: rows.length, format } };
}

// ---- 本地 DuckDB：调用已安装 CLI，仅允许只读 SQL ----
function isReadOnlySql(sql) {
  const s = typeof sql === 'string' ? sql.trim() : '';
  if (!s) return false;
  const fragments = s.split(';').filter((part) => part.trim());
  if (fragments.length !== 1) return false; // 拒绝多语句，阻断注入后续写入
  return /^(select|with|explain|pragma|show|describe)\b/i.test(fragments[0]);
}

function runCli(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('hithink-finance', args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}

async function dbStatus() {
  try {
    const { stdout } = await runCli(['--version'], 5000);
    return { available: true, version: stdout.trim().split('\n')[0] || 'installed' };
  } catch {
    return { available: false, version: null };
  }
}

// Finder 启动的桌面应用通常不继承终端 PATH；先检查常见全局安装位置，再用登录 shell 兜底。
async function findHithinkFinanceCli() {
  const home = app.getPath('home');
  const candidates = [
    process.env.HITHINK_FINANCE_CLI_PATH,
    path.join(home, '.npm-global', 'bin', 'hithink-finance'),
    path.join(home, '.local', 'bin', 'hithink-finance'),
    '/opt/homebrew/bin/hithink-finance',
    '/usr/local/bin/hithink-finance'
  ];
  const known = candidates.find(
    (candidate) => candidate && path.isAbsolute(candidate) && fs.existsSync(candidate)
  );
  if (known) return known;

  return new Promise((resolve) => {
    execFile(
      '/bin/zsh',
      ['-lc', 'command -v hithink-finance 2>/dev/null'],
      { timeout: 5000 },
      (error, stdout) => {
        const executable =
          !error && stdout.split(/\r?\n/).find((line) => path.isAbsolute(line) && fs.existsSync(line));
        resolve(executable || null);
      }
    );
  });
}

async function hithinkStatus() {
  const cli = await findHithinkFinanceCli();
  if (!cli) return { available: false, configured: false, version: null };
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(cli, ['auth', 'status', '--format', 'json'], { timeout: 5000 }, (error, output) =>
        error ? reject(error) : resolve(output)
      );
    });
    const parsed = JSON.parse(stdout);
    const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    return { available: true, configured: Boolean(data && data.configured), version: null };
  } catch {
    return { available: true, configured: false, version: null };
  }
}

// 仅从主进程的安全存储读取 Key，并经 stdin 写入 CLI 自己的凭据库；不暴露给渲染层、终端参数或环境变量。
async function syncKeyToHithinkCli() {
  const key = loadKey();
  if (!key) throw new Error('请先在 Finance Desk 中安全保存 API Key。');
  const cli = await findHithinkFinanceCli();
  if (!cli) throw new Error('未检测到 hithink-finance CLI。请先在 Claude Code 环境中完成安装。');
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['auth', 'login', '--api-key-stdin', '--replace', '--format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('hithink-finance 未能保存凭据，请检查 CLI 安装与登录状态。'));
      // 只返回是否成功，不回传 CLI 输出，避免将意外的敏感内容带回页面。
      resolve({ configured: true, cli: path.basename(cli) });
    });
    child.stdin.end(`${key}\n`);
  });
}

async function dbQuery(sql) {
  if (!isReadOnlySql(sql)) {
    return {
      ok: false,
      error: { kind: 'bad-request', message: '仅允许只读 SQL 查询（SELECT/WITH/EXPLAIN）。' }
    };
  }
  try {
    const { stdout } = await runCli(['db', 'query', '--sql', sql, '--format', 'json']);
    const envelope = JSON.parse(stdout);
    if (envelope && envelope.code !== undefined && envelope.code !== 0) {
      return { ok: false, error: { kind: 'api', message: envelope.message || '本地数据库查询失败。' } };
    }
    return { ok: true, data: envelope && envelope.data !== undefined ? envelope.data : envelope };
  } catch (error) {
    const notInstalled = error.code === 'ENOENT';
    return {
      ok: false,
      error: {
        kind: notInstalled ? 'no-key' : 'unknown',
        message: notInstalled
          ? '未检测到 hithink-finance CLI，请先安装并初始化本地数据库。'
          : error.stderr || error.message || '本地数据库查询失败。'
      }
    };
  }
}

// ---- Claude Code 研究助手：仅生成研究简报并启动新终端会话，不提供任意命令执行能力。 ----
function claudeCommand() {
  const configured = process.env.CLAUDE_CODE_PATH;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return configured;
  const npmGlobal = path.join(app.getPath('home'), '.npm-global', 'bin', 'claude');
  return fs.existsSync(npmGlobal) ? npmGlobal : 'claude';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\\"'\\\"'")}'`;
}

function researchText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value)
    .replace(/[\r\n]/g, ' ')
    .slice(0, 500);
}

function buildResearchBrief(payload) {
  const asset = payload.asset || {};
  const quote = payload.quote || {};
  const lines = [
    '# Finance Desk 研究上下文',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '## 标的',
    `- 名称：${researchText(asset.name)}`,
    `- 代码：${researchText(asset.thscode)}`,
    `- 类型：${researchText(asset.assetType)}`,
    '',
    '## 最近行情快照',
    `- 最新价：${researchText(quote.lastPrice)}`,
    `- 涨跌幅：${researchText(quote.changePct)}`,
    `- 成交额：${researchText(quote.turnover)}`,
    `- 日内区间：${researchText(quote.dayRange)}`
  ];
  const sections = Array.isArray(payload.sections) ? payload.sections.slice(0, 4) : [];
  sections.forEach((section) => {
    if (!section || typeof section.title !== 'string' || !Array.isArray(section.rows)) return;
    lines.push('', `## ${researchText(section.title)}`);
    section.rows.slice(0, 8).forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const cells = Object.entries(row)
        .slice(0, 8)
        .map(([key, value]) => `${researchText(key)}：${researchText(value)}`)
        .join('；');
      if (cells) lines.push(`- ${cells}`);
    });
  });
  lines.push('', '> 此文件不含 Finance Desk 的 API Key。数据仅供研究，不构成投资建议。');
  return lines.join('\n');
}

function validateResearchPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.asset || typeof payload.asset !== 'object') {
    throw new Error('研究上下文无效。');
  }
  const { name, thscode, assetType } = payload.asset;
  if (![name, thscode, assetType].every((v) => typeof v === 'string' && v.trim())) {
    throw new Error('研究标的无效。');
  }
}

async function claudeStatus() {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(claudeCommand(), ['--version'], { timeout: 5000 }, (error, stdout) => {
        if (error) return reject(error);
        resolve({ stdout });
      });
    });
    return { available: true, version: stdout.trim() || 'installed' };
  } catch {
    return { available: false, version: null };
  }
}

async function launchClaudeResearch(payload) {
  validateResearchPayload(payload);
  const status = await claudeStatus();
  if (!status.available) throw new Error('未检测到 Claude Code。请先安装并登录 Claude Code。');

  fs.mkdirSync(CLAUDE_CONTEXT_DIR(), { recursive: true, mode: 0o700 });
  const contextPath = path.join(CLAUDE_CONTEXT_DIR(), 'finance-desk-research.md');
  fs.writeFileSync(contextPath, buildResearchBrief(payload), { encoding: 'utf8', mode: 0o600 });
  const prompt = [
    `请先阅读 ${contextPath}。`,
    '使用已安装的 hithink-finance Skill 对该标的开展研究；必要时用该 Skill 的数据能力核验或补充数据。',
    '请给出数据来源、关键结论、风险与待核验项；不要把研究结论表述为投资建议。'
  ].join(' ');
  const command = [
    `cd ${shellQuote(__dirname)}`,
    `${shellQuote(claudeCommand())} --add-dir ${shellQuote(CLAUDE_CONTEXT_DIR())} --name ${shellQuote('Finance Desk 研究助手')} ${shellQuote(prompt)}`
  ].join(' && ');

  if (process.platform !== 'darwin') {
    throw new Error('目前仅实现 macOS Terminal 启动方式。');
  }
  await new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`],
      (error) => (error ? reject(error) : resolve())
    );
  });
  return { started: true, contextPath, version: status.version };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 外链统一交给系统浏览器，主窗口不导航到外部站点；拒绝任意新窗口。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  window.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('settings:status', () => ({
    configured: Boolean(loadKey()),
    encrypted: safeStorage.isEncryptionAvailable()
  }));
  ipcMain.handle('settings:saveKey', (_, key) => {
    saveKey(key);
    return { configured: true, encrypted: safeStorage.isEncryptionAvailable() };
  });
  ipcMain.handle('settings:clearKey', () => {
    clearKey();
    return { configured: false };
  });
  ipcMain.handle('settings:syncHithinkKey', () => syncKeyToHithinkCli());
  ipcMain.handle('settings:hithinkStatus', () => hithinkStatus());

  ipcMain.handle('finance:search', (_, q, assetType) => toResult(api.search(q, 8, assetType)));
  ipcMain.handle('finance:snapshot', (_, thscodes) => toResult(api.snapshot(thscodes)));
  ipcMain.handle('finance:valuations', (_, thscodes) => toResult(api.valuations(thscodes)));
  ipcMain.handle('finance:income', (_, thscode) => toResult(api.income(thscode)));
  ipcMain.handle('finance:balance', (_, thscode) => toResult(api.balance(thscode)));
  ipcMain.handle('finance:cashflow', (_, thscode) => toResult(api.cashflow(thscode)));
  ipcMain.handle('finance:indicators', (_, thscode, report) => toResult(api.indicators(thscode, report)));
  ipcMain.handle('finance:historical', (_, thscode, opts) => toResult(api.historical(thscode, opts)));

  ipcMain.handle('finance:index-snapshot', (_, thscodes) => toResult(api.indexSnapshot(thscodes)));
  ipcMain.handle('finance:index-historical', (_, thscode, opts) =>
    toResult(api.indexHistorical(thscode, opts))
  );
  ipcMain.handle('finance:index-constituents', (_, thscode) => toResult(api.indexConstituents(thscode)));
  ipcMain.handle('finance:fund-profile', (_, thscode, assetType) =>
    toResult(api.fundProfile(thscode, fundTypeFor(assetType)))
  );
  ipcMain.handle('finance:fund-nav', (_, thscode, assetType, range) =>
    toResult(api.fundNav(thscode, fundTypeFor(assetType), range))
  );
  ipcMain.handle('finance:fund-returns', (_, thscode, assetType) =>
    toResult(api.fundReturns(thscode, fundTypeFor(assetType)))
  );
  ipcMain.handle('finance:fund-market-snapshot', (_, thscode) => toResult(api.fundMarketSnapshot(thscode)));
  ipcMain.handle('finance:fund-market-historical', (_, thscode, opts) =>
    toResult(api.fundMarketHistorical(thscode, opts))
  );

  ipcMain.handle('export:save', (_, payload) => saveExport(payload));
  ipcMain.handle('db:status', () => dbStatus());
  ipcMain.handle('db:query', (_, sql) => dbQuery(sql));
  ipcMain.handle('claude:status', () => claudeStatus());
  ipcMain.handle('claude:launchResearch', (_, payload) => launchClaudeResearch(payload));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
