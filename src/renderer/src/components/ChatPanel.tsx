import { useEffect, useRef, useState } from 'react'
import { sendAgent, abortAgent, importAttachment, fileUrl, getCanvas } from '../api'
import type { CanvasDocument } from '@shared/types'
import Icon from './Icon'
import ComposerMode, { loadComposerMode, STORAGE_KEY, type ComposerMode as ModeValue } from './ComposerMode'
import type { ChatMessage, ExecutionPlan, PlanStageStatus } from '@shared/types'
import type { PendingQuestion } from '../stores/useChatStore'

interface Props {
  messages: ChatMessage[]
  error: string | null
  running: boolean
  onSend: (text: string) => void
  projectPath?: string
  model?: string
  plan?: ExecutionPlan | null
  onOpenModels?: (e: React.MouseEvent) => void
  pendingQuestion?: PendingQuestion | null
  onAnswer?: (answers: string[][], cancelled: boolean) => void
  onToast?: (msg: string) => void
  onOpenSkills?: () => void
  /** collapse the panel to the icon rail (P3 dock mode) */
  onCollapse?: () => void
}

const PLAN_STATUS: Record<PlanStageStatus, { icon: string; label: string }> = {
  waiting: { icon: '⏳', label: '待执行' },
  doing: { icon: '🔄', label: '进行中' },
  done: { icon: '✅', label: '已完成' },
  blocked: { icon: '⛔', label: '受阻' },
  cancelled: { icon: '🚫', label: '已取消' }
}

function PlanCard({ plan }: { plan: ExecutionPlan }) {
  const [open, setOpen] = useState(true)
  const done = plan.stages.filter((s) => s.status === 'done').length
  return (
    <div className="plan-card">
      <button className="plan-head" onClick={() => setOpen((v) => !v)}>
        <span className="plan-title"><Icon name="clipboard" size={13} /> {plan.goal}</span>
        <span className="plan-progress">
          {done}/{plan.stages.length}
        </span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="plan-stages">
          {plan.stages.map((s) => {
            const st = PLAN_STATUS[s.status]
            return (
              <div key={s.id} className={`plan-stage ${s.status}`}>
                <span className="plan-ico">{st.icon}</span>
                <span className="plan-name">{s.name}</span>
                <span className="plan-status">
                  {st.label}
                  {s.waiting_reason === 'plan_review' && ' · 等确认'}
                  {s.waiting_reason === 'result_review' && ' · 待过目'}
                </span>
                {s.outputs.length > 0 && (
                  <span className="plan-outputs">{s.outputs.map((o) => `「${o}」`).join('')}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function UserText({ text }: { text: string }) {
  const { paths, body } = parseAttachmentPrefix(text)
  return (
    <>
      {paths.length > 0 && (
        <div className="msg-attach">
          {paths.map((p, i) => (
            <img key={i} className="msg-attach-thumb" src={fileUrl(p)} alt="" title={p} />
          ))}
        </div>
      )}
      <div>{renderText(body)}</div>
    </>
  )
}

function renderText(text: string) {
  // minimal renderer: preserve lines, render `filename` anchors as chips
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return <code key={i}>{p.slice(1, -1)}</code>
    }
    return <span key={i}>{p}</span>
  })
}

function QuestionCard({
  pending,
  onAnswer
}: {
  pending: PendingQuestion
  onAnswer: (answers: string[][], cancelled: boolean) => void
}) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [others, setOthers] = useState<Record<number, string>>({})

  const toggle = (qi: number, opt: string, multi?: boolean) => {
    setAnswers((a) => {
      const cur = a[qi] || []
      if (multi) {
        return { ...a, [qi]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] }
      }
      return { ...a, [qi]: cur.includes(opt) ? [] : [opt] }
    })
  }

  const complete = pending.questions.every(
    (_, qi) => (answers[qi] || []).length > 0 || (others[qi] || '').trim().length > 0
  )

  const submit = () => {
    const result = pending.questions.map((_, qi) => {
      const picked = [...(answers[qi] || [])]
      const other = (others[qi] || '').trim()
      if (other) picked.push(other)
      return picked
    })
    onAnswer(result, false)
  }

  return (
    <div className="question-card">
      <div className="qc-head"><Icon name="message" size={14} /> Agent 想确认几个问题</div>
      {pending.questions.map((q, qi) => (
        <div className="qc-item" key={qi}>
          <div className="qc-q">{q.question}</div>
          <div className="qc-options">
            {q.options.map((opt) => {
              const active = (answers[qi] || []).includes(opt)
              return (
                <button
                  key={opt}
                  className={`qc-opt ${active ? 'active' : ''}`}
                  onClick={() => toggle(qi, opt, q.multiSelect)}
                >
                  {opt}
                </button>
              )
            })}
          </div>
          <input
            className="qc-other"
            placeholder="其他…直接填写"
            value={others[qi] || ''}
            onChange={(e) => setOthers((o) => ({ ...o, [qi]: e.target.value }))}
          />
        </div>
      ))}
      <div className="qc-foot">
        <button onClick={() => onAnswer([], true)}>取消</button>
        <button className="primary" disabled={!complete} onClick={submit}>
          提交回答
        </button>
      </div>
    </div>
  )
}

interface Attachment {
  name: string
  /** absolute path injected into the agent message as [附件: ...] */
  absPath: string
  /** preview url (blob for picked files, /files for canvas nodes) */
  url: string
  /** picked file pending upload; canvas picks have none */
  file?: File
}

/** Split leading plumbing markers ("[附件: a, b]" / "[模式: 询问]") from the visible user text. */
function parseAttachmentPrefix(text: string): { paths: string[]; body: string } {
  let paths: string[] = []
  let body = text
  const m = /^\[附件: ([^\]]*)\]\n?/.exec(body)
  if (m) {
    paths = m[1].split(/,\s*/).filter(Boolean)
    body = body.slice(m[0].length)
  }
  body = body.replace(/^\[模式: 询问\]\n?/, '')
  return { paths, body }
}

export default function ChatPanel({ messages, error, running, onSend, projectPath, model, plan, onOpenModels, pendingQuestion, onAnswer, onToast, onOpenSkills, onCollapse }: Props) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [mode, setMode] = useState<ModeValue>(loadComposerMode)
  const [showGuide, setShowGuide] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const changeMode = (m: ModeValue) => {
    setMode(m)
    try {
      localStorage.setItem(STORAGE_KEY, m)
    } catch {
      /* private mode — session-only */
    }
  }

  /** Auto-grow textarea: grows with content, capped at ~10 lines. */
  const resizeInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }

  useEffect(() => {
    resizeInput()
  }, [input])

  const addFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    const next = Array.from(files).map((file) => ({
      name: file.name,
      absPath: '',
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
      file
    }))
    setAttachments((a) => [...a, ...next].slice(0, 8))
  }

  const [showCanvasPick, setShowCanvasPick] = useState(false)
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const [canvasNodes, setCanvasNodes] = useState<{ id: string; name: string; abs: string; thumb: string }[]>([])

  const pickFromCanvas = async () => {
    if (!projectPath) return
    try {
      const doc: CanvasDocument = await getCanvas(projectPath)
      const rows = (doc.nodes || [])
        .filter((n) => n.type === 'image' && n.data?.path)
        .slice(-12)
        .map((n) => {
          const abs = `${projectPath.replace(/\/+$/, '')}/${n.data!.path}`
          return { id: n.id, name: n.data!.name || n.data!.path || '', abs, thumb: fileUrl(abs) }
        })
      setCanvasNodes(rows)
      setShowCanvasPick(true)
    } catch {
      setShowCanvasPick(false)
    }
  }

  const attachCanvasNode = (row: { name: string; abs: string; thumb: string }) => {
    setAttachments((a) => [...a, { name: row.name, absPath: row.abs, url: row.thumb }].slice(0, 8))
    setShowCanvasPick(false)
  }

  const removeAttachment = (i: number) => {
    setAttachments((a) => {
      const [gone] = a.filter((_, j) => j === i)
      if (gone?.url) URL.revokeObjectURL(gone.url)
      return a.filter((_, j) => j !== i)
    })
  }

  const send = async () => {
    const text = input.trim()
    if (running || uploading) return
    if (!text && attachments.length === 0) return
    let composed = text
    if (mode === 'ask') composed = `[模式: 询问]\n${composed}`
    if (attachments.length > 0) {
      if (!projectPath) return
      setUploading(true)
      try {
        const absPaths: string[] = []
        for (const a of attachments) {
          if (a.file) {
            const info = await importAttachment(projectPath, a.file.name, a.file)
            absPaths.push(`${projectPath.replace(/\/+$/, '')}/${info.file}`)
          } else {
            absPaths.push(a.absPath)
          }
        }
        composed = `[附件: ${absPaths.join(', ')}]\n${composed}`
      } catch (e) {
        setUploading(false)
        onToast?.(`附件上传失败：${String((e as Error).message || e)}`)
        return
      }
      setUploading(false)
      attachments.forEach((a) => a.url && a.url.startsWith('blob:') && URL.revokeObjectURL(a.url))
      setAttachments([])
    }
    onSend(composed)
    setInput('')
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, error, pendingQuestion])

  return (
    <div className="chat">
      <div className="chat-head">
        <Icon name="bot" size={15} /> Agent
        <span className={`badge ${running ? '' : 'ok'}`}>{running ? '思考中…' : '就绪'}</span>
        {running && (
          <button style={{ marginLeft: 'auto' }} onClick={() => void abortAgent()}>
            停止
          </button>
        )}
        {onCollapse && (
          <button className="chat-collapse" style={{ marginLeft: running ? 0 : 'auto' }} title="收起面板" onClick={onCollapse}>
            <Icon name="chevronRight" size={14} />
          </button>
        )}
      </div>
      <div className="chat-log" ref={logRef}>
        {plan && plan.stages.length > 0 && <PlanCard plan={plan} />}
        {messages.length === 0 && (
          <div className="hint" style={{ textAlign: 'center', marginTop: 40, padding: '0 20px' }}>
            <div className="empty-ico" style={{ margin: '0 auto 10px' }}>
              <Icon name="bot" size={22} />
            </div>
            和 agent 描述你想创作的内容，例如：
            <br />
            「画一张赛博朋克风格的城市夜景，16:9」
            <br />
            「生成 4 张雪山村落的分镜，然后建一个计划节点」
            <br />
            <br />
            生成的图片会自动出现在画布上。
          </div>
        )}
        {messages.map((m) => {
          const parts = m.parts.map((p, i) =>
            p.type === 'text' ? (
              <div key={i}>{m.role === 'user' ? <UserText text={p.text || ''} /> : renderText(p.text || '')}</div>
            ) : p.type === 'tool' ? (
              <span key={i} className={`toolchip ${p.state}`}>
                <span className="st" />
                {p.tool}
                {p.state === 'running' ? '…' : p.state === 'error' ? ' 失败' : ''}
              </span>
            ) : null
          )
          if (m.role === 'user') {
            return (
              <div key={m.id} className="msg user">
                {parts}
                {m.error && <div style={{ color: 'var(--danger)', marginTop: 4 }}>{m.error}</div>}
              </div>
            )
          }
          return (
            <div key={m.id} className="msg assistant">
              <div className="msg-avatar" title="agent">
                <Icon name="bot" size={13} strokeWidth={2} />
              </div>
              <div className="msg-body">
                {parts}
                {m.error && <div style={{ color: 'var(--danger)', marginTop: 4 }}>{m.error}</div>}
              </div>
            </div>
          )
        })}
        {pendingQuestion && onAnswer && (
          <QuestionCard pending={pendingQuestion} onAnswer={onAnswer} />
        )}
      </div>
      {error && <div className="err-banner">{error}</div>}
      <div className="chat-input-wrap">
        <div
          className="chat-box"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            addFiles(e.dataTransfer?.files)
          }}
        >
          {attachments.length > 0 && (
            <div className="attach-row">
              {attachments.map((a, i) => (
                <div className="attach-chip" key={i}>
                  {a.url ? (
                    <img className="attach-thumb" src={a.url} alt="" />
                  ) : (
                    <span className="attach-ico">
                      <Icon name="file" size={14} />
                    </span>
                  )}
                  <span className="attach-name" title={a.file?.name || a.name}>
                    {a.file?.name || a.name}
                  </span>
                  <button className="attach-remove" title="移除" onClick={() => removeAttachment(i)}>
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-editor">
            {!input && (
              <div className="composer-ph" data-composer-placeholder="">
                {uploading ? (
                  <span>附件上传中…</span>
                ) : running ? (
                  <span>Agent 运行中…</span>
                ) : (
                  <>
                    <span className="composer-ph-lead">描述你要生成的内容，</span>
                    <button
                      type="button"
                      className="composer-ph-guide"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setShowGuide(true)}
                      title="查看使用指南"
                    >
                      <span className="composer-ph-guide-text">使用指南</span>
                      <Icon name="arrowUpRight" size={11} strokeWidth={1.8} />
                    </button>
                  </>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              aria-label="输入消息"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const fs = Array.from(e.clipboardData?.files || [])
                if (fs.length > 0) {
                  e.preventDefault()
                  addFiles(fs)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
          </div>
          {showCanvasPick && (
            <div className="canvas-pick">
              <div className="cp-head">
                从画布选择参考图
                <button onClick={() => setShowCanvasPick(false)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
              {canvasNodes.length === 0 && <div className="hint" style={{ padding: 10 }}>画布上还没有图片</div>}
              <div className="cp-grid">
                {canvasNodes.map((n) => (
                  <button key={n.id} className="cp-item" title={n.name} onClick={() => attachCanvasNode(n)}>
                    <img src={n.thumb} alt="" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="composer-row">
            <div className="composer-left">
              <button
                className="composer-attach"
                title="添加附件"
                onClick={() => setShowPlusMenu((v) => !v)}
              >
                <Icon name="plus" size={16} strokeWidth={1.5} />
              </button>
              {showPlusMenu && (
                <div className="plus-menu">
                  <button
                    onClick={() => {
                      setShowPlusMenu(false)
                      fileInputRef.current?.click()
                    }}
                  >
                    <Icon name="upload" size={14} /> 从电脑上传
                  </button>
                  <button
                    onClick={() => {
                      setShowPlusMenu(false)
                      void pickFromCanvas()
                    }}
                  >
                    <Icon name="image" size={14} /> 从画布选择
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,video/*,audio/*,.pdf,.txt,.md,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                className="composer-tool"
                title={`当前模型：${model || '未配置'}（点击切换）`}
                onClick={(e) => onOpenModels?.(e)}
              >
                <Icon name="box" size={16} strokeWidth={1.5} />
                <span className="composer-label">模型</span>
              </button>
              <span className="composer-divider" aria-hidden="true" />
              <button className="composer-tool" title="Skill 技能库" onClick={() => onOpenSkills?.()}>
                <Icon name="skill" size={16} strokeWidth={1.5} />
                <span className="composer-label">Skill</span>
              </button>
            </div>
            <div className="composer-right">
              <ComposerMode mode={mode} onChange={changeMode} disabled={running} />
              {running ? (
                <button className="composer-send" title="停止" onClick={() => void abortAgent()}>
                  <span className="composer-stop-square" />
                </button>
              ) : (
                <button
                  className="composer-send"
                  title="发送（Enter）"
                  onClick={() => void send()}
                  disabled={uploading || (!input.trim() && attachments.length === 0)}
                >
                  <Icon name="arrowUp" size={16} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
    </div>
  )
}

/** 「使用指南」轻量弹窗 —— 输入框占位链接的目标。 */
function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()}>
        <header>
          <Icon name="message" size={14} /> 使用指南
        </header>
        <div className="content guide-content">
          <div className="guide-item">
            <div className="guide-t">直接描述想创作的内容</div>
            <div className="guide-d">例如「画一张赛博朋克风格的城市夜景，16:9」，生成的图片会自动出现在画布上。</div>
          </div>
          <div className="guide-item">
            <div className="guide-t">视频走四步法</div>
            <div className="guide-d">
              澄清需求 → 风格样例（首帧 + 配音）→ 定稿 → 生成成片；agent 会先给样例再动用视频模型。
            </div>
          </div>
          <div className="guide-item">
            <div className="guide-t">复杂任务先立计划</div>
            <div className="guide-d">
              多镜头成片、系列产出会自动生成「执行计划」，逐段推进；也可以说「建一个计划节点」手动触发。
            </div>
          </div>
          <div className="guide-item">
            <div className="guide-t">善用 Skill 与模式</div>
            <div className="guide-d">
              输入框的 Skill 按钮可浏览技能工作流；模式选「询问」时，agent 会在关键生成操作前先与你确认。
            </div>
          </div>
        </div>
        <footer>
          <button className="primary" onClick={onClose}>
            开始创作
          </button>
        </footer>
      </div>
    </div>
  )
}
