import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Settings } from '../shared/types'
import { log } from './log'

function defaultSettings(): Settings {
  return {
    workspaceRoot: path.join(app.getPath('userData'), 'Projects'),
    opencodeBin: '',
    theme: 'dark',
    media: {
      ffmpegPath: ''
    },
    mcp: {
      servers: {}
    },
    llm: {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseURL: 'https://api.deepseek.com/v1',
          apiKey: '',
          models: [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
          ]
        }
      ],
      activeModel: 'deepseek/deepseek-chat'
    },
    image: {
      openai: {
        enabled: true,
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-image-1',
        size: '1024x1024'
      },
      comfyui: {
        enabled: false,
        url: 'http://127.0.0.1:8188',
        workflowPath: ''
      }
    },
    video: {
      defaultProvider: '',
      kling: {
        enabled: false,
        accessKey: '',
        secretKey: '',
        model: 'kling-v1',
        baseURL: 'https://api.klingai.com'
      },
      minimax: {
        enabled: false,
        apiKey: '',
        model: 'T2V-01',
        baseURL: 'https://api.minimaxi.com'
      },
      fal: {
        enabled: false,
        apiKey: '',
        model: 'fal-ai/kling-video/v1/standard/text-to-video'
      },
      custom: {
        enabled: false,
        name: '视频模型（任务式 API）',
        apiKey: '',
        model: '',
        submitUrl: '',
        queryUrl: '',
        taskIdPath: 'data.task_id',
        statusPath: 'data.task_status',
        successValue: 'succeed',
        failValue: 'failed',
        videoUrlPath: 'data.task_result.videos[0].url'
      }
    },
    audio: {
      tts: {
        enabled: false,
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'tts-1',
        voice: 'alloy'
      },
      music: {
        enabled: false,
        model: 'CassetteAI/music-generator',
        apiKey: ''
      }
    },
    vision: {
      enabled: false,
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o'
    }
  }
}

let cached: Settings | null = null

export function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  if (cached) return cached
  const file = settingsFile()
  let s: Settings = defaultSettings()
  let rawText: string | null = null
  try {
    rawText = fs.readFileSync(file, 'utf-8')
  } catch {
    rawText = null // first run — no file at all
  }
  if (rawText !== null) {
    try {
      s = deepMerge(s, JSON.parse(rawText)) as Settings
    } catch (e) {
      // torn/hand-broken settings.json: keep the evidence for recovery, run on defaults
      const backup = settingsFile().replace(/\.json$/, `.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      try {
        fs.writeFileSync(backup, rawText, 'utf-8')
        log('error', 'settings', `settings.json unparseable (${String((e as Error).message || e)}) — saved to ${backup}, using defaults`)
      } catch {
        log('error', 'settings', 'settings.json unparseable AND backup failed — using defaults')
      }
    }
  }
  cached = s
  return s
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const next = deepMerge(current, patch) as Settings
  // mcp.servers 是整表替换语义（删除服务器必须生效），不走 deepMerge 合并
  if (patch.mcp) next.mcp = patch.mcp
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // tmp+rename: settings holds every provider key — a torn write must be impossible
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
  cached = next
  return next
}

export function settingsPath(): string {
  return settingsFile()
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v)
  }
  return out as T
}
