# Finance Desk × Claude Code × hithink-finance 操作手册

本文说明 Finance Desk 如何把桌面研究页面与 Claude Code、`hithink-finance` CLI、官方 Skills 和本地 DuckDB 组合起来。目标是提高研究效率与可复现性；它不提供交易执行、选股推荐或自动下单。

## 1. 先理解三套独立边界

| 组件 | 负责什么 | 凭据如何保存 |
| --- | --- | --- |
| Finance Desk | 搜索、看盘、图表、财报、自选、导出 | Electron `safeStorage` |
| hithink-finance CLI | 真实数据查询、Skill 能力、本地 DuckDB 生命周期 | CLI 自己的凭据存储 |
| Claude Code | 读取研究上下文、调用已安装的 Skills、组织研究结论 | Claude Code 登录状态 |

Finance Desk 不能也不应让 Claude Code 直接读取它的加密 Key。两个程序的凭据库互相隔离，正是此前 AI 研究助手显示 `configured: false` 的原因。

## 2. 最方便的首次配置

1. 在 Finance Desk 的“连接设置”保存 API Key。
2. 点击“同步到 hithink-finance”。阅读系统确认框后确认。
3. 应用只会在主进程中读取 Key，并通过 `hithink-finance auth login --api-key-stdin --replace --format json` 的标准输入写进 CLI 凭据库。
4. Key 不会进入页面 JavaScript、研究简报、Claude 提示词、终端命令、环境变量、日志或项目文件。
5. 打开一个标的后点击“AI 研究助手”，再让 Claude Code 开始实时查证。

若同步失败，先在 Terminal 运行以下命令确认安装与认证状态；不要把 Key 粘贴到聊天记录或命令行参数中：

```bash
hithink-finance version --format json
hithink-finance auth status --format json
hithink-finance doctor --format json
```

也可以在交互式 Terminal 中手动运行 `hithink-finance auth login`，它会隐藏输入。

## 3. AI 研究助手的实际数据流

```text
标的详情页
  → 主进程生成最小研究简报（行情 + 有限财务/基金/成分股摘要）
  → macOS Terminal 新开 Claude Code 会话
  → Claude 读取简报并调用已安装的 hithink-finance Skills
  → CLI 从自己的凭据库读取 Key，按需实时取数或查询本地数据库
  → Claude 输出带来源、时间点、风险与待核验项的中立研究结果
```

简报只作为起点，不能替代实时核验。应要求 Claude 明确区分“来自简报的存量数据”和“刚通过 CLI 获取的数据”。

推荐提问模板：

```text
请先读取 Finance Desk 研究简报，再用 hithink-finance 核验当前行情与估值。
补充最近四期三表和财务指标，标明数据时间点、来源、缺失字段与待核验项。
只做中立研究摘要，不给出买卖、仓位或择时建议。
```

## 4. Skills 的维护与扩展

`hithink-finance` 当前包含 10 个配套 Skill，分别覆盖共享认证、标的搜索、行情、财务、估值、指数、基金、特色数据、本地数据和中立研究。

每次 CLI 更新或 Claude Code 找不到能力时，优先使用 CLI 管理，而不是手工复制任意单个 Skill 文件：

```bash
hithink-finance skills status --format json
hithink-finance skills sync --format json
hithink-finance capabilities --format json
```

使用新能力前，让 Claude 先查看当前契约：

```bash
hithink-finance schema <capability-id> --format json
```

新增非官方 Skill 时，建议为每项能力建立独立目录、版本号、最小权限说明和测试样例；不要让一个通用 Skill 获得无限制的 shell、数据库写入或网络权限。UI 侧应把它注册成明确按钮/页面，不要把任意自然语言直接映射为本机命令。

## 5. 本地 DuckDB：推荐生命周期

Finance Desk 当前“本地数据”页只允许只读 SQL。数据库的初始化、同步、迁移、修复与删除应继续由 CLI 执行，并在桌面端逐步加成具有状态、进度和二次确认的操作卡。

| 阶段 | 推荐操作 | UI 要求 |
| --- | --- | --- |
| 检查 | `data status`、`data validate` | 显示库路径、大小、最新日期、schema 和质量结果 |
| 首次建库 | 先 `schema data.init`，再 `data init` | 显示预计下载/磁盘占用；用户确认后运行 |
| 日常更新 | 先 `schema data.sync`，再 `data sync` | 单任务锁、进度、可取消下载、完成时间 |
| 研究查询 | `db query` 小结果；`db export` 大结果 | SQL 只读、限制行数、大结果落盘 |
| 修复或迁移 | `data migrate` / `data repair` | 先展示 plan、影响与备份提示，再确认执行 |
| 清理/删除 | `data clean`；`data remove --plan` | 删除前必须展示目录、大小和确认按钮 |

禁止把 `data init`、`data sync`、迁移、修复或删除藏在 AI 自动流程中。它们会改变本地状态，必须让用户在 UI 中明确点击确认。执行任何新命令前，用 `hithink-finance schema <capability-id> --format json` 获取本机 CLI 当前版本的参数契约。

## 6. “策略”功能应该怎样做

此处的策略应定义为可复现的**研究规则与回测数据准备**，而不是荐股、交易信号或自动下单。

推荐分三层实现：

1. **研究配方**：用户保存标的池、时间窗口、指标定义和 SQL；每次运行都记录版本、输入、输出路径和行数。
2. **数据集构建**：先运行 `data status`、`data validate`；用 `market panel --output <file>` 或 `db export` 生成 Parquet/CSV，不把全市场大表塞进 UI 或对话上下文。
3. **描述性结果**：展示样本覆盖、缺失率、分布、相关性和敏感性检查，并保留 SQL/文件路径；明确它们不构成预测、收益保证或投资建议。

策略页面应默认只读，采用“预览 → 生成数据集 → 结果复核”的三步流程。未来若要接入回测引擎，必须额外显示费用、滑点、停牌、复权、幸存者偏差和样本外检验假设，并禁止连接任何券商交易接口。

## 7. 推荐的产品迭代顺序

1. **P0：凭据同步与状态**（本次已实现同步按钮）。增加 CLI 已安装 / 已认证 / Skills 已同步的状态提示。
2. **P1：AI 研究任务模板**。提供“公司基本面”“指数成分与结构”“基金资料与收益”“数据质量核验”四个固定模板，避免空泛提示词。
3. **P2：本地数据库管理页**。增加状态、初始化、同步、验证、导出；所有写操作均展示影响并二次确认。
4. **P3：可复现研究配方**。保存只读 SQL、参数、输出目录、数据版本和生成时间；支持再次运行与导出。
5. **P4：任务记录**。记录 Claude 会话启动时间、输入简报路径与用户主动保存的报告路径；不记录 Key、完整终端历史或隐私数据。

## 8. 日常检查清单

```bash
hithink-finance version --format json
hithink-finance auth status --format json
hithink-finance skills status --format json
hithink-finance data status --format json
hithink-finance data validate --format json
```

只在需要时同步数据，所有大结果保存到文件而非终端或聊天窗口。研究输出应保留数据来源、取数时间、查询参数、文件路径与已知局限。
