import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { EntryPage } from './views/enter'
import './styles.css'

// The look someone picked (Classic or Clean), applied before the first paint.
try { document.documentElement.dataset.skin = localStorage.getItem('rs-skin') === 'clean' ? 'clean' : 'classic' } catch { /* private mode */ }

// A public entry page (/enter/<token>) shows on its own: no sign-in, no app, no offline install.
const entry = location.pathname.match(/^\/enter\/([^/]+)\/?$/)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {entry ? <EntryPage token={decodeURIComponent(entry[1])} /> : <App />}
  </StrictMode>,
)

// Lets the app open without a connection (and receive reminders). Only in the real build, not while developing.
if (!entry && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
