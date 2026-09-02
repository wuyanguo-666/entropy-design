import { useState } from 'react'
import type { LLMProviderConfig, McpServerConfig, Settings } from '@shared/types'
import { putSettings, fetchModels, openLogsFolder, checkForUpdates } from '../api'
import Icon from './Icon'

export type SettingsTab = 'video' | 'audio' | 'image' | 'vision' | 'llm' | 'mcp' | 'general'

/** Password input with a user-controlled show/hide toggle (not always masked). */
export function SecretInput({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="secret-wrap">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="secret-eye"
        title={show ? '隐藏 Key' : '显示 Key'}
        onClick={() => setShow((v) => !v)}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
      </button>
    </div>
  )
}

const TABS: { id: SettingsTab; icon: string; label: string }[] = [
  { id: 'video', icon: 'video', label: '视频模型' },
  { id: 'audio', icon: 'mic', label: '语音 · 音乐' },
  { id: 'image', icon: 'image', label: '图像生成' },
  { id: 'vision', icon: 'eye', label: '媒体理解' },
  { id: 'llm', icon: 'bot', label: 'LLM 模型' },
  { id: 'mcp', icon: 'plug', label: 'MCP' },
  { id: 'general', icon: 'sliders', label: '常规' }
]

const ALIYUN_SUBMIT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis'
const ALIYUN_QUERY = 'https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}'

type VideoPreset = 'aliyun' | 'kling' | 'minimax' | 'fal' | 'custom'

/** Which vendor channel is currently active, derived from enabled blocks. */
function videoPresetOf(v?: Settings['video']): VideoPreset {
  if (v?.kling?.enabled) return 'kling'
  if (v?.minimax?.enabled) return 'minimax'
  if (v?.fal?.enabled) return 'fal'
  if (v?.custom?.enabled && (v.custom.submitUrl || '').includes('dashscope.aliyuncs.com')) return 'aliyun'
  return 'custom'
}

interface Props {
  settings: Settings
  onClose: () => void
  onSaved: (s: Settings) => void
  initialTab?: SettingsTab
}

function slugifyId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  )
}

export default function SettingsDialog({ settings, onClose, onSaved, initialTab = 'video' }: Props) {
  const [draft, setDraft] = useState<Settings>(JSON.parse(JSON.stringify(settings)))
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [fetchingIdx, setFetchingIdx] = useState<number | null>(null)
  const [videoPreset, setVideoPreset] = useState<VideoPreset>(() => videoPresetOf(settings.video))
  const [mcpAdding, setMcpAdding] = useState(false)
  const [mcpDraft, setMcpDraft] = useState<{ name: string; type: 'local' | 'remote'; command: string; args: string; url: string }>({
    name: '',
    type: 'local',
    command: '',
    args: '',
    url: ''
  })

  const switchVideoPreset = (id: VideoPreset) => {
    setVideoPreset(id)
    // seed the Aliyun preset URLs once so generation works without touching 高级字段
    if (id === 'aliyun' && !(draft.video?.custom?.submitUrl || '').includes('dashscope.aliyuncs.com')) {
      set({
        video: {
          ...draft.video,
          custom: {
            ...draft.video.custom,
            submitUrl: ALIYUN_SUBMIT,
            queryUrl: ALIYUN_QUERY,
            taskIdPath: 'output.task_id',
            statusPath: 'output.task_status',
            successValue: 'SUCCEEDED',
            failValue: 'FAILED',
            videoUrlPath: 'output.video_url'
          }
        }
      })
    }
  }
  const videoKey = videoPreset === 'aliyun' ? 'custom' : videoPreset
  const videoEnabled =
    videoPreset === 'aliyun'
      ? !!draft.video?.custom?.enabled
      : videoPreset === 'kling'
        ? !!draft.video?.kling?.enabled
        : videoPreset === 'minimax'
          ? !!draft.video?.minimax?.enabled
          : videoPreset === 'fal'
            ? !!draft.video?.fal?.enabled
            : !!draft.video?.custom?.enabled
  const setVideoEnabled = (on: boolean) => {
    if (videoPreset === 'aliyun' || videoPreset === 'custom') {
      set({ video: { ...draft.video, custom: { ...draft.video.custom, enabled: on }, defaultProvider: on ? 'custom' : draft.video?.defaultProvider } })
    } else if (videoPreset === 'kling') {
      set({ video: { ...draft.video, kling: { ...draft.video.kling, enabled: on }, defaultProvider: on ? 'kling' : draft.video?.defaultProvider } })
    } else if (videoPreset === 'minimax') {
      set({ video: { ...draft.video, minimax: { ...draft.video.minimax, enabled: on }, defaultProvider: on ? 'minimax' : draft.video?.defaultProvider } })
    } else {
      set({ video: { ...draft.video, fal: { ...draft.video.fal, enabled: on }, defaultProvider: on ? 'fal' : draft.video?.defaultProvider } })
    }
  }

  const save = async () => {
    try {
      setSaving(true)
      const saved = await putSettings(draft)
      onSaved(saved)
      onClose()
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }))

  const setProvider = (i: number, patch: Partial<LLMProviderConfig>) => {
    setDraft((d) => {
      const providers = (d.llm?.providers || []).map((p, j) => (j === i ? { ...p, ...patch } : p))
      return { ...d, llm: { ...d.llm, providers } }
    })
  }

  const addProvider = () => {
    setDraft((d) => {
      const base = slugifyId('新提供商')
      let id = base
      let n = 2
      const ids = new Set((d.llm?.providers || []).map((p) => p.id))
      while (ids.has(id)) id = `${base}-${n++}`
      const providers = [
        ...(d.llm?.providers || []),
        { id, name: '新提供商', baseURL: '', apiKey: '', models: [] }
      ]
      return { ...d, llm: { ...d.llm, providers } }
    })
  }

  const removeProvider = (i: number) => {
    setDraft((d) => ({ ...d, llm: { ...d.llm, providers: d.llm.providers.filter((_, j) => j !== i) } }))
  }

  const doFetchModels = async (i: number) => {
    const p = draft.llm.providers[i]
    if (!p.baseURL) {
      setErr('请先填写 API 地址')
      return
    }
    setFetchingIdx(i)
    setErr(null)
    try {
      const r = await fetchModels(p.baseURL, p.apiKey)
      if (r.error) {
        setErr(`获取模型列表失败：${r.error}（可手动填写模型 id）`)
      } else {
        setProvider(i, { models: (r.models || []).map((id) => ({ id, name: id })) })
      }
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setFetchingIdx(null)
    }
  }

  const modelOptions: { value: string; label: string }[] = []
  for (const p of draft.llm?.providers || []) {
    for (const m of p.models || []) {
      modelOptions.push({ value: `${p.id}/${m.id}`, label: `${p.name} · ${m.name}` })
    }
  }
  const activeModel = draft.llm?.activeModel || ''
  const activeValid = modelOptions.some((o) => o.value === activeModel)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          设置
          <button onClick={onClose}>关闭</button>
        </header>
        <div className="content settings-content">
          <div className="settings-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="settings-tab-ico"><Icon name={t.icon} size={14} /></span>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'video' && (
            <>
              <div className="grid2">
                <div className="field">
                  <label>厂商预设</label>
                  <select value={videoPreset} onChange={(e) => switchVideoPreset(e.target.value as VideoPreset)}>
                    <option value="aliyun">阿里云百炼（推荐，URL + Key + 模型）</option>
                    <option value="custom">自定义任务式 API（URL + Key + 模型）</option>
                    <option value="kling">可灵官方（双 Key）</option>
                    <option value="minimax">MiniMax 海螺官方</option>
                    <option value="fal">fal.ai</option>
                  </select>
                </div>
              </div>

              <div className="provider-block">
                <div className="provider-head">
                  <strong>
                    {videoPreset === 'aliyun' && '阿里云百炼 · 通义万相视频'}
                    {videoPreset === 'custom' && '自定义任务式 API'}
                    {videoPreset === 'kling' && '可灵 Kling 官方'}
                    {videoPreset === 'minimax' && 'MiniMax 海螺官方'}
                    {videoPreset === 'fal' && 'fal.ai'}
                  </strong>
                  <input type="checkbox" checked={videoEnabled} onChange={(e) => setVideoEnabled(e.target.checked)} />
                </div>

                {videoPreset === 'aliyun' && (
                  <>
                    <div className="hint">
                      通义万相视频（wan 系列）走阿里云异步任务协议，提交 / 查询地址已自动填好，高级字段无需修改。
                    </div>
                    <div className="grid2">
                      <div className="field">
                        <label>API Key</label>
                        <SecretInput
                          value={draft.video?.custom?.apiKey || ''}
                          onChange={(v) => set({ video: { ...draft.video, custom: { ...draft.video.custom, apiKey: v } } })}
                        />
                      </div>
                      <div className="field">
                        <label>模型</label>
                        <input
                          value={draft.video?.custom?.model || ''}
                          placeholder="wan2.7-t2v / wan2.2-t2v-plus"
                          onChange={(e) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, model: e.target.value } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>名称（可选）</label>
                        <input
                          value={draft.video?.custom?.name || ''}
                          placeholder="阿里云百炼"
                          onChange={(e) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, name: e.target.value } } })
                          }
                        />
                      </div>
                    </div>
                    <div className="grid2">
                      <div className="field">
                        <label>提交地址（自动填好）</label>
                        <input value={draft.video?.custom?.submitUrl || ALIYUN_SUBMIT} disabled />
                      </div>
                      <div className="field">
                        <label>查询地址（自动填好）</label>
                        <input value={draft.video?.custom?.queryUrl || ALIYUN_QUERY} disabled />
                      </div>
                    </div>
                  </>
                )}

                {videoPreset === 'custom' && (
                  <>
                    <div className="hint">
                      任意「提交任务 → 轮询状态 → 取回视频」协议的 API（可灵风格、各类中转站）。填 URL + Key + 模型即可；
                      高级字段保持默认即可适配绝大多数服务。
                    </div>
                    <div className="grid2">
                      <div className="field">
                        <label>名称（可选）</label>
                        <input
                          value={draft.video?.custom?.name || ''}
                          placeholder="视频模型"
                          onChange={(e) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, name: e.target.value } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>模型</label>
                        <input
                          value={draft.video?.custom?.model || ''}
                          placeholder="服务商的模型 id"
                          onChange={(e) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, model: e.target.value } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>API Key</label>
                        <SecretInput
                          value={draft.video?.custom?.apiKey || ''}
                          onChange={(v) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, apiKey: v } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>提交地址（POST，JSON）</label>
                        <input
                          placeholder="https://api.example.com/v1/video/submit"
                          value={draft.video?.custom?.submitUrl || ''}
                          onChange={(e) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, submitUrl: e.target.value } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>查询地址（{`{task_id}`} 占位）</label>
                        <input
                          placeholder="https://api.example.com/v1/video/query?task_id={task_id}"
                          value={draft.video?.custom?.queryUrl || ''}
                          onChange={(e) =>
                            set({ video: { ...draft.video, custom: { ...draft.video.custom, queryUrl: e.target.value } } })
                          }
                        />
                      </div>
                    </div>
                    <details className="adv-fields">
                      <summary>高级字段（JSON 响应路径，默认适配可灵风格）</summary>
                      <div className="grid2">
                        <div className="field">
                          <label>任务 ID 字段路径</label>
                          <input
                            value={draft.video?.custom?.taskIdPath || ''}
                            onChange={(e) =>
                              set({ video: { ...draft.video, custom: { ...draft.video.custom, taskIdPath: e.target.value } } })
                            }
                          />
                        </div>
                        <div className="field">
                          <label>状态字段路径</label>
                          <input
                            value={draft.video?.custom?.statusPath || ''}
                            onChange={(e) =>
                              set({ video: { ...draft.video, custom: { ...draft.video.custom, statusPath: e.target.value } } })
                            }
                          />
                        </div>
                        <div className="field">
                          <label>成功值 / 失败值</label>
                          <div className="grid2">
                            <input
                              value={draft.video?.custom?.successValue || ''}
                              onChange={(e) =>
                                set({ video: { ...draft.video, custom: { ...draft.video.custom, successValue: e.target.value } } })
                              }
                            />
                            <input
                              value={draft.video?.custom?.failValue || ''}
                              onChange={(e) =>
                                set({ video: { ...draft.video, custom: { ...draft.video.custom, failValue: e.target.value } } })
                              }
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label>视频地址字段路径</label>
                          <input
                            value={draft.video?.custom?.videoUrlPath || ''}
                            onChange={(e) =>
                              set({ video: { ...draft.video, custom: { ...draft.video.custom, videoUrlPath: e.target.value } } })
                            }
                          />
                        </div>
                      </div>
                    </details>
                  </>
                )}

                {videoPreset === 'kling' && (
                  <>
                    <div className="hint">
                      可灵开放平台使用 AccessKey + SecretKey 自动签发 JWT；国内站默认地址即可，国际站改为
                      https://api-singapore.klingai.com。档位（std/pro）可在对话里指定。
                    </div>
                    <div className="grid2">
                      <div className="field">
                        <label>Access Key</label>
                        <input
                          value={draft.video?.kling?.accessKey || ''}
                          onChange={(e) =>
                            set({ video: { ...draft.video, kling: { ...draft.video.kling, accessKey: e.target.value } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>Secret Key</label>
                        <SecretInput
                          value={draft.video?.kling?.secretKey || ''}
                          onChange={(v) =>
                            set({ video: { ...draft.video, kling: { ...draft.video.kling, secretKey: v } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>模型（kling-v1 / kling-v1-master）</label>
                        <input
                          value={draft.video?.kling?.model || ''}
                          onChange={(e) =>
                            set({ video: { ...draft.video, kling: { ...draft.video.kling, model: e.target.value } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>API 地址</label>
                        <input
                          value={draft.video?.kling?.baseURL || ''}
                          placeholder="https://api.klingai.com"
                          onChange={(e) =>
                            set({ video: { ...draft.video, kling: { ...draft.video.kling, baseURL: e.target.value } } })
                          }
                        />
                      </div>
                    </div>
                  </>
                )}

                {videoPreset === 'minimax' && (
                  <>
                    <div className="hint">
                      海螺官方 API（api.minimaxi.com）。图生视频比例跟随首帧图；首尾帧模式需可灵。
                    </div>
                    <div className="grid2">
                      <div className="field">
                        <label>API Key</label>
                        <SecretInput
                          value={draft.video?.minimax?.apiKey || ''}
                          onChange={(v) =>
                            set({ video: { ...draft.video, minimax: { ...draft.video.minimax, apiKey: v } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>模型（T2V-01 / I2V-01 …）</label>
                        <input
                          value={draft.video?.minimax?.model || ''}
                          onChange={(e) =>
                            set({ video: { ...draft.video, minimax: { ...draft.video.minimax, model: e.target.value } } })
                          }
                        />
                      </div>
                    </div>
                  </>
                )}

                {videoPreset === 'fal' && (
                  <>
                    <div className="hint">
                      fal.ai 队列 API，模型路径决定档位与参数；音乐生成在未单独填 Key 时复用这里的 Key。
                    </div>
                    <div className="grid2">
                      <div className="field">
                        <label>API Key</label>
                        <SecretInput
                          value={draft.video?.fal?.apiKey || ''}
                          onChange={(v) =>
                            set({ video: { ...draft.video, fal: { ...draft.video.fal, apiKey: v } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>模型路径（queue.fal.run/…）</label>
                        <input
                          value={draft.video?.fal?.model || ''}
                          placeholder="fal-ai/kling-video/v1/standard/text-to-video"
                          onChange={(e) =>
                            set({ video: { ...draft.video, fal: { ...draft.video.fal, model: e.target.value } } })
                          }
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {tab === 'audio' && (
            <>
              <div className="provider-block">
                <div className="provider-head">
                  <strong>语音合成 TTS（OpenAI 兼容 /audio/speech）</strong>
                  <input
                    type="checkbox"
                    checked={draft.audio?.tts?.enabled ?? false}
                    onChange={(e) =>
                      set({ audio: { ...draft.audio, tts: { ...draft.audio.tts, enabled: e.target.checked } } })
                    }
                  />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>API 地址（URL）</label>
                    <input
                      value={draft.audio?.tts?.baseURL || ''}
                      onChange={(e) =>
                        set({ audio: { ...draft.audio, tts: { ...draft.audio.tts, baseURL: e.target.value } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>API Key</label>
                    <SecretInput
                      value={draft.audio?.tts?.apiKey || ''}
                      onChange={(v) =>
                        set({ audio: { ...draft.audio, tts: { ...draft.audio.tts, apiKey: v } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>模型（tts-1 / tts-1-hd …）</label>
                    <input
                      value={draft.audio?.tts?.model || ''}
                      onChange={(e) =>
                        set({ audio: { ...draft.audio, tts: { ...draft.audio.tts, model: e.target.value } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>默认音色（alloy / echo …）</label>
                    <input
                      value={draft.audio?.tts?.voice || ''}
                      onChange={(e) =>
                        set({ audio: { ...draft.audio, tts: { ...draft.audio.tts, voice: e.target.value } } })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="provider-block">
                <div className="provider-head">
                  <strong>音乐生成（fal.ai）</strong>
                  <input
                    type="checkbox"
                    checked={draft.audio?.music?.enabled ?? false}
                    onChange={(e) =>
                      set({ audio: { ...draft.audio, music: { ...draft.audio.music, enabled: e.target.checked } } })
                    }
                  />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>默认模型路径（queue.fal.run/…）</label>
                    <input
                      value={draft.audio?.music?.model || ''}
                      onChange={(e) =>
                        set({ audio: { ...draft.audio, music: { ...draft.audio.music, model: e.target.value } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>API Key（留空复用 fal.ai 视频 Key）</label>
                    <SecretInput
                      value={draft.audio?.music?.apiKey || ''}
                      onChange={(v) =>
                        set({ audio: { ...draft.audio, music: { ...draft.audio.music, apiKey: v } } })
                      }
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === 'image' && (
            <>
              <div className="provider-block">
                <div className="provider-head">
                  <strong>OpenAI 兼容图像 API</strong>
                  <input
                    type="checkbox"
                    checked={draft.image?.openai?.enabled ?? false}
                    onChange={(e) =>
                      set({ image: { ...draft.image, openai: { ...draft.image.openai, enabled: e.target.checked } } })
                    }
                  />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>API 地址（baseURL）</label>
                    <input
                      value={draft.image?.openai?.baseURL || ''}
                      onChange={(e) =>
                        set({ image: { ...draft.image, openai: { ...draft.image.openai, baseURL: e.target.value } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>API Key</label>
                    <SecretInput
                      value={draft.image?.openai?.apiKey || ''}
                      onChange={(v) =>
                        set({ image: { ...draft.image, openai: { ...draft.image.openai, apiKey: v } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>模型（如 gpt-image-1）</label>
                    <input
                      value={draft.image?.openai?.model || ''}
                      onChange={(e) =>
                        set({ image: { ...draft.image, openai: { ...draft.image.openai, model: e.target.value } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>默认尺寸</label>
                    <input
                      value={draft.image?.openai?.size || ''}
                      placeholder="1024x1024"
                      onChange={(e) =>
                        set({ image: { ...draft.image, openai: { ...draft.image.openai, size: e.target.value } } })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="provider-block">
                <div className="provider-head">
                  <strong>本地 ComfyUI</strong>
                  <input
                    type="checkbox"
                    checked={draft.image?.comfyui?.enabled ?? false}
                    onChange={(e) =>
                      set({ image: { ...draft.image, comfyui: { ...draft.image.comfyui, enabled: e.target.checked } } })
                    }
                  />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>ComfyUI 地址</label>
                    <input
                      value={draft.image?.comfyui?.url || ''}
                      placeholder="http://127.0.0.1:8188"
                      onChange={(e) =>
                        set({ image: { ...draft.image, comfyui: { ...draft.image.comfyui, url: e.target.value } } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>工作流目录或文件（API 格式 JSON，留空用内置 txt2img）</label>
                    <input
                      value={draft.image?.comfyui?.workflowPath || ''}
                      onChange={(e) =>
                        set({
                          image: { ...draft.image, comfyui: { ...draft.image.comfyui, workflowPath: e.target.value } }
                        })
                      }
                    />
                  </div>
                </div>
                <div className="hint">
                  内置工作流会按节点标题（Prompt / Negative Prompt / Empty Latent Image / KSampler）注入参数；
                  自定义工作流也遵循该约定。启用后 Agent 可通过
                  comfy_list_workflows / comfy_get_workflow / comfy_run_workflow 检查参数并受控运行。
                </div>
              </div>
            </>
          )}

          {tab === 'vision' && (
            <>
              <div className="provider-block">
                <div className="provider-head">
                  <strong>视觉模型（OpenAI 兼容 /chat/completions）</strong>
                  <input
                    type="checkbox"
                    checked={draft.vision?.enabled ?? false}
                    onChange={(e) =>
                      set({ vision: { ...draft.vision, enabled: e.target.checked } })
                    }
                  />
                </div>
                <div className="grid2">
                  <div className="field">
                    <label>API 地址（baseURL）</label>
                    <input
                      value={draft.vision?.baseURL || ''}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) =>
                        set({ vision: { ...draft.vision, baseURL: e.target.value } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>API Key</label>
                    <SecretInput
                      value={draft.vision?.apiKey || ''}
                      onChange={(v) =>
                        set({ vision: { ...draft.vision, apiKey: v } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>模型（需支持图像输入，如 gpt-4o / qwen-vl-max / gemini-2.5-flash）</label>
                    <input
                      value={draft.vision?.model || ''}
                      placeholder="gpt-4o"
                      onChange={(e) =>
                        set({ vision: { ...draft.vision, model: e.target.value } })
                      }
                    />
                  </div>
                </div>
                <div className="hint">
                  供 entropy_media_analyse 使用：让 agent「看懂」画布上的图与视频（参考图风格提取、
                  成片质检、回答画面内容问题）。视频理解需要本机 ffmpeg 抽帧。
                </div>
              </div>
            </>
          )}

          {tab === 'llm' && (
            <>
              <div className="field">
                <label>当前使用的模型</label>
                <select
                  value={activeValid ? activeModel : ''}
                  onChange={(e) => set({ llm: { ...draft.llm, activeModel: e.target.value } })}
                >
                  {!activeValid && <option value="">未选择</option>}
                  {modelOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {(draft.llm?.providers || []).map((p, i) => (
                <div className="provider-block" key={i}>
                  <div className="provider-head">
                    <strong>{p.name || `Provider ${i + 1}`}</strong>
                    <button onClick={() => removeProvider(i)} title="删除此 Provider">
                      删除
                    </button>
                  </div>
                  <div className="grid2">
                    <div className="field">
                      <label>名称</label>
                      <input value={p.name} onChange={(e) => setProvider(i, { name: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>ID（模型引用前缀）</label>
                      <input value={p.id} onChange={(e) => setProvider(i, { id: e.target.value.trim() })} />
                    </div>
                    <div className="field">
                      <label>API 地址（URL，OpenAI 兼容）</label>
                      <input
                        placeholder="https://api.deepseek.com/v1"
                        value={p.baseURL}
                        onChange={(e) => setProvider(i, { baseURL: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>API Key</label>
                      <SecretInput value={p.apiKey} onChange={(v) => setProvider(i, { apiKey: v })} />
                    </div>
                  </div>
                  <div className="field">
                    <label>模型（逗号分隔 id，可点「获取模型列表」自动拉取）</label>
                    <input
                      placeholder="deepseek-chat, deepseek-reasoner"
                      value={(p.models || []).map((m) => m.id).join(', ')}
                      onChange={(e) =>
                        setProvider(i, {
                          models: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .map((id) => ({ id, name: id }))
                        })
                      }
                    />
                  </div>
                  <div>
                    <button onClick={() => void doFetchModels(i)} disabled={fetchingIdx === i}>
                      {fetchingIdx === i ? '获取中…' : '🔄 获取模型列表'}
                    </button>
                  </div>
                </div>
              ))}

              <div>
                <button onClick={addProvider}>＋ 添加 Provider</button>
              </div>
            </>
          )}

          {tab === 'mcp' && (
            <>
              <div className="hint">
                外部 MCP 服务器按名字注入项目的 opencode 配置（标准 mcp.servers 模型：stdio 子进程或 HTTP 端点）：
                <b>stdio</b> = 本机子进程命令，<b>http</b> = 远程端点。保存后 Agent 会自动重启加载新配置；
                内置的 entropy 工具不受影响。
              </div>

              {Object.keys(draft.mcp?.servers || {}).length === 0 && !mcpAdding && (
                <div className="provider-block">
                  <div className="hint">
                    还没有添加 MCP 服务器。例如接一个文件系统 MCP：<code>npx -y @modelcontextprotocol/server-filesystem &lt;目录&gt;</code>。
                  </div>
                </div>
              )}

              {Object.entries(draft.mcp?.servers || {}).map(([name, srv]) => (
                <div className="provider-block" key={name}>
                  <div className="provider-head">
                    <strong>
                      {name}
                      <span className="skill-badge">{srv.type === 'local' ? 'stdio' : 'http'}</span>
                    </strong>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={srv.enabled}
                          onChange={(e) =>
                            set({
                              mcp: {
                                servers: {
                                  ...draft.mcp?.servers,
                                  [name]: { ...srv, enabled: e.target.checked }
                                }
                              }
                            })
                          }
                        />
                        启用
                      </label>
                      <button
                        className="danger"
                        onClick={() => {
                          const next = { ...(draft.mcp?.servers || {}) }
                          delete next[name]
                          set({ mcp: { servers: next } })
                        }}
                      >
                        删除
                      </button>
                    </span>
                  </div>
                  {srv.type === 'local' ? (
                    <div className="grid2">
                      <div className="field">
                        <label>命令</label>
                        <input
                          value={srv.command || ''}
                          placeholder="npx / node / python …"
                          onChange={(e) =>
                            set({ mcp: { servers: { ...draft.mcp?.servers, [name]: { ...srv, command: e.target.value } } } })
                          }
                        />
                      </div>
                      <div className="field">
                        <label>参数（空格分隔）</label>
                        <input
                          value={(srv.args || []).join(' ')}
                          placeholder="-y @modelcontextprotocol/server-filesystem C:\path"
                          onChange={(e) =>
                            set({
                              mcp: {
                                servers: {
                                  ...draft.mcp?.servers,
                                  [name]: { ...srv, args: e.target.value.split(/\s+/).filter(Boolean) }
                                }
                              }
                            })
                          }
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="field">
                      <label>端点 URL</label>
                      <input
                        value={srv.url || ''}
                        placeholder="https://example.com/mcp"
                        onChange={(e) =>
                          set({ mcp: { servers: { ...draft.mcp?.servers, [name]: { ...srv, url: e.target.value } } } })
                        }
                      />
                    </div>
                  )}
                </div>
              ))}

              {mcpAdding ? (
                <div className="provider-block">
                  <div className="grid2">
                    <div className="field">
                      <label>名称（唯一标识，字母/数字/中划线）</label>
                      <input
                        autoFocus
                        value={mcpDraft.name}
                        placeholder="filesystem"
                        onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label>类型</label>
                      <select
                        value={mcpDraft.type}
                        onChange={(e) => setMcpDraft({ ...mcpDraft, type: e.target.value as 'local' | 'remote' })}
                      >
                        <option value="local">stdio（本机命令）</option>
                        <option value="remote">http（远程端点）</option>
                      </select>
                    </div>
                  </div>
                  {mcpDraft.type === 'local' ? (
                    <div className="grid2">
                      <div className="field">
                        <label>命令</label>
                        <input
                          value={mcpDraft.command}
                          placeholder="npx"
                          onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label>参数（空格分隔）</label>
                        <input
                          value={mcpDraft.args}
                          placeholder="-y @modelcontextprotocol/server-filesystem C:\path"
                          onChange={(e) => setMcpDraft({ ...mcpDraft, args: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="field">
                      <label>端点 URL</label>
                      <input
                        value={mcpDraft.url}
                        placeholder="https://example.com/mcp"
                        onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={() => setMcpAdding(false)}>取消</button>
                    <button
                      className="primary"
                      onClick={() => {
                        const name = mcpDraft.name.trim()
                        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
                          setErr('MCP 名称只能用字母/数字/中划线')
                          return
                        }
                        if (draft.mcp?.servers?.[name]) {
                          setErr(`MCP「${name}」已存在`)
                          return
                        }
                        const srv: McpServerConfig = { type: mcpDraft.type, enabled: true }
                        if (mcpDraft.type === 'local') {
                          srv.command = mcpDraft.command.trim()
                          srv.args = mcpDraft.args.split(/\s+/).filter(Boolean)
                          if (!srv.command) {
                            setErr('请填写启动命令')
                            return
                          }
                        } else {
                          srv.url = mcpDraft.url.trim()
                          if (!/^https?:\/\//.test(srv.url)) {
                            setErr('请填写 http(s):// 开头的端点 URL')
                            return
                          }
                        }
                        set({ mcp: { servers: { ...(draft.mcp?.servers || {}), [name]: srv } } })
                        setMcpAdding(false)
                        setMcpDraft({ name: '', type: 'local', command: '', args: '', url: '' })
                        setErr(null)
                      }}
                    >
                      添加
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <button onClick={() => setMcpAdding(true)}>＋ 添加 MCP 服务器</button>
                </div>
              )}
            </>
          )}

          {tab === 'general' && (
            <div className="grid2">
              <div className="field">
                <label>工作区目录（项目保存位置）</label>
                <input
                  value={draft.workspaceRoot}
                  onChange={(e) => set({ workspaceRoot: e.target.value })}
                />
              </div>
              <div className="field">
                <label>opencode 可执行文件路径（留空自动探测）</label>
                <input
                  value={draft.opencodeBin}
                  placeholder="自动：用户目录安装 → PATH"
                  onChange={(e) => set({ opencodeBin: e.target.value })}
                />
              </div>
              <div className="field">
                <label>FFmpeg 路径（留空自动从 PATH 查找；媒体合成/剪辑工具需要）</label>
                <input
                  value={draft.media?.ffmpegPath || ''}
                  placeholder="ffmpeg.exe 完整路径或其所在目录"
                  onChange={(e) => set({ media: { ...draft.media, ffmpegPath: e.target.value } })}
                />
              </div>
              <div className="field">
                <label>主题</label>
                <select
                  value={draft.theme || 'system'}
                  onChange={(e) => set({ theme: e.target.value as 'system' | 'light' | 'dark' })}
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </div>
              <div className="field">
                <label>诊断日志（排障时把日志目录内容发给开发者）</label>
                <button onClick={() => void openLogsFolder().catch(() => {})}>打开日志目录</button>
              </div>
              <UpdateCheckField />
            </div>
          )}

          {err && <div className="err-banner">{err}</div>}
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 常规页：手动检查更新（发现新版时主进程会弹下载确认框，这里只报检查动作的结果）。 */
function UpdateCheckField() {
  const [state, setState] = useState<'idle' | 'checking' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const run = async () => {
    setState('checking')
    setMsg('')
    try {
      const r = await checkForUpdates()
      if (!r.ok) {
        setState('error')
        setMsg(r.error || '检查失败')
      } else {
        setState('idle')
        setMsg('已是最新（或更新对话框已弹出）')
      }
    } catch (e) {
      setState('error')
      setMsg(String((e as Error).message || e))
    }
  }
  return (
    <div className="field">
      <label>更新（GitHub Releases 订阅，静默失败）</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => void run()} disabled={state === 'checking'}>
          {state === 'checking' ? '检查中…' : '检查更新'}
        </button>
        {msg && <span style={{ opacity: 0.7, fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  )
}
