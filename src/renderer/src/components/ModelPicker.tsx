import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { putSettings } from '../api'
import Icon from './Icon'
import type { SettingsTab } from './SettingsDialog'

const MP_TABS: { id: SettingsTab; icon: string; label: string }[] = [
  { id: 'video', icon: 'video', label: '视频模型' },
  { id: 'image', icon: 'image', label: '图像生成' },
  { id: 'audio', icon: 'mic', label: '语音 · 音乐' },
  { id: 'llm', icon: 'bot', label: 'LLM 模型' }
]

const POPOVER_W = 480

/** Display label for an activeModel id ("providerId/modelId") — leads with the model name, not the provider prefix. */
export function modelDisplayLabel(settings: Settings | null | undefined, activeModel?: string): string {
  if (!activeModel) return '未配置'
  for (const p of settings?.llm?.providers || []) {
    for (const m of p.models || []) {
      if (`${p.id}/${m.id}` === activeModel) return m.name || m.id
    }
  }
  return activeModel
}

interface Props {
  settings: Settings
  /** bounding rect (viewport coords) of the chip button that opened this popover */
  anchor: { left: number; top: number; bottom: number }
  onClose: () => void
  onSaved: (s: Settings) => void
  /** open the full settings dialog on a given tab (for entering keys) */
  onOpenSettings: (tab: SettingsTab) => void
}

/**
 * Quick model picker anchored to the home / chat model chip:
 * opens right below the button — or above it when there is no room below — never
 * as a centered modal. "打开完整设置" is pinned in the header so it stays reachable
 * no matter how long the model list is.
 */
export default function ModelPicker({ settings, anchor, onClose, onSaved, onOpenSettings }: Props) {
  const [tab, setTab] = useState<SettingsTab>('video')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const spaceBelow = window.innerHeight - anchor.bottom
  const openUp = spaceBelow < 320
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - POPOVER_W - 12))
  const posStyle: React.CSSProperties = openUp
    ? { left, bottom: window.innerHeight - anchor.top + 8 }
    : { left, top: anchor.bottom + 8 }

  const patch = async (p: Partial<Settings>) => {
    setBusy(true)
    try {
      const next = await putSettings(p)
      onSaved(next)
    } finally {
      setBusy(false)
    }
  }

  const video = settings.video
  // unified task-style entry first; legacy vendor channels only when already enabled
  const videoRows: { key: string; name: string; desc: string; configured: boolean }[] = [
    {
      key: 'custom',
      name: video?.custom?.name || ((video?.custom?.submitUrl || '').includes('dashscope.aliyuncs.com') ? '阿里云百炼' : '视频模型（任务式 API）'),
      desc: video?.custom?.submitUrl ? video.custom.model || video.custom.submitUrl : '未填提交地址',
      configured: !!(video?.custom?.submitUrl && video?.custom?.queryUrl)
    }
  ]
  const legacy: [string, string, string, boolean][] = [
    ['kling', '可灵 Kling', video?.kling?.model || 'kling-v1', !!(video?.kling?.accessKey && video?.kling?.secretKey)],
    ['minimax', 'MiniMax 海螺', video?.minimax?.model || 'T2V-01', !!video?.minimax?.apiKey],
    ['fal', 'fal.ai', video?.fal?.model || 'fal-ai/…', !!video?.fal?.apiKey]
  ]
  for (const [key, name, desc, configured] of legacy) {
    if ((video as unknown as Record<string, { enabled?: boolean }>)[key]?.enabled) {
      videoRows.push({ key, name, desc, configured })
    }
  }

  const llmOptions: { value: string; name: string; provider: string }[] = []
  for (const p of settings.llm?.providers || []) {
    for (const m of p.models || []) {
      llmOptions.push({ value: `${p.id}/${m.id}`, name: m.name || m.id, provider: p.name || p.id })
    }
  }

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="mp-popover" style={posStyle} onClick={(e) => e.stopPropagation()}>
        <header className="mp-head">
          <span className="mp-title">
            选择模型 {busy && <span className="mp-busy">保存中…</span>}
          </span>
          <button className="mp-open-settings" onClick={() => onOpenSettings(tab)} title="填 API Key / 改模型参数">
            <Icon name="sliders" size={13} /> 打开完整设置
          </button>
        </header>
        <div className="settings-tabs mp-tabs">
          {MP_TABS.map((t) => (
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

        <div className="mp-body">
          {tab === 'video' && (
            <div className="mp-list">
              {videoRows.map((row) => {
                const cfg = (video as unknown as Record<string, { enabled?: boolean }>)[row.key]
                const enabled = !!cfg?.enabled
                return (
                  <div className="mp-row" key={row.key}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) =>
                        patch({
                          video: { ...video, [row.key]: { ...(video as unknown as Record<string, object>)[row.key], enabled: e.target.checked } }
                        })
                      }
                    />
                    <div className="mp-main">
                      <div className="mp-name">{row.name}</div>
                      <div className="mp-desc">{row.desc}</div>
                    </div>
                    <span className={`mp-status ${row.configured ? 'ok' : 'off'}`}>
                      {row.configured ? '已配置' : '未配置'}
                    </span>
                    <label className="mp-default" title="Agent 未指定 provider 时优先使用它">
                      <input
                        type="radio"
                        name="mp-video-default"
                        checked={(video?.defaultProvider || '') === row.key}
                        disabled={!enabled}
                        onChange={() => patch({ video: { ...video, defaultProvider: row.key } })}
                      />
                      默认
                    </label>
                  </div>
                )
              })}
              <div className="hint">在 设置 → 视频模型 里填 URL + Key + 模型即可接入（提交 → 轮询 → 取回视频的通用任务协议）。</div>
            </div>
          )}

          {tab === 'image' && (
            <div className="mp-list">
              <div className="mp-row">
                <input
                  type="checkbox"
                  checked={!!settings.image?.openai?.enabled}
                  onChange={(e) =>
                    patch({
                      image: { ...settings.image, openai: { ...settings.image.openai, enabled: e.target.checked } }
                    })
                  }
                />
                <div className="mp-main">
                  <div className="mp-name">OpenAI 兼容图像 API</div>
                  <div className="mp-desc">{settings.image?.openai?.model || 'gpt-image-1'}</div>
                </div>
                <span className={`mp-status ${settings.image?.openai?.apiKey ? 'ok' : 'off'}`}>
                  {settings.image?.openai?.apiKey ? '已配置' : '未配置'}
                </span>
              </div>
              <div className="mp-row">
                <input
                  type="checkbox"
                  checked={!!settings.image?.comfyui?.enabled}
                  onChange={(e) =>
                    patch({
                      image: { ...settings.image, comfyui: { ...settings.image.comfyui, enabled: e.target.checked } }
                    })
                  }
                />
                <div className="mp-main">
                  <div className="mp-name">本地 ComfyUI</div>
                  <div className="mp-desc">{settings.image?.comfyui?.url || 'http://127.0.0.1:8188'}</div>
                </div>
                <span className="mp-status ok">本地</span>
              </div>
            </div>
          )}

          {tab === 'audio' && (
            <div className="mp-list">
              <div className="mp-row">
                <input
                  type="checkbox"
                  checked={!!settings.audio?.tts?.enabled}
                  onChange={(e) =>
                    patch({
                      audio: { ...settings.audio, tts: { ...settings.audio.tts, enabled: e.target.checked } }
                    })
                  }
                />
                <div className="mp-main">
                  <div className="mp-name">语音合成 TTS</div>
                  <div className="mp-desc">
                    {settings.audio?.tts?.model || 'tts-1'} · 音色 {settings.audio?.tts?.voice || 'alloy'}
                  </div>
                </div>
                <span className={`mp-status ${settings.audio?.tts?.apiKey ? 'ok' : 'off'}`}>
                  {settings.audio?.tts?.apiKey ? '已配置' : '未配置'}
                </span>
              </div>
              <div className="mp-row">
                <input
                  type="checkbox"
                  checked={!!settings.audio?.music?.enabled}
                  onChange={(e) =>
                    patch({
                      audio: { ...settings.audio, music: { ...settings.audio.music, enabled: e.target.checked } }
                    })
                  }
                />
                <div className="mp-main">
                  <div className="mp-name">音乐生成（fal.ai）</div>
                  <div className="mp-desc">{settings.audio?.music?.model || 'CassetteAI/music-generator'}</div>
                </div>
                <span
                  className={`mp-status ${settings.audio?.music?.apiKey || settings.video?.fal?.apiKey ? 'ok' : 'off'}`}
                >
                  {settings.audio?.music?.apiKey || settings.video?.fal?.apiKey ? '已配置' : '未配置'}
                </span>
              </div>
            </div>
          )}

          {tab === 'llm' && (
            <div className="mp-list">
              {llmOptions.length === 0 && (
                <div className="hint">还没有可选模型——先到 LLM 模型 设置里添加 Provider 并获取模型列表。</div>
              )}
              {llmOptions.map((o) => (
                <label className="mp-row" key={o.value}>
                  <input
                    type="radio"
                    name="mp-llm-active"
                    checked={(settings.llm?.activeModel || '') === o.value}
                    onChange={() => patch({ llm: { ...settings.llm, activeModel: o.value } })}
                  />
                  <div className="mp-main">
                    <div className="mp-name">{o.name}</div>
                    <div className="mp-desc">{o.provider} · {o.value}</div>
                  </div>
                  {(settings.llm?.activeModel || '') === o.value && (
                    <span className="mp-status ok">使用中</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
