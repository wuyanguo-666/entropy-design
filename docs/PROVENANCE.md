# PROVENANCE — 原创性与第三方素材来源声明

> 本文档说明 Entropy Design 各组成部分的来源与创作方式，供审查者、贡献者与潜在的权利主张方核实。
> Summary: this project's code, UI and agent/prompt assets are original works; all third-party
> material used is either a public API (documented below, client-side integration only) or an
> open-licensed asset shipped with its license text.

## 1. 总声明

Entropy Design 的全部源代码（`src/`、`mcp/`、`tools/`、`tests/`）、界面、图标与提示词资产
（`agents/`、`skills/`、`workflows/`、`knowledge/`、`docs/`）均为本项目独立创作的原创表达。
本产品所属的「AI 生成式创意画布」这一**功能品类与设计思想**（画布节点 + agent 编排 + 多厂商
生成 API）属于行业通用概念；本声明不主张任何思想、流程或方法层面的独占，也无意从任何既有
产品的表达中复制内容。

## 2. 组件来源清单

| 组件 | 来源 | 授权 |
|---|---|---|
| Electron / React / @xyflow/react / electron-updater 等运行与构建依赖 | npm 公共注册表（见 `package-lock.json`，全部为 registry.npmjs.org 公开包） | 各自开源协议 |
| `@ai-sdk/openai-compatible` | npm 公共注册表 | Apache-2.0 |
| 中文字体 `src/renderer/src/assets/fonts/NotoSansCJKsc-Regular.otf` | Google Noto CJK 官方发布 | SIL OFL 1.1（协议全文随附于同目录 `LICENSE-NOTO-SANS-CJK.txt`） |
| 界面图标 | 遵循 lucide 风格的 ISC 授权图标族并辅以原创绘制（见 README「版权与素材」节） | ISC / 原创 |
| 应用图标与 Logo | 本项目原创绘制 | MIT（随仓库） |
| 生成能力后端（可灵 / MiniMax 海螺 / fal.ai / OpenAI 兼容端点 / DashScope / ComfyUI 等） | 各厂商**公开 API 与官方开发者文档**；本项目仅做客户端集成 | 各厂商服务条款，版权归各厂商 |
| opencode（agent 运行时，用户自行安装的独立外部程序） | https://opencode.ai | MIT；本项目不打包、不复制其代码，仅在运行时以子进程方式调用 |

## 3. 工具面（MCP tools）的创作方式

37 个 MCP 工具的名称与描述均从本项目的功能规格推导：画布节点模型见 `.entropy/canvas.json`
的读写实现（`mcp/server.mjs`、`src/main/projects.ts`），生成通道由各 provider 公开 API 文档
决定（如提交-轮询生命周期记录于 `knowledge/pipeline/video-task-lifecycle.md`）。命名采用
对象前置体系（`canvas_nodes_list`、`plan_stage_patch`、`image_generate` 一类通用词组），
描述文本按实际实现行为独立撰写。

## 4. 发布前的原创性自检（可复现）

开源发布前，仓库全文（代码 + 文本资产）做了一次自动化比对，方法如下，任何人均可复现：

1. **品牌与旧命名痕迹全文扫描**（大小写不敏感，覆盖全部已跟踪文件）：无第三方产品品牌残留；
   文中出现的厂商名（可灵 / 海螺 / OpenAI 等）仅为第 2 节所述的公开 API 集成引用。
2. **逐字连续串检测**：将仓库每个源文件与若干已发布的同类桌面 AI 创意产品的随附提示词资产及
   打包内嵌文本做 25 字符连续窗口比对——**实质性文字连段命中 0**（命中项经人工复核全部为代码
   分隔线等标点序列，如 `// ----------`，不构成文字表达）。
3. **提示词资产整体相似度**：16 篇文本资产（contracts / skills / workflows / knowledge /
   agent 提示词）与上述比对物全量（266 份）逐一计算 token 词汇重叠率与序列相似度，
   **最高 0.31**，处于同领域通用词汇基线区间；无改写、翻译或局部摘抄迹象。
4. **工具名交集**：本项目 37 个工具名与同类已知产品的工具名清单做精确比对，
   **重合 0**；工具描述文本相似度峰值 0.14（噪音级）。

## 5. 版本控制惯例

本仓库以**单条初始提交**开源发布，不携带开发期历史；发布后的全部变更历史公开可查。
单提交初始化为开源项目常见惯例，不含任何其他含义。

## 6. 异议处理

若任何权利方认为本仓库中存在对其受保护表达的具体复制，请开 Issue 指明「具体文件 + 具体段落 +
对应权利方原作」。我们将在核实后及时处置（重写 / 移除 / 更正归属）。本项目的品牌防线契约
（`agents/contracts/brand-guard.md`）也要求由本产品生成的素材不得包含真实商标、名人肖像与
平台水印，欢迎监督。
