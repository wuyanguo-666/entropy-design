declare global {
  interface Window {
    entropy: { getServerPort: () => Promise<number>; getApiToken: () => Promise<string> }
  }
}

export const port = await window.entropy.getServerPort()
export const base = `http://127.0.0.1:${port}`
/** One-time token of this run; main gates every API endpoint and the WS socket on it. */
export const apiToken = await window.entropy.getApiToken()

import type { AgentTask, CanvasDocument, ExecutionPlan, ProjectInfo, Settings } from '@shared/types'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-ed-token': apiToken, ...(init?.headers || {}) }
  })
  const body = await res.text()
  const data = body ? JSON.parse(body) : null
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data as T
}

/** Fire-and-forget renderer error forwarding into the main-process log file. */
export function sendRendererLog(level: 'info' | 'warn' | 'error', scope: string, msg: string): void {
  void api('/api/log', { method: 'POST', body: JSON.stringify({ level, scope, msg }) }).catch(() => {})
}

export const getProjects = () => api<ProjectInfo[]>('/api/projects')
export const createProject = (name: string) =>
  api<ProjectInfo>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) })
export const openProjectDialog = () =>
  api<ProjectInfo | null>('/api/projects/open', { method: 'POST', body: '{}' })
export const renameProject = (path: string, name: string) =>
  api<ProjectInfo>('/api/projects/rename', { method: 'POST', body: JSON.stringify({ path, name }) })
export const deleteProject = (path: string) =>
  api<{ ok: boolean }>('/api/projects/delete', { method: 'POST', body: JSON.stringify({ path }) })
export const getCanvas = (path: string) =>
  api<CanvasDocument>(`/api/canvas?path=${encodeURIComponent(path)}`)
export const getPlan = (path: string) =>
  api<ExecutionPlan | null>(`/api/plan?path=${encodeURIComponent(path)}`)
export const putCanvas = (path: string, doc: CanvasDocument) =>
  api<{ ok: boolean }>(`/api/canvas?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify(doc)
  })
export const putSelection = (path: string, nodeIds: string[]) =>
  api<{ ok: boolean }>(`/api/canvas/selection?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ nodeIds })
  })
export const getSettings = () => api<Settings>('/api/settings')
export const putSettings = (s: Partial<Settings>) =>
  api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) })
export const fetchModels = (baseURL: string, apiKey: string) =>
  api<{ models?: string[]; error?: string }>('/api/llm/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ baseURL, apiKey })
  })
export const setProjectGroupApi = (path: string, group: string | null) =>
  api<ProjectInfo>('/api/projects/group', { method: 'POST', body: JSON.stringify({ path, group }) })
export const setProjectPinApi = (path: string, pinned: boolean) =>
  api<ProjectInfo>('/api/projects/pin', { method: 'POST', body: JSON.stringify({ path, pinned }) })
export const renameGroupApi = (from: string, to: string) =>
  api<{ updated: number }>('/api/projects/group-rename', { method: 'POST', body: JSON.stringify({ from, to }) })
export const removeGroupApi = (name: string) =>
  api<{ updated: number }>('/api/projects/group-remove', { method: 'POST', body: JSON.stringify({ name }) })
export const deleteProjectsBatchApi = (paths: string[]) =>
  api<{ deleted: string[]; failed: { path: string; error: string }[] }>('/api/projects/delete-batch', {
    method: 'POST',
    body: JSON.stringify({ paths })
  })
export const startAgent = (path: string) =>
  api<{ running: boolean; error?: string }>(`/api/agent/start`, {
    method: 'POST',
    body: JSON.stringify({ path })
  })
export const agentStatus = () => api<{ running: boolean; error?: string; sessionId: string | null }>('/api/agent/status')
export const sendAgent = (text: string) =>
  api<{ ok: boolean }>('/api/agent/send', { method: 'POST', body: JSON.stringify({ text }) })
export const abortAgent = () => api<{ ok: boolean }>('/api/agent/abort', { method: 'POST' })
export const getTasks = () => api<AgentTask[]>('/api/tasks')
export const getAgentHistory = () => api<unknown[]>('/api/agent/history')
export const openLogsFolder = () =>
  api<{ ok: boolean; error?: string }>('/api/logs/open-folder', { method: 'POST', body: '{}' })
export const checkForUpdates = () =>
  api<{ ok: boolean; error?: string; version?: string }>('/api/updater/check', { method: 'POST', body: '{}' })
export const answerQuestion = (id: string, answers: string[][], cancelled = false) =>
  api<{ ok: boolean }>('/api/agent/question/answer', {
    method: 'POST',
    body: JSON.stringify({ id, answers, cancelled })
  })

/** Upload an attachment into <project>/assets and place a canvas node (same as drag-drop import). */
export async function importAttachment(
  projectPath: string,
  fileName: string,
  file: File
): Promise<{ nodeId: string; file: string; type: string }> {
  const res = await fetch(
    `${base}/api/canvas/import?path=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(fileName)}`,
    { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-ed-token': apiToken } }
  )
  const data = await res.json()
  if (!res.ok) throw new Error((data as { error?: string })?.error || `HTTP ${res.status}`)
  return data as { nodeId: string; file: string; type: string }
}

/** Media URL for <img>/<video> tags — these cannot set headers, so the token rides in the query. */
export function fileUrl(absPath: string): string {
  return `${base}/files?path=${encodeURIComponent(absPath)}&token=${encodeURIComponent(apiToken)}`
}

export interface SkillInfo {
  name: string
  title: string
  description: string
  triggers: string
  source: 'user' | 'builtin'
  overrides?: 'builtin'
  path: string
  editable: boolean
}

export interface SkillDetail extends SkillInfo {
  body: string
}

export const getSkills = () => api<SkillInfo[]>('/api/skills')
export const openSkillsFolder = () => api<{ ok: boolean; error?: string }>('/api/skills/open-folder', { method: 'POST', body: '{}' })
export const createSkill = (s: { name: string; title: string; description: string; triggers: string; body: string }) =>
  api<{ ok: boolean; path: string }>('/api/skills', { method: 'POST', body: JSON.stringify(s) })
export const updateSkill = (s: { name: string; nextName?: string; title: string; description: string; triggers: string; body: string }) =>
  api<{ ok: boolean; path: string }>('/api/skills', { method: 'PUT', body: JSON.stringify(s) })
export const deleteSkill = (name: string) =>
  api<{ ok: boolean }>(`/api/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' })

/** 读取单个技能全文（编辑表单用）。 */
export const getSkillDetail = (name: string) => api<SkillDetail>(`/api/skills/detail?name=${encodeURIComponent(name)}`)

export function projectFileUrl(projectPath: string, relPath: string): string {
  return fileUrl(`${projectPath}/${relPath}`.replace(/\/+/g, '/'))
}
