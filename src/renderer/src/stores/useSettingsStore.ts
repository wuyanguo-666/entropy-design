import { create } from 'zustand'
import type { Settings } from '@shared/types'
import { getSettings } from '../api'

/**
 * Settings domain (P1-1 slice 2). Single source for the renderer; the WS
 * 'settings-changed' frame triggers refresh(), and dialogs push the saved
 * document through set() to avoid a redundant round-trip.
 */
interface SettingsState {
  settings: Settings | null
  refresh: () => void
  set: (s: Settings) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  refresh: () => {
    void getSettings()
      .then((settings) => set({ settings }))
      .catch(() => {})
  },
  set: (settings) => set({ settings })
}))
