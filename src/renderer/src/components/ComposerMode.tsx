import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'

export type ComposerMode = 'auto' | 'ask'

const MODE_OPTIONS: { value: ComposerMode; icon: string; label: string; desc: string }[] = [
  { value: 'auto', icon: 'modeAuto', label: '自动', desc: '自动完成生成等操作，减少中途打断。' },
  { value: 'ask', icon: 'modeAsk', label: '询问', desc: '执行生成等关键操作前，先询问你。' }
]

export const STORAGE_KEY = 'ed.composerMode'

export function loadComposerMode(): ComposerMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ask' ? 'ask' : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * Agent 模式选择器（自动 / 询问）：
 * 按钮收在输入框工具行右侧，弹层向上展开；「询问」档通过消息头
 * [模式: 询问] 传给 agent（见 agents/contracts/baseline.md 执行模式规则）。
 */
export default function ComposerMode({
  mode,
  onChange,
  disabled
}: {
  mode: ComposerMode
  onChange: (m: ComposerMode) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0]

  return (
    <div className={`composer-mode ${open ? 'open' : ''}`} ref={boxRef}>
      <button
        type="button"
        className="composer-mode-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Agent 模式：${current.label}`}
        title={`Agent 模式：${current.label}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current.label}</span>
        <Icon name="chevronDown" size={16} strokeWidth={1.5} className="composer-mode-chev" />
      </button>
      {open && (
        <div className="composer-mode-pop" role="listbox" aria-label="Agent 模式">
          <div className="cmp-pop-label">Agent 模式</div>
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === mode}
              className={`cmp-pop-opt ${o.value === mode ? 'active' : ''}`}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span className="cmp-pop-ico">
                <Icon name={o.icon} size={16} strokeWidth={1.5} />
              </span>
              <span className="cmp-pop-text">
                <span className="cmp-pop-title">{o.label}</span>
                <span className="cmp-pop-desc">{o.desc}</span>
              </span>
              {o.value === mode && <Icon name="check" size={14} strokeWidth={2} className="cmp-pop-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
