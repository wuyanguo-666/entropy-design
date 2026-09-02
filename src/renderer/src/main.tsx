import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { sendRendererLog } from './api'
import App from './App'

// forward renderer crashes into the main-process log file (P0-1): without this a
// white screen leaves no trace, since renderer console output goes nowhere
window.addEventListener('error', (e) => {
  sendRendererLog('error', 'window', `${e.message} @ ${e.filename || 'inline'}:${e.lineno || 0}`)
})
window.addEventListener('unhandledrejection', (e) => {
  sendRendererLog('error', 'rejection', String((e.reason as Error)?.stack || e.reason))
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
