import { create } from 'zustand'
import type { ProjectInfo } from '@shared/types'
import { getProjects } from '../api'

/**
 * Project list domain (P1-1 slice 1 of the App.tsx decomposition). Actions are
 * referentially stable, so they are safe in hook dependency arrays anywhere.
 */
interface ProjectsState {
  projects: ProjectInfo[]
  /** Re-fetch the workspace listing; failures keep the last good list. */
  refresh: () => void
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  refresh: () => {
    void getProjects()
      .then((projects) => set({ projects }))
      .catch(() => {})
  }
}))
