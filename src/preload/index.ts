import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('entropy', {
  getServerPort: (): Promise<number> => ipcRenderer.invoke('server-port'),
  getApiToken: (): Promise<string> => ipcRenderer.invoke('server-token')
})
