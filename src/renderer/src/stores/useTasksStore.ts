import { create } from 'zustand'
import type { AgentTask } from '@shared/types'
import { getTasks } from '../api'

/**
 * Home task-queue domain (P1-1 slice 1 of the App.tsx decomposition). Fed by
 * GET /api/tasks (full mirror, persisted across restarts) and by WS 'agent-task'
 * frames (single-task upserts). Newest first.
 */
interface TasksState {
  tasks: AgentTask[]
  refresh: () => void
  upsert: (t: AgentTask) => void
}

export const useTasksStore = create<TasksState>((set) => ({
  tasks: [],
  refresh: () => {
    void getTasks()
      .then((tasks) => set({ tasks }))
      .catch(() => {})
  },
  upsert: (t) =>
    set((s) => ({
      tasks: [t, ...s.tasks.filter((x) => x.taskId !== t.taskId)].sort((a, b) => b.startedAt - a.startedAt)
    }))
}))
