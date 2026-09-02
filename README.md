# Entropy Design

开源 AI 创作画布工作台，**以视频生成为核心：agent 编排图片 / 语音 / 大模型协同产出视频，全部走你自己的外部 API**。

`Electron 38 · React 19 · TypeScript · 零依赖 MCP · MIT`

## 视频优先编排（五步法）

agent 收到视频任务后**不会立刻生成**，而是：

1. **澄清** — 一次性问齐：内容 / 时长 / 比例 / 风格 / **首尾帧**（用户提供 or agent 生成样例）/ 是否配音
2. **立计划** — 成片 / 谨慎型需求先 `plan_create` 立执行计划，概述后等确认再动手
3. **风格样例** — 驱动**图片模型**出 1-2 张首帧候选 + **语音模型**出配音样例，然后停下等确认
4. **定稿** — 选中的样例作为首帧（ref_image）、可选尾帧（tail_image），生成正式旁白
5. **生成** — 最后才调用视频模型（图生视频，1-10 分钟），交付成片

多镜头成片走 storyboard 技能：分镜表 → 逐镜精简样例循环（出该镜首帧 → 确认 → 生成该镜）。即：**LLM 编排，图片模型定风格，语音模型定声音，视频模型只做最贵的那一步**。

## 功能特性

- **React Flow 无限画布**：图文音视频节点 + 溯源边（`source_node_id` 自动连线）、分组、Shift 拖拽框选、拖拽导入
- **工作台首页**：顶部命令条一句话开工、跨会话**任务队列**（1-10 分钟的视频生成可随时回首页看进度与结果）、最近项目
- **节点检视器（快捷键 `I`）**：选中画布节点即见 provider / 模型 / prompt / 产物 / 溯源链——BYO-API 的透明度就摆在这
- **交付计划 Deliverable Plan**：多镜头成片先立计划，画布镜像「执行计划」节点 + 聊天进度卡实时同步，CAS 状态机推进；聊天面板可折叠为轨道，计划进度以状态点常驻
- **提问卡片 ask_user**：agent 结构化提问（一次问全、推荐项置顶、授权词免问），UI 卡片点选回复
- **自动 / 询问双模式**：自动档按分诊纪律直发；询问档所有落盘工具先确认（消息头 `[模式: 询问]` 生效）
- **技能库 Skills**：内置 6 个工作流技能（视频拆解复刻、品牌广告、分镜故事板等）+ 用户自定义技能文件夹，同名覆盖内置
- **Workflow 剧本**：多步成片的官方剧本（品牌 TVC、音乐 MV 分镜）带 ⛳ 检查点接管编排；**项目记忆卡** `remember`/`recall` 沉淀跨会话的品牌规范与风格决策
- **画布结构化**：表格节点（分镜表/镜头清单直接渲染成网格）+ 文本节点增量编辑（小改不重写入画）
- **知识库**：集成层经验卡（任务生命周期、provider 参数边界），生成前按需检索命中即遵循；卡片格式见 `docs/knowledge-cards.md`，可放 `userData` 扩展
- **契约注入**：6 份 contracts（核心规则 / 重试止损 / 交付计划 / 参考图 / provider 参数 / 品牌防线）启动时拼接进 agent 提示词
- **多 provider 媒体生成**：视频（可灵 / MiniMax 海螺 / fal.ai / 自定义任务式）、图像（OpenAI 兼容 / 本地 ComfyUI）、语音（OpenAI 兼容 TTS）、音乐（fal.ai）
- **图生图 / 参考图工作流**：`ref_node_ids` 直接引用画布图像节点（自动溯源），三通道（OpenAI 兼容 edits / DashScope qwen-image-edit / ComfyUI img2img）按已启用 provider 自动路由
- **媒体理解 media_analyse**：任意 OpenAI 兼容视觉模型「看懂」图 / 视频（参考图风格提取、成片质检、回答画面内容），视频经 ffmpeg 抽帧
- **ffmpeg 后期线**：probe / 拼接 / 裁剪 / 字幕烧录 / 抽音轨 / 关键帧拼贴页（media_montage）
- **外部 MCP 扩展**：设置里挂你自己的 stdio / http MCP 服务器，自动注入 agent

## 架构

```
┌────────────────────── Electron 桌面应用 ──────────────────────┐
│  Renderer (React 19 + React Flow 画布 + 聊天面板)             │
│      ▲ WebSocket / REST                                      │
│  Main Process (src/main)                                     │
│   ├─ index.ts     Electron 入口（窗口 / 旧版数据迁移）          │
│   ├─ server.ts    REST + WS 服务 (:8765，端口动态分配)        │
│   ├─ agent.ts     生成 opencode.json + 启动 opencode serve   │
│   ├─ projects.ts  项目与画布持久化 (.entropy/canvas.json)     │
│   ├─ questions.ts ask_user 待答队列（超时 / 取消）              │
│   └─ settings.ts  设置存储 (%APPDATA%/entropy-design)         │
└───────────────────────────────────────────────────────────────┘
        │ 生成 opencode.json（provider + MCP 注册）+ 拼接 contracts
        ▼
   opencode serve（外部 LLM API：DeepSeek/Qwen/Claude/…）
        │ stdio MCP（环境变量 ED_PROJECT_DIR 等注入）
        ▼
   mcp/server.mjs（entropy_* 工具：canvas / plan / generate / media / ask_user）
        │ fetch（你配置的 key）
        ▼
   可灵 / 海螺 / fal / 自定义任务式 API · OpenAI 兼容图像 · ComfyUI · TTS
```

数据回流：MCP 工具落盘写 `.entropy/canvas.json` / `plan.json` → main 进程 fs.watch（150ms 防抖）→ WS `canvas-changed` / `plan-changed` → 画布实时更新。ask_user 反向链路：MCP 长 `POST /api/agent/question` → main 待答队列 → 渲染层问题卡片 → `/api/agent/question/answer` 唤醒。

## 快速开始

前提：Node.js 20+、npm、[opencode](https://opencode.ai) 二进制（自动按 设置 → 常规 → opencode 可执行文件路径 → `%USERPROFILE%\.opencode\bin` → `%LOCALAPPDATA%\Programs\opencode` → PATH 顺序探测）；可选 ffmpeg 与 ComfyUI。

```bash
npm install
npm run dev        # 启动桌面应用（开发模式）
npm run build      # 产物在 out/
```

1. 点左下角 **设置**：
   - **LLM 模型**：填任意 OpenAI 兼容端点（baseURL + apiKey + models），例如
     - DeepSeek: `https://api.deepseek.com/v1`
     - Qwen: `https://dashscope.aliyuncs.com/compatible-mode/v1`
     - 本地 Ollama: `http://127.0.0.1:11434/v1`
   - 把「当前使用的模型」改成 `providerId/modelId`
   - **视频模型 / 图像生成 / 语音 · 音乐**：按需启用 provider（详见下文配置指南）
2. 新建画布 → 在右侧和 agent 对话，生成的素材自动出现在画布上。

LLM provider 新增 / 修改后 agent 自动重启生效；仅切换当前模型无需重启。

## 配置指南

### 视频生成（设置 → 视频模型）

| Provider | 鉴权 | 说明 |
|---|---|---|
| 可灵 Kling | Access Key + Secret Key | 应用内自动签发 HS256 JWT；`kling-v1` / `kling-v1-master`；文生 + 图生（支持首尾帧） |
| MiniMax 海螺 | API Key | `T2V-01` 等文生模型，`I2V-01` 等图生模型；Hailuo-2.3 系列共享 id（如 `MiniMax-Hailuo-2.3`）文生 / 图生两用 |
| fal.ai | API Key | 任意 `queue.fal.run` 模型路径 |
| 自定义 | URL + Key | 任务式 API（提交 + 轮询 JSON 路径可配）；`dashscope.aliyuncs.com` 域名自动启用 DashScope 异步方言 |

生成耗时 1-10 分钟，工具自动轮询任务状态、下载 mp4 到项目 `generated/` 并放上画布。

### 语音 · 音乐（设置 → 语音 · 音乐）

- **TTS**：任意 OpenAI 兼容 `/audio/speech` 端点（URL + Key），模型如 `tts-1`，音色如 `alloy`
- **音乐**：fal.ai 队列 API，默认 `CassetteAI/music-generator`，Key 留空自动复用视频区的 fal.ai Key

### 图像生成（设置 → 图像生成）

- **OpenAI 兼容**：文生图走 `/images/generations`（gpt-image-1 等）；传参考图时走 `/images/edits`（图生图）
- **DashScope 原生**：baseURL 含 `dashscope.aliyuncs.com` 时自动改走多模态同步接口（qwen-image 等，30-120s；带参考图时自动切 `qwen-image-edit` 图生图）
- **ComfyUI**：本机 HTTP API；受控集成（工作流发现 → 参数检查 → 确认后执行，1-10 次随机种子）；内置 `builtin-txt2img` 与 `builtin-img2img`（参考图上传注入 LoadImage，denoise 0.65）

### 媒体理解（设置 → 媒体理解）

- 供 `media_analyse` 使用：任意 OpenAI 兼容 `/chat/completions` 视觉端点（baseURL + Key + 支持图像输入的模型，如 `gpt-4o` / `qwen-vl-max` / `gemini-2.5-flash`）
- 让 agent「看懂」画布上的图与视频：提取参考图风格、质检生成结果、回答画面内容问题；视频经 ffmpeg 均匀抽帧后多帧送检

## Agent 工具（MCP，共 37 个）

MCP 服务器名为 `entropy`，所有工具带 `entropy_` 前缀注入 agent。CI 里 `npm run check:docs` 对真实注册表校验本清单与 `agents/entropy.md` 的工具名一一对应。

- 画布（10）：`canvas_nodes_list` / `canvas_node_read` / `canvas_node_add_text` / `canvas_node_add_file` / `canvas_node_add_table`（分镜表/镜头清单等结构化网格 → 表格节点渲染）/ `canvas_text_patch`（文本节点增量编辑：全量替换、批次原子、失败不留半成品）/ `canvas_selection_read`（用户当前选中）/ `canvas_outputs_group`（本轮产物一次编组）/ `canvas_nodes_group` / `canvas_node_ungroup`
- 执行计划（4）：`plan_create`（立计划 + 画布镜像「执行计划」节点）/ `plan_stage_patch`（追加阶段）/ `plan_stage_status`（进度与 next_action）/ `plan_stage_state_update`（CAS 状态机：waiting → doing → done / blocked / cancelled，产出文件名写入阶段 outputs）
- 生成（4）：`image_generate`（OpenAI 兼容 / ComfyUI，`ref_images` / `ref_node_ids` 图生图，`series_count` 身份锁定系列图：基准图 + i2i 变体）、`video_generate`（可灵 / 海螺 / fal / 自定义任务式）、`speech_generate`（OpenAI 兼容 TTS）、`music_generate`（fal.ai）
- 媒体理解（1）：`media_analyse`（把画布图 / 视频交给视觉模型生成描述，支持 `question` 定向提问与视频抽帧；设置 → 媒体理解）
- 后期（6，ffmpeg）：`media_probe`（ffprobe 元数据）/ `videos_merge`（拼接，编解码不一致自动转码）/ `trim_video`（精确裁剪）/ `subtitle_burn`（字幕烧录 SRT/ASS）/ `extract_audio`（抽音轨）/ `media_montage`（高密度关键帧拼贴页，逐镜拆解与整片速览）——需要本机 ffmpeg（PATH 或 设置 → 常规 → FFmpeg 路径，或随包内置）
- ComfyUI 受控集成（3）：`comfy_list_workflows` / `comfy_get_workflow` / `comfy_run_workflow`（内置 `builtin-img2img` 图生图模板）
- 知识库（1）：`knowledge_search`（失败案例卡 + 厂商怪癖卡检索，命中即按卡内判定执行）
- 交互（1）：`ask_user`（结构化提问卡片）
- 记忆（2）：`remember`（把跨会话成立的品牌规范 / 风格决策写成原子卡，存项目 `.entropy/memory/`）/ `recall`（新会话决策前检索，命中即遵循）
- 剧本（2）：`list_workflows` / `load_workflow`（官方剧本：品牌 TVC、音乐 MV 分镜；剧本管步骤与检查点，技能管单段工作流）
- 能力查询（1）：`list_generation_providers`；技能（2）：`list_skills` / `load_skill`

## 编排纪律

- **三分类分诊**：咨询直接答；简单任务（单图 / 单镜 / 单段音频）合理默认直发不追问；复杂任务（成片 / 系列）走**执行计划**或技能工作流
- **澄清纪律**：要问就 `ask_user` 一次问全、推荐第一；「随便 / 都行 / 你看着办」等授权词全程免确认；卡片回复后立即继续
- **执行计划**：阶段受阻置 blocked 并向用户说明，禁止静默跳过；重立计划必须 `replace:true` 并说明改动
- **契约注入**：`agents/contracts/`（core-rules / retry-discipline / planning / reference-images / provider-params / brand-guard）启动时拼接
- **画布纪律**：一切产物上画布；「这张图 / 选中的图」先读选区；基于已有素材生成必传 `source_node_id` 建立溯源
- **知识库**：`knowledge/pipeline/`（视频任务生命周期等集成层实测卡），生成前按需检索；卡片格式与扩展方式见 `docs/knowledge-cards.md`
- **Self-Review**：一轮产出 ≥2 个节点 → 自动编组一次；比例直通（参考图 3:4 → 视频 3:4，禁止就近取整）

## 技能库（Skills）

`skills/` 目录下的 markdown 工作流（内置），加上你的用户技能文件夹（`%APPDATA%/entropy-design/skills/`，UI 里「新建技能」的归档地，同名覆盖内置）。每个技能既可以是单个 `name.md`，也可以是一个文件夹 `name/SKILL.md`（可附带 `references/` 资源，load_skill 会提示 agent 按需读取）：

| 技能 | 用途 |
|---|---|
| `brand-poster` | 品牌主视觉 / 海报（风格锁定 → 方案节点 → 主视觉 → 变体延展） |
| `storyboard` | 分镜故事板（叙事拆解 → 分镜表 → 统一风格逐镜生成） |
| `ui-design` | UI 界面灵感（风格矩阵 2×2 → 深浅色对照） |
| `video-promo` | 短视频 / 宣传片（文生视频 / 图生视频镜头设计） |
| `video-replica` | 参考视频复刻（probe+analyse+montage 取证 → 拆解报告 → 逐组复刻计划） |
| `brand-film` | ≤15s 品牌官方/产品主角短片（资产核验 → 三路线 → 风格母题 → 节拍表 → 定版） |

自定义：UI「新建技能」或直接在 `skills/` 下新增 markdown（frontmatter 含 name/title/description/triggers）。知识卡同理：`knowledge/failures/`、`knowledge/vendors/` 下新增 markdown（frontmatter 含 name/title/keywords）即可被 `knowledge_search` 检索。

## 项目数据格式

每个项目 = 一个文件夹：

```
<项目>/
  AGENTS.md              # 项目说明（agent 自动读取）
  opencode.json          # 由应用生成（provider + MCP 配置，.entropy/ 下有副本）
  .opencode/agent/entropy.md   # agent 提示词（contracts 已拼接，可自行微调）
  .entropy/
    canvas.json          # 画布节点/边（positions 为绝对坐标，分组时 UI 换算父相对）
    plan.json            # 执行计划（含 mirror_node_id 反查画布镜像节点）
    selection.json       # 用户当前框选的节点 id
    opencode.json
    project.json         # 项目元数据（id / 名称 / 分组 / 置顶）
  assets/  generated/    # 导入的与生成的素材
```

## 开发指南

```bash
npm run dev            # 开发模式启动桌面应用
npm run build          # electron-vite 三段构建（main / preload / renderer）
npm run typecheck:node # 主进程 TS 严格检查
npm run typecheck:web  # 渲染层 TS 严格检查
npm run mock           # 本地 Mock LLM（OpenAI 兼容）
npm run mock:video     # 本地 Mock 视频任务 API（测试自定义 provider）
npm run smoke:mcp      # MCP 端到端冒烟（画布 / 计划 / 选区 / 编组 / 知识 / Comfy）
npm run smoke:ask      # ask_user 桥路冒烟（MCP ↔ main ↔ 渲染层 stub）
npm run smoke:skills   # 技能 CRUD / 目录布局 / 同名覆盖冒烟
npm run smoke:media    # ffmpeg 媒体线冒烟（无 ffmpeg 自动跳过）
```

- **MCP 服务器零依赖**（`mcp/server.mjs`，纯 Node stdio JSON-RPC）：加新工具 = 在 tools 对象里加一个 `{ description, inputSchema, run }`，`tools/list` 自动暴露
- **加一个视频 provider**：`mcp/video-providers.mjs` 实现异步签名 + 轮询 + 下载，`server.mjs` 的 `video_generate` 按设置路由，`SettingsDialog` 补配置表单
- **契约**：`agents/contracts/*.md` frontmatter `agents: [entropy]` 决定拼接进哪些 agent；改完需重启 agent（或改 MCP 设置触发自动重启）
- **端口**：REST/WS 动态分配，MCP 通过 `ED_SERVER_URL` 环境变量获得；MCP 自身通过 `ED_PROJECT_DIR` / `ED_SETTINGS_FILE` / `ED_SKILLS_DIR` / `ED_USER_SKILLS_DIR` / `ED_KNOWLEDGE_DIR` 定位资源
- **发布**：打版本标签并推送（`git tag v0.2.0 && git push origin v0.2.0`）即触发 `.github/workflows/release.yml`：在 GitHub 托管 runner 上跑全套校验 → 拉取随附 ffmpeg → `npm run dist` 构建 NSIS 安装包 → 自动创建对应 Release 并上传安装包 / blockmap / `latest.yml`（应用内自动更新读取该 feed）。安装包不进仓库，二进制与源码永远同源

## Roadmap

- [x] opencode 集成（外部 LLM API）+ 画布 / 聊天 / 项目管理
- [x] 视频生成 provider：可灵（JWT 鉴权）/ MiniMax 海螺（含 Hailuo-2.3 共享 id）/ fal.ai / 自定义任务式 API，文生 + 图生
- [x] 图像生成（OpenAI 兼容 / ComfyUI 受控集成）自动上画布
- [x] 首页 Hero 输入框、技能芯片、灵感卡片、项目库、深浅色主题
- [x] Composer：附件 / 模型 / Skill 工具行 + 自动/询问模式选择器 + 运行中停止键
- [x] 项目库管理：重命名 / 删除（回收站）/ 分组 / 置顶 / 批量删除
- [x] 技能库 + 用户技能文件夹（UI 新建 / 编辑 / 删除 / 复制内置）
- [x] 执行计划系统 + 画布镜像 + 聊天进度卡
- [x] ffmpeg 后期线 + 知识库 + ask_user 提问卡片
- [x] 外部 MCP 服务器注入（stdio / http，保存自动重启 agent）
- [x] 参考图 / 图生图工作流强化（`ref_node_ids` 自动溯源 + OpenAI edits / DashScope qwen-image-edit / ComfyUI img2img 三通道）
- [x] 媒体理解 `media_analyse`（视觉模型看图 / 看视频抽帧，设置 → 媒体理解）
- [x] 知识库体系（集成层实测卡 + provider 参数边界，格式见 `docs/knowledge-cards.md`，支持 userData 扩展）
- [x] electron-builder 打包发布（NSIS 安装包，mcp/skills/knowledge/agents/ffmpeg 走 extraResources）
- [x] 身份锁定系列生成（`series_count`：基准图 + i2i 变体锚定，三视图 / 角色一致性任务）
- [x] `media_montage` 关键帧拼贴页（逐镜拆解 / 整片速览）
- [x] Self-Review 质检闭环（entropy.md 内嵌规则：可验证约束任务交付前 media_analyse 定向核验）
- [x] 工作流技能：video-replica（取证 → 拆解报告 → 复刻计划）/ brand-film（≤15s 品牌短片）
- [x] GitHub Actions CI（typecheck ×2 + 冒烟套件 + 单测 + 文档对齐检查，ubuntu/windows 矩阵）
- [x] UI 独立化改造：48px icon rail（侧栏）、工作台首页 + MCP→main→WS 任务队列、聊天 dock 折叠、节点检视器、近黑中性主题（画布区配色独立固定）
- [x] 可靠性（P0）：main 持久日志 + renderer 错误转发、任务历史落盘与重启中断对账、本地 API/WS 一次性 token 门禁
- [x] 工程（P1）：node:test 单测（plan 状态机 / provider 助手 / ffmpeg 解析 / 画布工具）、zustand 分域（tasks/projects/settings/chat）
- [x] 分发（P2）：mac/linux 构建目标、GitHub Releases 自动更新（静默检查 + 确认下载）、settings 损坏自动备份、ffmpeg 分平台 staging
- [x] Workflow 剧本：`workflows/` 目录 + 官方剧本（品牌 TVC / 音乐 MV），剧本优先于即兴编排
- [x] 画布表格节点 + 文本增量编辑；项目记忆卡 `remember`/`recall`
- [ ] 多 Agent 拆分（评估结论：当前无触发场景，维持单 agent + 分诊纪律）
- [ ] i18n（框架与英文语料）、Windows 代码签名证书、P1 剩余切片（SettingsDialog 分 tab 子组件、App.tsx 继续瘦身）

## Credits

本项目全部代码、界面与图标均为独立原创实现；图标取自 lucide 风格 ISC 授权图标族并辅以原创绘制。生成能力依赖的各第三方 API（可灵 / MiniMax 海螺 / fal.ai / OpenAI 兼容端点等）版权归其厂商所有，本项目仅做客户端集成。各组件来源与发布前原创性自检详见 [docs/PROVENANCE.md](docs/PROVENANCE.md)。

## License

MIT
