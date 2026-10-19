import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type TouchEvent as RTouch } from 'react'
import type { Contact, Heat } from './lib/model'
import { HEAT_ICON, HEAT_NAME, heat, score, target, windowDays } from './lib/model'
import { fmt } from './lib/dates'
import { isOnline, onPending, pendingCount } from './lib/offline'

// ---------- Toasts ----------
type ToastAction = { label: string; run: () => void }
const ToastCtx = createContext<(msg: string, action?: ToastAction) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('')
  const [action, setAction] = useState<ToastAction | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string, a?: ToastAction) => {
    setMsg(m)
    setAction(a ?? null)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { setMsg(''); setAction(null) }, a ? 6000 : 2600)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
          {action && (
            <button className="toast-act" onClick={() => { const a = action; setMsg(''); setAction(null); a.run() }}>{action.label}</button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  )
}

// ---------- Bottom sheet ----------
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  // Swipe down to close: drag the sheet from its top (or anywhere when it's scrolled to the top).
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; t: number; on: boolean; d: number } | null>(null)
  const [dy, setDy] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const start = (e: RTouch) => {
    const el = panel.current
    const tag = (e.target as Element).closest('input, textarea, select, [contenteditable]')
    drag.current = !tag && el && el.scrollTop <= 0 ? { y: e.touches[0].clientY, t: Date.now(), on: false, d: 0 } : null
  }
  const move = (e: RTouch) => {
    const d = drag.current
    if (!d) return
    const dist = e.touches[0].clientY - d.y
    if (!d.on && dist > 8) d.on = true
    if (d.on) { d.d = Math.max(0, dist); setDy(d.d) }
  }
  const end = () => {
    const d = drag.current
    drag.current = null
    if (!d?.on) return
    const fast = d.d / Math.max(1, Date.now() - d.t) > 0.6
    if (d.d > 110 || (fast && d.d > 40)) { setLeaving(true); setTimeout(onClose, 180) } else setDy(0)
  }
  return (
    <div className="sheet" onClick={(e) => e.target === e.currentTarget && onClose()} style={dy || leaving ? { background: `rgba(15, 21, 38, ${leaving ? 0 : Math.max(0.1, 0.45 - dy / 800)})` } : undefined}>
      <div ref={panel} className={`in ${dy && !leaving ? 'dragging' : ''} ${leaving ? 'leaving' : ''}`} role="dialog" aria-label={label}
        style={dy && !leaving ? { transform: `translateY(${dy}px)` } : undefined}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}>
        <div className="grab" aria-hidden="true" />
        {children}
      </div>
    </div>
  )
}

// ---------- Thermometer ----------
export function HeatTag({ h, label }: { h: Heat; label?: boolean }) {
  return (
    <span className="tag">
      <span className="ic">
        <b>{HEAT_ICON[h]}</b>
      </span>
      {label && HEAT_NAME[h]}
    </span>
  )
}

export function Therm({ c, byContact, goal, sm }: { c: Contact; byContact: Map<string, string[]>; goal: number; sm?: boolean }) {
  const n = score(c, byContact)
  const t = target(c, goal)
  const h = heat(c, byContact, goal)
  const full = windowDays(c) >= 365
  const tip = full
    ? `${n} touches in the last 12 months, target ${goal}. ${HEAT_NAME[h]}.`
    : `${n} touches since added ${fmt(c.added_on)}, target ${Math.round(t)} so far. ${HEAT_NAME[h]}.`
  return (
    <span className={`therm h-${h} ${sm ? 'sm' : ''}`} title={tip} aria-label={tip}>
      <span className="bulb">{n}</span>
      <span className="tube">
        <span className="mercury" style={{ width: `${Math.min(100, (n / goal) * 100)}%` }} />
        {!full && <span className="pace" style={{ left: `${Math.min(100, (t / goal) * 100)}%` }} />}
      </span>
      <HeatTag h={h} label={!sm} />
    </span>
  )
}

export function HeatStack({ parts }: { parts: [number, number, number] }) {
  const [a, b, c] = parts
  return (
    <>
      <div className="heatstack" title={`${a}% on pace, ${b}% behind, ${c}% urgent`}>
        <span className="h-hot" style={{ width: `${a}%` }} />
        <span className="h-warm" style={{ width: `${b}%` }} />
        <span className="h-cold" style={{ width: `${c}%` }} />
      </div>
      <div className="note">
        {a}% on pace · {b}% behind · {c}% urgent
      </div>
    </>
  )
}

// ---------- Celebration ----------
export function Celebrate({ eyebrow, title, sub, onClose }: { eyebrow: string; title: string; sub: string; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    btn.current?.focus()
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    cv.width = innerWidth
    cv.height = innerHeight
    const cs = getComputedStyle(document.documentElement)
    const cols = ['--gold', '--navy-2', '--ok', '--behind', '--good'].map((v) => cs.getPropertyValue(v).trim())
    const bits = Array.from({ length: 140 }, (_, i) => ({
      x: cv.width / 2, y: cv.height * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 12 - 4,
      r: Math.random() * 6 + 4, c: cols[i % cols.length], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3,
    }))
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      ctx.clearRect(0, 0, cv.width, cv.height)
      for (const b of bits) {
        b.vy += 0.35; b.x += b.vx; b.y += b.vy; b.a += b.va
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.c; ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); ctx.restore()
      }
      if (t - t0 < 2600) raf = requestAnimationFrame(step)
      else ctx.clearRect(0, 0, cv.width, cv.height)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="cele" role="dialog" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <canvas ref={canvas} />
      <div className="in">
        <div className="eyebrow">{eyebrow}</div>
        <div className="big">{title}</div>
        <p>{sub}</p>
        <button ref={btn} className="btn gold lg" onClick={onClose}>
          Keep going
        </button>
      </div>
    </div>
  )
}

// ---------- Local storage that never throws ----------
export const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* storage unavailable */
    }
  },
}

// ---------- Signal bars ----------
const SIGNAL_WORD = ['Not reached yet', 'Gone cold', 'Getting cold', 'Cooling off', 'Warm', 'Strong']
export function Signal({ bars, plain, tone }: { bars: number; plain?: boolean; tone?: boolean }) {
  const h = bars >= 4 ? 'hot' : bars >= 2 ? 'warm' : bars === 1 ? 'cold' : 'new'
  // tone: colored like the status pills (3+ bars on schedule, 2 slipping, 1 overdue).
  const t = bars >= 3 ? 'on' : bars === 2 ? 'slip' : bars === 1 ? 'over' : 'none'
  return (
    <span className={`signal ${tone ? `t-${t}` : plain ? 'plain' : `h-${h}`}`} role="img" aria-label={`Signal ${bars} of 5: ${SIGNAL_WORD[bars]}`}>
      {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= bars ? 'on' : ''} style={{ height: `${4 + i * 3}px` }} />)}
    </span>
  )
}
export { SIGNAL_WORD }

// ---------- Pull down to refresh ----------
/** Pull down from the top of the page to reload the app (gets the latest data and the latest version). */
export function PullToRefresh() {
  const [pull, setPull] = useState(0)
  const [going, setGoing] = useState(false)
  useEffect(() => {
    let startY: number | null = null
    let dist = 0
    const blocked = (t: EventTarget | null) => t instanceof Element && !!t.closest('.sheet, .cele, .reach, input, textarea, select')
    const down = (e: TouchEvent) => {
      startY = window.scrollY <= 0 && !blocked(e.target) ? e.touches[0].clientY : null
      dist = 0
    }
    const move = (e: TouchEvent) => {
      if (startY === null) return
      dist = Math.max(0, e.touches[0].clientY - startY)
      if (window.scrollY > 0) { startY = null; dist = 0 }
      setPull(Math.min(dist, 120))
    }
    const up = () => {
      if (startY !== null && dist > 90) {
        setGoing(true)
        setTimeout(() => window.location.reload(), 150)
      } else setPull(0)
      startY = null
      dist = 0
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', up)
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
    }
  }, [])
  if (!going && pull < 20) return null
  const ready = pull > 90 || going
  return (
    <div className={`ptr ${going ? 'go' : ''}`} style={{ opacity: Math.min(1, pull / 90), transform: `translateY(${going ? 30 : pull / 3}px)` }} aria-hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ transform: going ? undefined : `rotate(${ready ? 180 : pull * 2}deg)` }}>
        <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />
      </svg>
    </div>
  )
}

// ---------- Offline / syncing notice ----------
export function OfflineBar() {
  const [online, setOnline] = useState(isOnline())
  const [pending, setPending] = useState(pendingCount())
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    const stop = onPending(setPending)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); stop() }
  }, [])
  if (online && !pending) return null
  const n = pending === 1 ? '1 change' : `${pending} changes`
  return (
    <div className="offbar" role="status">
      {!online
        ? pending ? `Offline. ${n} saved on your phone and will sync when you're back online.` : "Offline. You can keep working; changes sync when you're back online."
        : `Syncing ${n}…`}
    </div>
  )
}

// ----- A little rock for the Today progress row: faceted stones in five shapes. -----
const ROCKS: [string, string, string][] = [
  ['4,26 7,15 15,8 27,5 37,8 44,16 45,25 38,30 12,30', '7,15 15,8 27,5 37,8 30,14 16,15', '37,8 44,16 45,25 38,30 32,22 30,14'],
  ['3,25 6,17 13,10 22,8 30,6 40,10 45,19 43,27 35,30 10,30', '13,10 22,8 30,6 40,10 33,15 18,16', '40,10 45,19 43,27 35,30 30,23 33,15'],
  ['5,27 8,18 16,11 24,6 33,8 41,13 44,22 40,29 14,30', '16,11 24,6 33,8 41,13 31,16 19,17', '41,13 44,22 40,29 33,24 31,16'],
  ['4,24 9,14 19,9 31,8 40,12 45,20 42,28 30,30 11,30', '9,14 19,9 31,8 40,12 32,17 17,18', '40,12 45,20 42,28 34,25 32,17'],
  ['6,27 7,19 12,12 21,7 32,7 41,12 44,21 41,28 18,30', '12,12 21,7 32,7 41,12 31,16 18,16', '41,12 44,21 41,28 34,24 31,16'],
]
export function Rock({ i, on, ghost }: { i: number; on: boolean; ghost?: boolean }) {
  const [body, top, side] = ROCKS[i % ROCKS.length]
  const id = `rk${i}`
  const flip = i % 2 ? 'translate(48 0) scale(-1 1)' : undefined
  return (
    <svg className={`rock ${on ? 'on' : ''} ${ghost ? 'ghost' : ''}`} viewBox="0 0 48 34" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0.25" y2="1">
          <stop offset="0" className="rk-top" />
          <stop offset="1" className="rk-bot" />
        </linearGradient>
      </defs>
      <ellipse cx="24" cy="31.5" rx="19" ry="2.3" className="rk-ground" />
      <g transform={flip} strokeLinejoin="round">
        {ghost ? (
          <polygon points={body} className="rk-ghost" />
        ) : (
          <>
            <polygon points={body} fill={`url(#${id})`} stroke={`url(#${id})`} strokeWidth="2.5" />
            <polygon points={top} className="rk-lit" />
            <polygon points={side} className="rk-dark" />
          </>
        )}
      </g>
    </svg>
  )
}

// ---------- Swipe right to go back ----------
/**
 * On a page with a back arrow: drag the page to the right to go back. It follows your finger,
 * so you can change your mind and let it slide back. Returns a ref for the page's outer element.
 */
export function useSwipeBack(onBack?: () => void) {
  const ref = useRef<HTMLElement | null>(null)
  const back = useRef(onBack)
  back.current = onBack
  const on = !!onBack
  useEffect(() => {
    if (!on) return
    let s: { x: number; y: number; t: number; dir: 'h' | 'v' | null; dx: number } | null = null
    const skip = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, .sheet, .pcard, .swiperow')
    const set = (dx: number, anim: boolean) => {
      const el = ref.current
      if (!el) return
      el.style.transition = anim ? 'transform .22s ease, opacity .22s ease' : 'none'
      el.style.transform = dx ? `translateX(${dx}px)` : ''
      el.style.opacity = dx ? String(Math.max(0.35, 1 - dx / 700)) : ''
    }
    const down = (e: TouchEvent) => { s = skip(e.target) ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), dir: null, dx: 0 } }
    const move = (e: TouchEvent) => {
      if (!s) return
      const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y
      if (!s.dir && Math.abs(dx) + Math.abs(dy) > 10) s.dir = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v'
      if (s.dir === 'h') { s.dx = Math.max(0, dx); set(s.dx, false) }
    }
    const up = () => {
      if (!s || s.dir !== 'h') { s = null; return }
      const w = window.innerWidth
      const fast = s.dx / Math.max(1, Date.now() - s.t) > 0.5
      if (s.dx > w * 0.35 || (fast && s.dx > 60)) {
        set(w, true)
        setTimeout(() => { back.current?.(); set(0, false) }, 200)
      } else set(0, true)
      s = null
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', up)
    window.addEventListener('touchcancel', up)
    return () => {
      window.removeEventListener('touchstart', down); window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up); window.removeEventListener('touchcancel', up)
      set(0, false)
    }
  }, [on])
  return ref
}

/** A row that slides left to show a Delete button (touch). On a computer, a small × does the same. */
export function SwipeRow({ onDelete, children, label }: { onDelete?: () => void; children: ReactNode; label: string }) {
  const [x, setX] = useState(0)
  const st = useRef<{ x: number; y: number; base: number; dir: 'h' | 'v' | null } | null>(null)
  if (!onDelete) return <div className="swiperow">{children}</div>
  return (
    <div className="swiperow">
      <button className="swipedel" aria-label={`Delete ${label}`} onClick={onDelete} tabIndex={x ? 0 : -1}>Delete</button>
      <div className="swipefront" style={{ transform: x ? `translateX(${x}px)` : undefined, transition: st.current?.dir === 'h' ? 'none' : undefined }}
        onTouchStart={(e) => { st.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: x, dir: null } }}
        onTouchMove={(e) => {
          const s = st.current
          if (!s) return
          const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y
          if (!s.dir && Math.abs(dx) + Math.abs(dy) > 8) s.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
          if (s.dir === 'h') setX(Math.min(0, Math.max(-110, s.base + dx)))
        }}
        onTouchEnd={() => { const s = st.current; st.current = null; if (s?.dir === 'h') setX((v) => (v < -45 ? -88 : 0)) }}>
        {children}
        <button className="rowx" aria-label={`Delete ${label}`} onClick={onDelete}>×</button>
      </div>
    </div>
  )
}
