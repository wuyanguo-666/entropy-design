import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '@shared/agent-events'
import type { AgentTask, CanvasDocument, ExecutionPlan, ProjectInfo } from '@shared/types'
import {
  createProject,
  openProjectDialog,
  getCanvas,
  getPlan,
  getAgentHistory,
  apiToken,
  putCanvas,
  putSelection,
  startAgent,
  agentStatus,
  sendAgent,
  answerQuestion,
  base,
  renameGroupApi,
  removeGroupApi,
  setProjectGroupApi,
  deleteProjectsBatchApi,
  renameProject,
  deleteProject,
  setProjectPinApi,
  getSkills,
  getSkillDetail,
  createSkill,
  updateSkill,
  deleteSkill,
  openSkillsFolder,
  type SkillInfo,
  type SkillDetail
} from './api'
import { useProjectsStore } from './stores/useProjectsStore'
import { useSettingsStore } from './stores/useSettingsStore'
import { useTasksStore } from './stores/useTasksStore'
import { useChatStore, type AskUserQuestion } from './stores/useChatStore'
import CanvasBoard from './components/CanvasBoard'
import ChatPanel from './components/ChatPanel'
import Inspector from './components/Inspector'
import SettingsDialog, { type SettingsTab } from './components/SettingsDialog'
import ModelPicker, { modelDisplayLabel } from './components/ModelPicker'
import Icon from './components/Icon'
import logoH from './assets/logo.png'

/** Soft neutral cover tints (index stable per project id) — replaces saturated gradients. */
const TINT_COUNT = 5
const tintOf = (p: ProjectInfo): number =>
  [...p.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % TINT_COUNT

const INSPIRATION_CARDS = [
  {
    label: '品牌主视觉',
    tag: '图像',
    icon: 'palette',
    tint: 0,
    prompt: '设计一张品牌主视觉海报：极简构图，大胆的标题排版，高级渐变配色，突出品牌气质。'
  },
  {
    label: '产品场景图',
    tag: '图像',
    icon: 'image',
    tint: 1,
    prompt: '为一件产品生成高级感场景图：柔和摄影棚光，浅景深，干净背景，商业摄影质感。'
  },
  {
    label: '动感短片',
    tag: '视频 5s',
    icon: 'video',
    tint: 2,
    prompt: '生成一段 5 秒短视频：街头舞者的剪影，逆光霓虹，慢动作，16:9。'
  },
  {
    label: '角色设定',
    tag: '图像',
    icon: 'bot',
    tint: 3,
    prompt: '创作一个奇幻角色的三视图设定：正面/侧面/背面，统一光照，干净背景。'
  }
]

export default function App() {
  const projects = useProjectsStore((s) => s.projects)
  const [current, setCurrent] = useState<ProjectInfo | null>(null)
  const [doc, setDoc] = useState<CanvasDocument>({ version: 1, mode: 'workflow', nodes: [], edges: [] })
  const [plan, setPlan] = useState<ExecutionPlan | null>(null)
  const settings = useSettingsStore((s) => s.settings)
  const setSettings = useSettingsStore((s) => s.set)
  const refreshSettings = useSettingsStore((s) => s.refresh)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('video')
  const [modelsAnchor, setModelsAnchor] = useState<{ left: number; top: number; bottom: number } | null>(null)
  const [chatW, setChatW] = useState(() => {
    const n = Number(localStorage.getItem('ed.chatWidth'))
    return Number.isFinite(n) && n >= 320 && n <= 720 ? n : 400
  })
  const chatDrag = useRef<{ startX: number; startW: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!chatDrag.current) return
      const w = Math.min(720, Math.max(320, chatDrag.current.startW + (chatDrag.current.startX - e.clientX)))
      setChatW(w)
      localStorage.setItem('ed.chatWidth', String(w))
    }
    const up = () => {
      if (!chatDrag.current) return
      chatDrag.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])
  const openModelsAt = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setModelsAnchor({ left: r.left, top: r.top, bottom: r.bottom })
  }
  // P3 dock mode: chat can collapse to a 48px rail mirroring plan progress
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('ed.chatOpen') !== '0')
  const toggleChat = useCallback((v?: boolean) => {
    setChatOpen((prev) => {
      const next = v ?? !prev
      localStorage.setItem('ed.chatOpen', next ? '1' : '0')
      return next
    })
  }, [])
  // inspector needs the live selection; questions must never hide behind a collapsed dock
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [showInspector, setShowInspector] = useState(false)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!currentRef.current) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return
      if (e.key === 'i' || e.key === 'I') setShowInspector((v) => !v)
      else if (e.key === 'Escape') setShowInspector(false)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  const messages = useChatStore((s) => s.messages)
  const chatError = useChatStore((s) => s.chatError)
  const running = useChatStore((s) => s.running)
  const agentReady = useChatStore((s) => s.agentReady)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const setChatError = useChatStore((s) => s.setChatError)
  const setRunning = useChatStore((s) => s.setRunning)
  const setAgentReady = useChatStore((s) => s.setAgentReady)
  const setPendingQuestion = useChatStore((s) => s.setPendingQuestion)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (pendingQuestion && !chatOpen) toggleChat(true)
  }, [pendingQuestion, chatOpen, toggleChat])
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
  }, [])

  // ---- project library: management lives in LibraryView (P4) ----
  const [view, setView] = useState<'home' | 'library'>('home')
  const [showSkills, setShowSkills] = useState(false)
  // live generation tasks mirrored from MCP (home task queue) — zustand store
  const tasks = useTasksStore((s) => s.tasks)
  const syncTasks = useTasksStore((s) => s.refresh)

  const goHome = useCallback(() => {
    setCurrent(null)
    currentRef.current = null
    setDoc({ version: 1, mode: 'workflow', nodes: [], edges: [] })
    setPlan(null)
    useChatStore.getState().clearMessages()
    useChatStore.getState().setAgentReady(false)
  }, [])

  const currentRef = useRef<ProjectInfo | null>(null)
  currentRef.current = current

  const refreshProjects = useProjectsStore((s) => s.refresh)

  useEffect(() => {
    refreshProjects()
    refreshSettings()
  }, [refreshProjects, refreshSettings])

  // theme: system / light / dark → html.dark class
  const theme = settings?.theme || 'system'
  useEffect(() => {
    const apply = () => {
      const dark =
        theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let dead = false

    const resync = () => {
      const p = currentRef.current
      if (!p) return
      void getCanvas(p.path).then(setDoc).catch(() => {})
      void getPlan(p.path).then(setPlan).catch(() => {})
    }

    const connect = () => {
      if (dead) return
      ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws?token=${encodeURIComponent(apiToken)}`)
      ws.onopen = () => {
        resync()
        syncTasks()
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as {
            kind: string
            path?: string
            canvas?: CanvasDocument
            plan?: ExecutionPlan | null
            event?: AgentEvent
            agent?: { running: boolean }
            id?: string
            questions?: AskUserQuestion[]
            task?: AgentTask
          }
          if (msg.kind === 'canvas-changed' && msg.path === currentRef.current?.path && msg.canvas) {
            setDoc(msg.canvas)
          } else if (msg.kind === 'plan-changed' && msg.path === currentRef.current?.path) {
            setPlan(msg.plan ?? null)
          } else if (msg.kind === 'agent-event' && msg.event) {
            useChatStore.getState().handleMessageEvent(msg.event)
          } else if (msg.kind === 'agent-question' && msg.id && msg.questions) {
            setPendingQuestion({ id: msg.id, questions: msg.questions })
          } else if (msg.kind === 'settings-changed') {
            refreshSettings()
          } else if (msg.kind === 'projects-changed') {
            refreshProjects()
          } else if (msg.kind === 'hello' && msg.agent) {
            setAgentReady(msg.agent.running)
          } else if (msg.kind === 'agent-task' && msg.task) {
            useTasksStore.getState().upsert(msg.task)
          }
        } catch {
          /* ignore malformed ws frame */
        }
      }
      ws.onclose = () => {
        if (!dead) retry = setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      dead = true
      if (retry) clearTimeout(retry)
      if (ws) ws.onclose = null
      ws?.close()
    }
  }, [syncTasks])

  useEffect(() => {
    const t = setInterval(() => {
      void agentStatus()
        .then((s) => {
          setAgentReady(s.running)
          if (s.running) {
            setChatError((prev) => (prev?.includes('opencode failed') ? null : prev))
          } else if (s.error) {
            // surface WHY the agent is down, but never overwrite a more specific message
            const reason = s.error
            setChatError((prev) => (prev == null ? reason : prev))
          }
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const selectProject = useCallback(async (p: ProjectInfo) => {
    setCurrent(p)
    currentRef.current = p
    useChatStore.getState().reset()
    try {
      setDoc(await getCanvas(p.path))
      void getPlan(p.path).then(setPlan).catch(() => setPlan(null))
      const st = await startAgent(p.path)
      setAgentReady(st.running)
      if (st.error) setChatError(st.error)
      // backfill existing session transcript
      useChatStore.getState().backfillHistory(await getAgentHistory())
      void agentStatus()
        .then((s) => {
          setAgentReady(s.running)
          if (s.running) setChatError((prev) => (prev?.includes('opencode') ? null : prev))
        })
        .catch(() => {})
    } catch (e) {
      setChatError(String((e as Error).message || e))
    }
  }, [])

  const saveCanvas = useCallback(
    (next: CanvasDocument) => {
      setDoc(next)
      if (currentRef.current) void putCanvas(currentRef.current.path, next).catch(() => {})
    },
    []
  )

  // selection is persisted (debounced) so the agent's canvas_selection_read can see it
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleCanvasSelection = useCallback((ids: string[]) => {
    setSelectedNodeIds(ids)
    if (selectionTimer.current) clearTimeout(selectionTimer.current)
    selectionTimer.current = setTimeout(() => {
      const p = currentRef.current
      if (!p) return
      void putSelection(p.path, ids).catch(() => {})
    }, 300)
  }, [])

  const handleNewProject = useCallback(
    async (name?: string) => {
      try {
        const p = await createProject(name || '新画布')
        refreshProjects()
        await selectProject(p)
      } catch (e) {
        showToast(String((e as Error).message || e))
      }
    },
    [refreshProjects, selectProject, showToast]
  )

  const send = useCallback((text: string) => {
    // optimistic echo: render the user's own message as a user bubble immediately;
    // opencode may echo it late (or not at all), which previously left it styled as agent
    useChatStore.getState().echoUser(text)
    void sendAgent(text).catch((e) => {
      setChatError(String((e as Error).message || e))
      setRunning(false)
    })
  }, [])

  /** Home flow: create project → open it → send the prompt. */
  const startFromHome = useCallback(
    async (text: string) => {
      try {
        const p = await createProject('新画布')
        refreshProjects()
        await selectProject(p)
        send(text)
      } catch (e) {
        setChatError(String((e as Error).message || e))
      }
    },
    [refreshProjects, selectProject, send]
  )

  return (
    <div
      className={`app ${current ? '' : 'no-chat'}`}
      style={current ? { gridTemplateColumns: `48px 1fr ${chatOpen ? `5px ${chatW}px` : '48px'}` } : undefined}
    >
      <div className="rail">
        <img className="rail-logo" src={logoH} alt="" title="Entropy Design" onClick={() => { setCurrent(null); setView('home') }} />
        <button
          className={`rail-item ${!current && view === 'home' ? 'active' : ''}`}
          title="开始创作"
          onClick={() => { setCurrent(null); setView('home') }}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          className={`rail-item ${!current && view === 'library' ? 'active' : ''}`}
          title="项目库"
          onClick={() => { setCurrent(null); setView('library') }}
        >
          <Icon name="folder" size={16} />
        </button>
        <button className="rail-item" title="新建项目" onClick={() => void handleNewProject()}>
          <Icon name="folderPlus" size={16} />
        </button>
        <button
          className="rail-item"
          title="导入本地文件夹为项目"
          onClick={() => {
            void openProjectDialog().then((p) => {
              if (p) refreshProjects()
            })
          }}
        >
          <Icon name="upload" size={16} />
        </button>
        <button className="rail-item" title="Skill 技能库" onClick={() => setShowSkills(true)}>
          <Icon name="sparkles" size={16} />
        </button>
        <button
          className="rail-item"
          title="ComfyUI 工作流：在 设置 → 图像生成 中启用"
          onClick={() => {
            setSettingsTab('image')
            setShowSettings(true)
          }}
        >
          <Icon name="box" size={16} />
        </button>
        <div className="rail-flex" />
        {tasks.some((t) => t.status === 'running') && <span className="rail-pulse" title="有生成任务进行中" />}
        <button
          className="rail-item"
          title="设置（API / 模型）"
          onClick={() => {
            setSettingsTab('llm')
            setShowSettings(true)
          }}
        >
          <Icon name="sliders" size={16} />
        </button>
      </div>

      <div className="main">
        {current ? (
          <>
            <div className="topbar">
              <span className="title">{current.name}</span>
              <span className={`badge ${agentReady ? 'ok' : ''}`}>{agentReady ? 'Agent 已连接' : 'Agent 未启动'}</span>
              <span className="badge">模型：{modelDisplayLabel(settings, settings?.llm?.activeModel)}</span>
              <div className="spacer" />
              <span className="badge">{doc.nodes.length} 节点</span>
            </div>
            <CanvasBoard
              doc={doc}
              projectPath={current.path}
              onDocChange={saveCanvas}
              onSelectionChange={handleCanvasSelection}
              onToast={showToast}
            />
            {showInspector && <Inspector doc={doc} selection={selectedNodeIds} onClose={() => setShowInspector(false)} />}
          </>
        ) : view === 'library' ? (
          <LibraryView
            projects={projects}
            onOpen={(p) => void selectProject(p)}
            onNew={() => void handleNewProject()}
            isCurrent={(p) => currentRef.current?.id === p.id}
            onRenamed={(updated) => {
              refreshProjects()
              if (currentRef.current?.id === updated.id) void selectProject(updated)
            }}
            onDeleted={(wasCurrent: boolean) => {
              refreshProjects()
              if (wasCurrent) goHome()
            }}
            onChanged={refreshProjects}
            onError={showToast}
          />
        ) : (
          <HomeView
            projects={projects}
            tasks={tasks}
            model={modelDisplayLabel(settings, settings?.llm?.activeModel)}
            onStart={(text) => void startFromHome(text)}
            onOpenProject={(p) => void selectProject(p)}
            onOpenModels={openModelsAt}
            onOpenSkills={() => setShowSkills(true)}
          />
        )}
      </div>

      {current && chatOpen && (
        <div
          className="chat-divider"
          title="拖拽调整聊天面板宽度"
          onMouseDown={(e) => {
            chatDrag.current = { startX: e.clientX, startW: chatW }
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
        />
      )}
      {current && chatOpen && (
        <ChatPanel
          messages={messages}
          error={chatError}
          running={running}
          plan={plan}
          onSend={send}
          projectPath={current.path}
          model={modelDisplayLabel(settings, settings?.llm?.activeModel)}
          onToast={showToast}
          onOpenSkills={() => setShowSkills(true)}
          onOpenModels={openModelsAt}
          onCollapse={() => toggleChat(false)}
          pendingQuestion={pendingQuestion}
          onAnswer={(answers, cancelled) => {
            const q = pendingQuestion
            setPendingQuestion(null)
            if (q) void answerQuestion(q.id, answers, cancelled).catch((e) => showToast(String((e as Error).message || e)))
          }}
        />
      )}
      {current && !chatOpen && (
        <div className="chat-rail">
          <button className="rail-btn" title="展开聊天面板" onClick={() => toggleChat(true)}>
            <Icon name="chevronRight" size={14} />
          </button>
          {running && <span className="rail-pulse" title="Agent 运行中" />}
          {plan && plan.stages.length > 0 && (
            <div className="rail-plan" title={`执行计划 ${plan.stages.filter((s) => s.status === 'done').length}/${plan.stages.length}`}>
              {plan.stages.map((s) => (
                <span key={s.id} className={`rp-dot ${s.status}`} />
              ))}
            </div>
          )}
        </div>
      )}

      {modelsAnchor && settings && (
        <ModelPicker
          settings={settings}
          anchor={modelsAnchor}
          onClose={() => setModelsAnchor(null)}
          onSaved={(s) => setSettings(s)}
          onOpenSettings={(t) => {
            setModelsAnchor(null)
            setSettingsTab(t)
            setShowSettings(true)
          }}
        />
      )}

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          initialTab={settingsTab}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => setSettings(s)}
        />
      )}


      {showSkills && (
        <SkillModal
          onClose={() => setShowSkills(false)}
          onUse={(skill) => {
            setShowSkills(false)
            void startFromHome(`请使用 ${skill.name} 技能开始创作。需求：${skill.description || skill.title}`)
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function SkillModal({ onClose, onUse }: { onClose: () => void; onUse: (s: SkillInfo) => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  /** 表单视图：null = 列表；'new' = 新建；SkillDetail = 编辑/复制内置 */
  const [editing, setEditing] = useState<
    | { mode: 'new' }
    | { mode: 'edit' | 'fork'; detail: SkillDetail }
    | null
  >(null)
  const [err, setErr] = useState<string | null>(null)

  const refresh = () => {
    void getSkills()
      .then(setSkills)
      .catch(() => setSkills([]))
  }

  useEffect(() => {
    refresh()
  }, [])

  const openEdit = (name: string) => {
    void getSkillDetail(name)
      .then((detail) => setEditing({ mode: detail.source === 'builtin' ? 'fork' : 'edit', detail }))
      .catch((e) => setErr(String((e as Error).message || e)))
  }

  const mine = (skills || []).filter((s) => s.source === 'user')
  const mineNames = new Set(mine.map((s) => s.name))
  const builtin = (skills || []).filter((s) => s.source === 'builtin' && !mineNames.has(s.name))

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header><Icon name="sparkles" size={15} /> Skill 技能库</header>
        {editing ? (
          <SkillForm
            key={editing.mode + (('detail' in editing && editing.detail.name) || 'new')}
            mode={editing.mode}
            detail={'detail' in editing ? editing.detail : null}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              refresh()
            }}
            onError={setErr}
          />
        ) : (
          <>
            <div className="content">
              <div className="skill-toolbar">
                <div className="hint">
                  技能 = 一个文件夹（内含 SKILL.md）。“新建”会归档到你的技能文件夹，同名时覆盖内置版本；
                  也可以直接把技能文件夹丢进去，点「打开技能文件夹」查看。
                </div>
                <div className="skill-toolbar-actions">
                  <button onClick={() => void openSkillsFolder().then((r) => r?.error && setErr(r.error))}>
                    <Icon name="folder" size={14} /> 打开技能文件夹
                  </button>
                  <button className="primary" onClick={() => setEditing({ mode: 'new' })}>
                    <Icon name="plus" size={13} /> 新建技能
                  </button>
                </div>
              </div>

              {skills === null && <div className="hint">加载中…</div>}
              {err && <div className="err-banner">{err}</div>}

              <div className="skill-section-label">我的技能（{mine.length}）</div>
              {mine.length === 0 && (
                <div className="hint" style={{ padding: '4px 0 10px' }}>
                  还没有自定义技能 —— 点右上角「新建技能」，或从下方内置技能一键复制一份来改。
                </div>
              )}
              {mine.map((s) => (
                <div className="skill-card" key={s.name}>
                  <div className="skill-main">
                    <div className="skill-title">
                      {s.title || s.name}
                      {s.overrides && <span className="skill-badge">覆盖内置</span>}
                      <code className="skill-name-code">{s.name}</code>
                    </div>
                    <div className="skill-desc">{s.description}</div>
                    {s.triggers && <div className="skill-triggers">触发词：{s.triggers}</div>}
                  </div>
                  <div className="skill-actions">
                    <button className="primary" onClick={() => onUse(s)}>使用</button>
                    <button onClick={() => openEdit(s.name)}>
                      <Icon name="pencil" size={13} /> 编辑
                    </button>
                    <button
                      className="skill-danger-btn"
                      onClick={() => {
                        if (!window.confirm(`删除技能「${s.title || s.name}」？该文件夹将一并删除。`)) return
                        void deleteSkill(s.name)
                          .then(refresh)
                          .catch((e) => setErr(String((e as Error).message || e)))
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              ))}

              <div className="skill-section-label">内置技能（{builtin.length}）</div>
              {builtin.map((s) => (
                <div className="skill-card" key={s.name}>
                  <div className="skill-main">
                    <div className="skill-title">
                      {s.title || s.name}
                      <code className="skill-name-code">{s.name}</code>
                    </div>
                    <div className="skill-desc">{s.description}</div>
                    {s.triggers && <div className="skill-triggers">触发词：{s.triggers}</div>}
                  </div>
                  <div className="skill-actions">
                    <button className="primary" onClick={() => onUse(s)}>使用</button>
                    <button title="复制一份到「我的技能」并编辑" onClick={() => openEdit(s.name)}>
                      复制为我的技能
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <footer>
              <button onClick={onClose}>关闭</button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

const SKILL_BODY_TEMPLATE = `## 适用场景
（什么任务、什么触发时使用这个技能）

## 工作流
1. 第一步…
2. 第二步…
3. 第三步…

## 输出要求
- 交付物与质量标准…`

function SkillForm({
  mode,
  detail,
  onCancel,
  onSaved,
  onError
}: {
  mode: 'new' | 'edit' | 'fork'
  detail: SkillDetail | null
  onCancel: () => void
  onSaved: () => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState(detail ? detail.name : '')
  const [title, setTitle] = useState(detail?.title || '')
  const [description, setDescription] = useState(detail?.description || '')
  const [triggers, setTriggers] = useState(detail?.triggers || '')
  const [body, setBody] = useState(detail?.body || SKILL_BODY_TEMPLATE)
  const [saving, setSaving] = useState(false)
  const builtinNames = useRef<Set<string>>(new Set())

  useEffect(() => {
    void getSkills()
      .then((list) => builtinNames.current = new Set(list.filter((s) => s.source === 'builtin').map((s) => s.name)))
      .catch(() => {})
  }, [])

  const slugify = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)

  const submit = async () => {
    const finalName = slugify(name)
    if (!finalName) {
      onError('请填写技能标识（小写字母/数字/中划线）')
      return
    }
    setSaving(true)
    try {
      if (mode === 'edit' && detail) {
        await updateSkill({ name: detail.name, nextName: finalName, title, description, triggers, body })
      } else {
        await createSkill({ name: finalName, title, description, triggers, body })
      }
      onSaved()
    } catch (e) {
      onError(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  const overridesBuiltin = builtinNames.current.has(slugify(name)) && !(mode === 'edit' && detail?.name === slugify(name))

  return (
    <div className="content skill-form">
      {mode === 'fork' && <div className="hint" style={{ marginBottom: 4 }}>正在从内置技能复制一份到「我的技能」，改完保存即可（同名会覆盖内置版本）。</div>}
      <div className="grid2">
        <div className="field">
          <label>技能标识（文件夹名，小写字母/数字/中划线）</label>
          <input
            autoFocus
            value={name}
            placeholder="my-skill"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setName((v) => slugify(v))}
          />
        </div>
        <div className="field">
          <label>标题（列表里显示的名字）</label>
          <input value={title} placeholder="例如：小红书封面" onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>描述（agent 判断何时使用）</label>
        <input
          value={description}
          placeholder="一句话说明这个技能做什么、怎么触发"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field">
        <label>触发词（逗号分隔）</label>
        <input value={triggers} placeholder="封面, 小红书, 配图" onChange={(e) => setTriggers(e.target.value)} />
      </div>
      <div className="field">
        <label>技能内容（markdown，正文即 agent 的工作流指令）</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} className="skill-body-input" />
      </div>
      {overridesBuiltin && (
        <div className="hint skill-override-hint">
          与内置技能同名：保存后你的版本优先生效（内置版被覆盖）。
        </div>
      )}
      <div className="skill-form-foot">
        <button onClick={onCancel}>取消</button>
        <button className="primary" disabled={saving} onClick={() => void submit()}>
          {saving ? '保存中…' : '保存技能'}
        </button>
      </div>
    </div>
  )
}

/**
 * P4: the old 232px sidebar (brand + nav + grouped project list + batch bar) collapsed
 * into a 48px icon rail, so ALL project management — open, create, search/sort,
 * group/pin/rename/delete, batch delete — lives here in the library view.
 */
function LibraryView({
  projects,
  onOpen,
  onNew,
  isCurrent,
  onRenamed,
  onDeleted,
  onChanged,
  onError
}: {
  projects: ProjectInfo[]
  onOpen: (p: ProjectInfo) => void
  onNew: () => void
  isCurrent: (p: ProjectInfo) => boolean
  onRenamed: (updated: ProjectInfo) => void
  onDeleted: (wasCurrent: boolean) => void
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const [filter, setFilter] = useState<'all' | 'pinned' | 'ungrouped' | 'grouped'>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'created' | 'name'>('created')
  const [menu, setMenu] = useState<{ p: ProjectInfo; view: 'root' | 'move'; x: number; y: number } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ g: string; x: number; y: number } | null>(null)
  const [renameModal, setRenameModal] = useState<{ p: ProjectInfo; draft: string } | null>(null)
  const [deleteModal, setDeleteModal] = useState<ProjectInfo | null>(null)
  const [groupRenameModal, setGroupRenameModal] = useState<{ from: string; name: string } | null>(null)
  const [groupDissolve, setGroupDissolve] = useState<string | null>(null)
  const [newGroupFor, setNewGroupFor] = useState<ProjectInfo | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const groupMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu && !groupMenu) return
    const close = (e: MouseEvent) => {
      if (menu && menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
      if (groupMenu && groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) setGroupMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu, groupMenu])

  const shown = useMemo(() => {
    let list = projects
    if (filter === 'pinned') list = list.filter((p) => p.pinned)
    if (filter === 'ungrouped') list = list.filter((p) => !p.pinned && !p.group)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q))
    return [...list].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.createdAt.localeCompare(a.createdAt)
    )
  }, [projects, filter, query, sort])

  const groupEntries = useMemo(() => {
    const m = new Map<string, ProjectInfo[]>()
    for (const p of shown) {
      const g = p.group || '未分组'
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(p)
    }
    return [...m.entries()].sort((a, b) => (a[0] === '未分组' ? 1 : b[0] === '未分组' ? -1 : a[0].localeCompare(b[0])))
  }, [shown])

  const groupNames = useMemo(
    () => [...new Set(projects.map((p) => p.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
    [projects]
  )

  const toggleSelected = (id: string) =>
    setSelectedIds((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const openMenuAt = (p: ProjectInfo, e: React.MouseEvent) => {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ p, view: 'root', x: Math.min(r.left, window.innerWidth - 190), y: Math.min(r.bottom + 4, window.innerHeight - 250) })
  }

  const actPin = async (p: ProjectInfo) => {
    setMenu(null)
    try {
      await setProjectPinApi(p.path, !p.pinned)
      onChanged()
    } catch (e) {
      onError(String((e as Error).message || e))
    }
  }
  const actMove = async (p: ProjectInfo, g: string | null) => {
    setMenu(null)
    try {
      await setProjectGroupApi(p.path, g)
      onChanged()
    } catch (e) {
      onError(String((e as Error).message || e))
    }
  }
  const actCopy = async (p: ProjectInfo) => {
    setMenu(null)
    try {
      await navigator.clipboard.writeText(p.path)
    } catch {
      onError('复制失败')
    }
  }
  const actDelete = async () => {
    if (!deleteModal) return
    const was = isCurrent(deleteModal)
    setDeleteModal(null)
    try {
      await deleteProject(deleteModal.path)
      onDeleted(was)
    } catch (e) {
      onError(String((e as Error).message || e))
    }
  }
  const commitRename = async () => {
    if (!renameModal) return
    const name = renameModal.draft.trim()
    if (!name || name === renameModal.p.name) return setRenameModal(null)
    const p = renameModal.p
    setRenameModal(null)
    try {
      const updated = await renameProject(p.path, name)
      onRenamed(updated)
    } catch (e) {
      onError(String((e as Error).message || e))
    }
  }
  const batchDelete = async () => {
    const paths = projects.filter((p) => selectedIds.has(p.id)).map((p) => p.path)
    const wasCurrent = paths.length > 0 && projects.some((p) => selectedIds.has(p.id) && isCurrent(p))
    setBatchConfirm(false)
    setSelectMode(false)
    setSelectedIds(new Set())
    try {
      const r = await deleteProjectsBatchApi(paths)
      onDeleted(wasCurrent)
      if (r.failed.length) onError(`${r.failed.length} 个项目删除失败：${r.failed[0].error}`)
    } catch (e) {
      onError(String((e as Error).message || e))
    }
  }

  const card = (p: ProjectInfo) => (
    <div
      key={p.id}
      className={`lib-card ${selectMode && selectedIds.has(p.id) ? 'selecting' : ''}`}
      title={p.path}
      onClick={() => (selectMode ? toggleSelected(p.id) : onOpen(p))}
    >
      <div className={`lib-cover tint-${tintOf(p)}`}>
        <span className="lib-initial">{(p.name || '?').slice(0, 1).toUpperCase()}</span>
        {p.pinned && !selectMode && (
          <span className="lib-pin">
            <Icon name="pin" size={12} />
          </span>
        )}
        {selectMode ? (
          <input
            type="checkbox"
            className="proj-check lib-check"
            checked={selectedIds.has(p.id)}
            readOnly
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelected(p.id)}
          />
        ) : (
          <button className="lib-more" title="更多操作" onClick={(e) => openMenuAt(p, e)}>
            ⋯
          </button>
        )}
      </div>
      <div className="lib-name">{p.name}</div>
      <div className="lib-meta">
        {p.group ? `${p.group} · ` : ''}
        {new Date(p.createdAt).toLocaleDateString('zh-CN')}
      </div>
    </div>
  )

  return (
    <div className="library">
      <div className="library-head">
        <div className="library-titles">
          <span className="title">项目库</span>
          <span className="subtitle">整理创作页面、管理项目</span>
        </div>
        <button className="btn-dark" onClick={onNew}>
          <Icon name="plus" size={14} /> 新建项目
        </button>
      </div>
      <div className="library-toolbar">
        <div className="seg">
          {([['all', '全部'], ['pinned', '置顶'], ['ungrouped', '未分组'], ['grouped', '分组']] as const).map(([id, label]) => (
            <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="lib-search">
          <Icon name="search" size={14} />
          <input placeholder="搜索项目" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="lib-sort">
          <Icon name="arrowUpDown" size={14} />
          <select value={sort} onChange={(e) => setSort(e.target.value as 'created' | 'name')}>
            <option value="created">最近创建</option>
            <option value="name">按名称</option>
          </select>
        </div>
        <button
          className={`lib-manage ${selectMode ? 'active' : ''}`}
          title="批量管理（勾选后删除）"
          onClick={() => {
            setSelectMode((v) => !v)
            setSelectedIds(new Set())
          }}
        >
          批量管理
        </button>
      </div>
      {selectMode && (
        <div className="lib-bar">
          <span className="sel-info">已选 {selectedIds.size} 项</span>
          <button onClick={() => setSelectedIds(new Set(shown.map((p) => p.id)))} disabled={selectedIds.size === shown.length}>
            全选
          </button>
          <button className="danger" disabled={selectedIds.size === 0} onClick={() => setBatchConfirm(true)}>
            删除所选
          </button>
          <button
            onClick={() => {
              setSelectMode(false)
              setSelectedIds(new Set())
            }}
          >
            取消
          </button>
        </div>
      )}
      {filter === 'grouped' ? (
        <div className="lib-groups">
          {groupEntries.map(([g, items]) => (
            <div key={g} className="lib-group-block">
              <div className="lib-group-head">
                <span className="group-title">{g}</span>
                <span className="group-count">{items.length}</span>
                {g !== '未分组' && (
                  <button
                    className="lib-more inline"
                    title="分组操作"
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setGroupMenu({ g, x: Math.min(r.left, window.innerWidth - 190), y: r.bottom + 4 })
                    }}
                  >
                    ⋯
                  </button>
                )}
              </div>
              <div className="library-grid">
                {selectMode ? null : (
                  <button className="lib-card new" onClick={onNew}>
                    <div className="lib-new-plus">＋</div>
                    <div className="lib-new-label">新建项目</div>
                  </button>
                )}
                {items.map(card)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="library-grid">
          {!selectMode && (
            <button className="lib-card new" onClick={onNew}>
              <div className="lib-new-plus">＋</div>
              <div className="lib-new-label">新建项目</div>
            </button>
          )}
          {shown.map(card)}
        </div>
      )}
      {shown.length === 0 && (
        <div className="library-empty">
          <div className="empty-ico">
            <Icon name={projects.length === 0 ? 'folderPlus' : 'search'} size={22} />
          </div>
          <div className="library-empty-title">
            {projects.length === 0 ? '还没有项目' : '没有匹配的项目'}
          </div>
          <div className="hint">
            {projects.length === 0 ? '点右上角「新建项目」，或回首页直接开始创作' : '换个关键词或切换筛选条件试试'}
          </div>
        </div>
      )}

      {menu && (
        <div className="menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menu.view === 'root' ? (
            <>
              <div className="menu-item" onClick={() => { const p = menu.p; setMenu(null); onOpen(p) }}>
                <Icon name="box" size={14} /> 打开
              </div>
              <div className="menu-item" onClick={() => { const p = menu.p; setMenu(null); setRenameModal({ p, draft: p.name }) }}>
                <Icon name="pencil" size={14} /> 重命名
              </div>
              <div className="menu-item" onClick={() => void actCopy(menu.p)}>
                <Icon name="copy" size={14} /> 复制路径
              </div>
              <div className="menu-item" onClick={() => void actPin(menu.p)}>
                <Icon name="pin" size={14} /> {menu.p.pinned ? '取消置顶' : '置顶'}
              </div>
              <div className="menu-item" onClick={() => setMenu({ ...menu, view: 'move' })}>
                <Icon name="folder" size={14} /> 移动到分组 <span style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>›</span>
              </div>
              <div className="menu-item danger" onClick={() => { const p = menu.p; setMenu(null); setDeleteModal(p) }}>
                <Icon name="trash" size={14} /> 删除
              </div>
            </>
          ) : (
            <>
              <div className="menu-item" onClick={() => setMenu({ ...menu, view: 'root' })}>
                ‹ 返回
              </div>
              <div className="menu-item" onClick={() => void actMove(menu.p, null)}>
                未分组
              </div>
              {groupNames
                .filter((g) => g !== menu.p.group)
                .map((g) => (
                  <div key={g} className="menu-item" onClick={() => void actMove(menu.p, g)}>
                    {g}
                  </div>
                ))}
              <div
                className="menu-item"
                onClick={() => {
                  const p = menu.p
                  setMenu(null)
                  setNewGroupName('')
                  setNewGroupFor(p)
                }}
              >
                ＋ 新建分组…
              </div>
            </>
          )}
        </div>
      )}

      {groupMenu && (
        <div className="menu" ref={groupMenuRef} style={{ left: groupMenu.x, top: groupMenu.y }}>
          <div
            className="menu-item"
            onClick={() => {
              const g = groupMenu.g
              setGroupMenu(null)
              setGroupRenameModal({ from: g, name: g })
            }}
          >
            <Icon name="pencil" size={14} /> 重命名分组
          </div>
          <div
            className="menu-item danger"
            onClick={() => {
              const g = groupMenu.g
              setGroupMenu(null)
              setGroupDissolve(g)
            }}
          >
            <Icon name="trash" size={14} /> 解散分组
          </div>
        </div>
      )}

      {renameModal && (
        <div className="modal-mask" onClick={() => setRenameModal(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <header>重命名项目</header>
            <div className="content">
              <div className="field">
                <label>项目名称</label>
                <input autoFocus value={renameModal.draft} onChange={(e) => setRenameModal({ ...renameModal, draft: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void commitRename() }} />
              </div>
            </div>
            <footer>
              <button onClick={() => setRenameModal(null)}>取消</button>
              <button className="primary" onClick={() => void commitRename()}>
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {deleteModal && (
        <div className="modal-mask" onClick={() => setDeleteModal(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <header>删除项目</header>
            <div className="content">
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                确定删除项目 <strong>{deleteModal.name}</strong> 吗？
                <br />
                <span className="hint">整个项目文件夹（含画布与素材）将移入系统回收站，可手动恢复。</span>
              </div>
            </div>
            <footer>
              <button onClick={() => setDeleteModal(null)}>取消</button>
              <button className="danger" onClick={() => void actDelete()}>
                删除
              </button>
            </footer>
          </div>
        </div>
      )}

      {groupRenameModal && (
        <div className="modal-mask" onClick={() => setGroupRenameModal(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <header>重命名分组</header>
            <div className="content">
              <div className="field">
                <label>分组名称</label>
                <input
                  autoFocus
                  value={groupRenameModal.name}
                  onChange={(e) => setGroupRenameModal({ ...groupRenameModal, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void renameGroupApi(groupRenameModal.from, groupRenameModal.name)
                        .then(() => {
                          setGroupRenameModal(null)
                          onChanged()
                        })
                        .catch((err) => onError(String((err as Error).message || err)))
                    }
                  }}
                />
              </div>
            </div>
            <footer>
              <button onClick={() => setGroupRenameModal(null)}>取消</button>
              <button
                className="primary"
                onClick={() => {
                  void renameGroupApi(groupRenameModal.from, groupRenameModal.name)
                    .then(() => {
                      setGroupRenameModal(null)
                      onChanged()
                    })
                    .catch((err) => onError(String((err as Error).message || err)))
                }}
              >
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {groupDissolve && (
        <div className="modal-mask" onClick={() => setGroupDissolve(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <header>解散分组</header>
            <div className="content">
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                解散分组 <strong>{groupDissolve}</strong>？分组内项目将变为「未分组」，项目本身不受影响。
              </div>
            </div>
            <footer>
              <button onClick={() => setGroupDissolve(null)}>取消</button>
              <button
                className="danger"
                onClick={() => {
                  void removeGroupApi(groupDissolve)
                    .then(() => {
                      setGroupDissolve(null)
                      onChanged()
                    })
                    .catch((err) => onError(String((err as Error).message || err)))
                }}
              >
                解散
              </button>
            </footer>
          </div>
        </div>
      )}

      {newGroupFor && (
        <div className="modal-mask" onClick={() => setNewGroupFor(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <header>新建分组</header>
            <div className="content">
              <div className="field">
                <label>将「{newGroupFor.name}」移入新分组</label>
                <input
                  autoFocus
                  placeholder="分组名称，如：品牌项目"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newGroupName.trim()) {
                      void setProjectGroupApi(newGroupFor.path, newGroupName.trim())
                        .then(() => {
                          setNewGroupFor(null)
                          onChanged()
                        })
                        .catch((err) => onError(String((err as Error).message || err)))
                    }
                  }}
                />
              </div>
            </div>
            <footer>
              <button onClick={() => setNewGroupFor(null)}>取消</button>
              <button
                className="primary"
                disabled={!newGroupName.trim()}
                onClick={() => {
                  void setProjectGroupApi(newGroupFor.path, newGroupName.trim())
                    .then(() => {
                      setNewGroupFor(null)
                      onChanged()
                    })
                    .catch((err) => onError(String((err as Error).message || err)))
                }}
              >
                创建并移入
              </button>
            </footer>
          </div>
        </div>
      )}

      {batchConfirm && (
        <div className="modal-mask" onClick={() => setBatchConfirm(false)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <header>批量删除</header>
            <div className="content">
              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                确定删除选中的 <strong>{selectedIds.size}</strong> 个项目吗？
                <br />
                <span className="hint">项目文件夹将移入系统回收站，可手动恢复。</span>
              </div>
            </div>
            <footer>
              <button onClick={() => setBatchConfirm(false)}>取消</button>
              <button className="danger" onClick={() => void batchDelete()}>
                删除
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}


const KIND_ICON: Record<AgentTask['kind'], string> = { video: 'video', image: 'image', audio: 'mic', music: 'music' }
const TASK_STATUS_LABEL: Record<AgentTask['status'], string> = {
  running: '进行中',
  completed: '完成',
  failed: '失败',
  interrupted: '中断'
}

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m${String(s).padStart(2, '0')}s` : `${m}m`
}

/**
 * Home = workspace, not a marketing hero: command bar up top, live cross-project
 * task queue (generations take 1-10 min and keep running while you browse),
 * recent projects strip, and inspiration cards demoted to a reference row.
 */
function HomeView({
  projects,
  tasks,
  model,
  onStart,
  onOpenProject,
  onOpenModels,
  onOpenSkills
}: {
  projects: ProjectInfo[]
  tasks: AgentTask[]
  model?: string
  onStart: (text: string) => void
  onOpenProject: (p: ProjectInfo) => void
  onOpenModels: (e: React.MouseEvent) => void
  onOpenSkills: () => void
}) {
  const [text, setText] = useState('')
  const [, tick] = useState(0)
  const hasRunning = tasks.some((t) => t.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const h = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(h)
  }, [hasRunning])

  const submit = () => {
    const t = text.trim()
    if (!t) return
    onStart(t)
  }
  const nameFor = (dir: string) =>
    projects.find((p) => p.path === dir)?.name ?? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
  const recent = [...projects].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8)

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-brand">
          <img className="logo-img" src={logoH} alt="" />
          <span className="name">Entropy Design</span>
          <span className="sub">视频优先的多模态 Agent 工作台 · 接你自己的 API</span>
        </div>

        <div className="cmd-bar">
          <textarea
            rows={1}
            placeholder="给 agent 一句话：视频 / 分镜 / 海报 / 旁白…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button className="composer-tool" title="选择视频 / 图像 / 语音 / LLM 模型" onClick={(e) => onOpenModels(e)}>
            <Icon name="box" size={15} strokeWidth={1.5} />
            <span className="composer-label">{model || '模型'}</span>
          </button>
          <button className="composer-tool" title="Skill 技能库" onClick={onOpenSkills}>
            <Icon name="skill" size={15} strokeWidth={1.5} />
            <span className="composer-label">Skill</span>
          </button>
          <button className="send-circle" onClick={submit} disabled={!text.trim()} title="开始（Enter）">
            <Icon name="arrowUp" size={15} strokeWidth={2} />
          </button>
        </div>

        {tasks.length > 0 && (
          <div className="home-section">
            <div className="section-label">任务队列</div>
            <div className="task-list">
              {tasks.slice(0, 10).map((t) => {
                const proj = projects.find((p) => p.path === t.projectDir)
                const live = Math.max(0, Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000))
                return (
                  <button
                    key={t.taskId}
                    className={`task-row ${t.status}`}
                    disabled={!proj}
                    onClick={() => proj && onOpenProject(proj)}
                    title={t.error || t.prompt}
                  >
                    <span className="t-ico">
                      <Icon name={KIND_ICON[t.kind] ?? 'box'} size={15} />
                    </span>
                    <span className="t-prompt">{t.prompt || t.kind}</span>
                    <span className="t-proj">{nameFor(t.projectDir)}</span>
                    {(t.provider || t.model) && (
                      <span className="t-model">{[t.provider, t.model].filter(Boolean).join(' · ')}</span>
                    )}
                    <span className="t-st">
                      <span className="t-dot" />
                      {TASK_STATUS_LABEL[t.status]}
                      {t.status === 'running' ? ` ${fmtElapsed(live)}` : t.seconds != null ? ` ${fmtElapsed(t.seconds)}` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="home-section">
            <div className="section-label">最近项目</div>
            <div className="proj-strip">
              {recent.map((p) => (
                <button key={p.id} className="strip-card" onClick={() => onOpenProject(p)}>
                  <div className="s-name">{p.name}</div>
                  <div className="s-meta">{new Date(p.createdAt).toLocaleDateString('zh-CN')}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="home-section">
          <div className="section-label">灵感模板 · 点击填入</div>
          <div className="cards-row">
            {INSPIRATION_CARDS.map((c) => (
              <button key={c.label} className="insp-card" onClick={() => setText(c.prompt)}>
                <div className={`cover tint-${c.tint}`}>
                  <span className="cover-ico">
                    <Icon name={c.icon} size={26} strokeWidth={1.6} />
                  </span>
                  <span className="tag">{c.tag}</span>
                  <span className="cover-arrow">→</span>
                </div>
                <div className="label">{c.label}</div>
                <div className="desc">{c.prompt}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="hint" style={{ marginTop: 28 }}>
          Enter 直接开始（自动创建新项目）· 视频生成需 1-10 分钟，可随时回首页查看任务队列
        </div>
      </div>
    </div>
  )
}
