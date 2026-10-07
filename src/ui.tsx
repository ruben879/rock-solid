import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Contact, Heat } from './lib/model'
import { HEAT_ICON, HEAT_NAME, heat, score, target, windowDays } from './lib/model'
import { fmt } from './lib/dates'

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
  return (
    <div className="sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="in" role="dialog" aria-label={label}>
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
export function Signal({ bars, plain }: { bars: number; plain?: boolean }) {
  const h = bars >= 4 ? 'hot' : bars >= 2 ? 'warm' : bars === 1 ? 'cold' : 'new'
  return (
    <span className={`signal ${plain ? 'plain' : `h-${h}`}`} role="img" aria-label={`Signal ${bars} of 5: ${SIGNAL_WORD[bars]}`}>
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
