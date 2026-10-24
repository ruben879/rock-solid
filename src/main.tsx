import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// The look someone picked (Classic or Clean), applied before the first paint.
try { document.documentElement.dataset.skin = localStorage.getItem('rs-skin') === 'clean' ? 'clean' : 'classic' } catch { /* private mode */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Lets the app open without a connection (and receive reminders). Only in the real build, not while developing.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
