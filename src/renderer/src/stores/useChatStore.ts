import { create } from 'zustand'
import type { AgentEvent } from '@shared/agent-events'
import type { ChatMessage } from '@shared/types'

/**
 * Chat/agent transcript domain (P1-1 slice 3). msgMap lives at module scope —
 * it is the mutable event-accumulation buffer (SSE events arrive out of order:
 * parts can stream before message.updated), while `messages` is the derived,
 * render-ordered snapshot. All mutators end with rebuild().
 */

// ---- opencode event payload shapes (loose: versions differ in nesting) ----

interface PartLike {
  id?: string
  messageID?: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: { status?: string; title?: string }
  error?: { message?: string }
}

interface MessageLike {
  id?: string
  role?: string
  error?: { message?: string } | null
  info?: { id?: string; role?: string; error?: { message?: string } }
  parts?: PartLike[]
}

export interface AskUserQuestion {
  question: string
  options: string[]
  multiSelect?: boolean
}

export interface PendingQuestion {
  id: string
  questions: AskUserQuestion[]
}

const msgMap = new Map<string, ChatMessage>()

interface ChatState {
  messages: ChatMessage[]
  chatError: string | null
  running: boolean
  agentReady: boolean
  pendingQuestion: PendingQuestion | null
  setChatError: (v: string | null | ((prev: string | null) => string | null)) => void
  setRunning: (b: boolean) => void
  setAgentReady: (b: boolean) => void
  setPendingQuestion: (q: PendingQuestion | null) => void
  /** Clear transcript + in-flight flags (project switch / home). */
  reset: () => void
  /** Clear only the transcript buffer (leaving the project but keeping flags/errors). */
  clearMessages: () => void
  /** Reduce one agent SSE event into the transcript. */
  handleMessageEvent: (evt: AgentEvent) => void
  /** Backfill the session transcript from GET /api/agent/history items. */
  backfillHistory: (items: unknown[]) => void
  /** Optimistic local echo of a user send; real message supersedes it by text match. */
  echoUser: (text: string) => void
}

function rebuild(): ChatState['messages'] {
  const all = [...msgMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  // drop optimistic local echoes once the real user message with the same text arrived
  const realTexts = new Set(
    all.filter((m) => m.role === 'user' && !m.id.startsWith('local-')).map((m) => m.parts.find((p) => p.type === 'text')?.text)
  )
  return all.filter((m) => !(m.id.startsWith('local-') && realTexts.has(m.parts.find((p) => p.type === 'text')?.text)))
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  chatError: null,
  running: false,
  agentReady: false,
  pendingQuestion: null,

  setChatError: (v) =>
    set((s) => ({ chatError: typeof v === 'function' ? (v as (p: string | null) => string | null)(s.chatError) : v })),
  setRunning: (running) => set({ running }),
  setAgentReady: (agentReady) => set({ agentReady }),
  setPendingQuestion: (pendingQuestion) => set({ pendingQuestion }),

  reset: () => {
    msgMap.clear()
    set({ messages: [], chatError: null, running: false, agentReady: false, pendingQuestion: null })
  },

  clearMessages: () => {
    msgMap.clear()
    set({ messages: [] })
  },

  handleMessageEvent: (evt) => {
    const type = evt.type as string
    const props = (evt.properties || {}) as Record<string, unknown>
    const sync = () => set({ messages: rebuild() })

    if (type === 'session.idle') {
      set({ running: false })
      return
    }
    if (type === 'entropy.agent.stopped') {
      set({
        chatError: String(props.reason || 'agent 已停止'),
        running: false,
        agentReady: false,
        pendingQuestion: null
      })
      return
    }
    if (type === 'session.error') {
      const err = (props as { error?: { message?: string } }).error
      set({ chatError: err?.message || '会话错误' })
      return
    }
    if (type === 'message.updated') {
      // live events carry the message under properties.info, history under info — accept both shapes
      const msg = (props.message || props.info) as MessageLike | undefined
      const role = msg?.role || msg?.info?.role
      if (!msg?.id || !role) return
      const existing = msgMap.get(msg.id)
      if (!existing) {
        msgMap.set(msg.id, { id: msg.id, role: role as 'user' | 'assistant', parts: [] })
      } else {
        // role can arrive AFTER the part stream created the entry — always sync it
        if (existing.role !== role) existing.role = role as 'user' | 'assistant'
        if (msg.info?.error) {
          existing.error = msg.info.error.message || '生成失败'
        } else if (msg.error) {
          existing.error = (msg.error as { message?: string })?.message || '生成失败'
        }
      }
      sync()
      return
    }
    if (type === 'message.part.updated') {
      const part = props.part as PartLike | undefined
      if (!part?.messageID) return
      const mid = part.messageID
      let msg = msgMap.get(mid)
      if (!msg) {
        // parts can stream before message.updated carries the role: recognize the
        // user's own message by matching the optimistic local echo's text
        const echoed =
          part.type === 'text' &&
          [...msgMap.values()].find((m) => m.id.startsWith('local-') && m.role === 'user' && m.parts[0]?.text === (part.text || ''))
        msg = { id: mid, role: echoed ? 'user' : 'assistant', parts: [] }
        msgMap.set(mid, msg)
        if (echoed) msgMap.delete(echoed.id)
      }
      if (part.type === 'reasoning') return // internal thinking — never shown
      if (part.type === 'text') {
        if (part.synthetic) return
        const idx = msg.parts.findIndex((p) => p.id === part.id)
        const entry = { id: part.id, type: 'text' as const, text: part.text || '' }
        if (idx >= 0) msg.parts[idx] = entry
        else msg.parts.push(entry)
      } else if (part.type === 'tool') {
        const idx = msg.parts.findIndex((p) => p.id === part.id)
        const entry = {
          id: part.id,
          type: 'tool' as const,
          tool: part.tool || 'tool',
          state: part.state?.status || 'pending'
        }
        if (idx >= 0) msg.parts[idx] = entry
        else msg.parts.push(entry)
      }
      sync()
      return
    }
    if (type === 'message.part.removed') {
      const { messageID, partID } = props as { messageID: string; partID: string }
      const msg = msgMap.get(messageID)
      if (msg) {
        msg.parts = msg.parts.filter((p) => p.id !== partID)
        sync()
      }
    }
  },

  backfillHistory: (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      const info = ((item as MessageLike).info || item) as MessageLike
      const id = info.id || `hist-${Math.random()}`
      const role = ((info as { role?: string }).role || ((item as MessageLike).info ? 'assistant' : 'user')) as 'user' | 'assistant'
      const m: ChatMessage = { id, role, parts: [] }
      for (const part of (item as MessageLike).parts || []) {
        if (part.type === 'text' && !part.synthetic) {
          m.parts.push({ id: part.id, type: 'text', text: part.text || '' })
        } else if (part.type === 'tool') {
          // history parts are settled — default a missing status to completed (live stream defaults to pending)
          m.parts.push({
            id: part.id,
            type: 'tool',
            tool: part.tool || 'tool',
            state: part.state?.status || 'completed'
          })
        }
      }
      msgMap.set(id, m)
    }
    set({ messages: rebuild() })
  },

  echoUser: (text) => {
    const id = `local-${Date.now()}`
    msgMap.set(id, { id, role: 'user', parts: [{ id: `${id}-text`, type: 'text', text }] })
    set({ messages: rebuild(), chatError: null, running: true })
  }
}))
