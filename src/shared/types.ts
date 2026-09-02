// Shared types between main process and renderer

export type CanvasNodeType = 'image' | 'video' | 'audio' | 'file' | 'text' | 'table' | 'group'

export interface CanvasNodeData {
  name: string
  path?: string
  text?: string
  prompt?: string
  provider?: string
  model?: string
  /** structured grid for table nodes (storyboard 分镜表 etc.); cells are markdown strings */
  table?: { columns: string[]; rows: string[][] }
  [key: string]: unknown
}

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  positions: { main: { x: number; y: number } }
  size?: { width: number; height: number }
  /** group containment; child positions stay ABSOLUTE in JSON (renderer converts) */
  parentId?: string
  data: CanvasNodeData
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
}

export interface CanvasDocument {
  version: number
  mode: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface ProjectInfo {
  id: string
  name: string
  path: string
  createdAt: string
  group?: string | null
  pinned?: boolean
}

export interface LLMProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: { id: string; name: string }[]
}

export interface ImageProviderOpenAI {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  size: string
}

export interface ImageProviderComfyUI {
  enabled: boolean
  url: string
  workflowPath: string
}

export interface VideoProviderKling {
  enabled: boolean
  accessKey: string
  secretKey: string
  model: string
  baseURL: string
}

export interface VideoProviderMiniMax {
  enabled: boolean
  apiKey: string
  model: string
  baseURL: string
}

export interface VideoProviderFal {
  enabled: boolean
  apiKey: string
  model: string
}

export interface VideoProviderCustom {
  enabled: boolean
  name: string
  apiKey: string
  model: string
  submitUrl: string
  queryUrl: string
  taskIdPath: string
  statusPath: string
  successValue: string
  failValue: string
  videoUrlPath: string
}

export interface AudioProviderTTS {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  voice: string
}

export interface AudioProviderMusic {
  enabled: boolean
  model: string
  apiKey: string // falls back to video.fal.apiKey when empty
}

/** 媒体理解（media_analyse）：任意 OpenAI 兼容 /chat/completions 视觉端点 */
export interface VisionProvider {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
}

export interface MediaToolsConfig {
  /** Optional path to ffmpeg.exe or its containing directory; empty = PATH lookup */
  ffmpegPath: string
}

/** 外部 MCP 服务器（stdio 子进程 或 HTTP 端点），注入生成的 opencode.json。 */
export interface McpServerConfig {
  type: 'local' | 'remote'
  enabled: boolean
  /** local(stdio)：可执行命令（如 npx / node / python），args 为参数数组 */
  command?: string
  args?: string[]
  /** remote(http/sse)：端点 URL */
  url?: string
  /** remote 可选请求头 */
  headers?: Record<string, string>
}

export interface Settings {
  workspaceRoot: string
  opencodeBin: string
  theme?: 'system' | 'light' | 'dark'
  media: MediaToolsConfig
  /** 用户自定义外部 MCP 服务器（名字 → 配置）；保存后 agent 自动重启生效 */
  mcp?: {
    servers: Record<string, McpServerConfig>
  }
  llm: {
    providers: LLMProviderConfig[]
    activeModel: string // "providerId/modelId"
  }
  image: {
    openai: ImageProviderOpenAI
    comfyui: ImageProviderComfyUI
  }
  video: {
    /** preferred provider when the agent doesn't pass one ('' = first enabled) */
    defaultProvider: string
    kling: VideoProviderKling
    minimax: VideoProviderMiniMax
    fal: VideoProviderFal
    custom: VideoProviderCustom
  }
  audio: {
    tts: AudioProviderTTS
    music: AudioProviderMusic
  }
  /** 媒体理解（视觉模型，供 media_analyse 使用） */
  vision: VisionProvider
}

export interface ChatMessagePart {
  id?: string
  type: 'text' | 'tool' | 'reasoning'
  text?: string
  tool?: string
  state?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ChatMessagePart[]
  error?: string
}

// ---------- deliverable plan (.entropy/plan.json, written by MCP plan tools) ----------

export type PlanStageStatus = 'waiting' | 'doing' | 'done' | 'blocked' | 'cancelled'

export interface PlanStage {
  id: string
  order: number
  name: string
  goal: string
  status: PlanStageStatus
  waiting_reason: string | null
  note: string
  outputs: string[]
}

export interface ExecutionPlan {
  plan_id: string
  goal: string
  created_at: string
  updated_at?: string
  mirror_node_id?: string | null
  stages: PlanStage[]
}

/** Live generation task mirrored from the MCP server for the home task queue. */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'interrupted'
export interface AgentTask {
  taskId: string
  kind: 'video' | 'image' | 'audio' | 'music'
  status: TaskStatus
  projectDir: string
  provider?: string
  model?: string
  prompt?: string
  file?: string
  error?: string
  startedAt: number
  endedAt?: number
  seconds?: number
}
