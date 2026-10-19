// The three-legged stool (preview). Sphere comes from Rock Solid; the other two legs are planned and checked off here.
// Preview only: legs 2 and 3 are saved on this phone, not to the account yet.
import { useId, useState, type RefObject } from 'react'
import type { Profile } from '../lib/model'
import { cardCoverage } from '../lib/model'
import type { AgentData } from '../lib/data'
import { addDays, fmt, monthStart, today, weekStart, ymd } from '../lib/dates'
import { store, SwipeRow, useSwipeBack, useToast } from '../ui'
import { IChevL } from '../icons'

type Per = 'week' | 'month' | 'quarter' | 'half' | 'year'
interface Goal { id: string; name: string; target: number; per: Per }
interface Leg { id: string; name: string; preset: string | null; goals: Goal[] }
interface Saved {
  legs: Leg[]
  counts: Record<string, Record<string, number>>
  log: { leg: string; goal: string; note: string; day: string }[]
  /** Rolling goals (every 6 months, a year): the days you did them, and when the goal was set up. */
  done?: Record<string, string[]>
  created?: Record<string, string>
}
interface Shown { id: string; name: string; target: number; per: Per; count: number; auto?: boolean; roll?: Roll }
interface Roll { fill: number; due: string; state: 'good' | 'soon' | 'over'; last?: string }

// ---------- Rolling goals: every 6 months or once a year ----------
// The clock starts when you set the goal up (or last did it). The leg stays full until about 4 months
// before it's due, then drains toward the due date, so there's a nudge without a leg sitting empty all year.
const ROLL_DAYS: Partial<Record<Per, number>> = { half: 182, year: 365 }
const URGENT_DAYS = 122
const isRolling = (per: Per) => per in ROLL_DAYS
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000)
function rolling(per: Per, target: number, since: string, last?: string): Roll {
  const cycle = Math.round((ROLL_DAYS[per] ?? 365) / Math.max(1, target))
  const zone = Math.min(URGENT_DAYS, Math.round(cycle * 0.67))
  const t = ymd(today())
  const left = cycle - dayDiff(since, t)
  const fill = left >= zone ? 1 : Math.max(0, left / zone)
  return { fill, due: ymd(addDays(today(), left)), state: left <= 0 ? 'over' : left < zone ? 'soon' : 'good', last }
}

const PRESETS: Record<string, [string, number, Per][]> = {
  'Social media': [['Posts', 3, 'week'], ['Videos', 1, 'week'], ['Go live or stories', 2, 'week']],
  'Farming': [['Mailers out', 1, 'month'], ['Door knocking hours', 2, 'week'], ['Neighborhood event', 1, 'quarter'], ['Sponsored community event', 1, 'year']],
  'Open houses': [['Open houses held', 1, 'week'], ['Sign-ins followed up', 10, 'week']],
  'Cold calling': [['Dials', 100, 'week'], ['Conversations', 15, 'week'], ['Appointments set', 1, 'week']],
  'Past client events': [['Client event', 1, 'quarter'], ['Invites sent', 25, 'quarter']],
  'Builders and new construction': [['Model home visits', 2, 'week'], ['Builder rep coffees', 1, 'month']],
  'Expired and FSBO': [['Expireds called', 20, 'week'], ['FSBO visits', 3, 'week']],
}
const PER: Record<Per, string> = { week: 'a week', month: 'a month', quarter: 'a quarter', half: 'every 6 months', year: 'a year' }
const PER_NOW: Record<Per, string> = { week: 'this week', month: 'this month', quarter: 'this quarter', half: 'this half of the year', year: 'this year' }
const COLORS = ['var(--leg1)', 'var(--leg2)', 'var(--leg3)']
const gid = () => Math.random().toString(36).slice(2, 9)
const fromPreset = (preset: string, name?: string): Leg => ({ id: gid(), name: name ?? preset, preset, goals: PRESETS[preset].map(([n, t, p]) => ({ id: gid(), name: n, target: t, per: p })) })

function periodKey(per: Per) {
  const t = today()
  if (per === 'week') return ymd(weekStart())
  if (per === 'month') return ymd(monthStart()).slice(0, 7)
  if (per === 'half') return `${t.getFullYear()}-H${t.getMonth() < 6 ? 1 : 2}`
  if (per === 'year') return String(t.getFullYear())
  return `${t.getFullYear()}-Q${Math.floor(t.getMonth() / 3) + 1}`
}
const keyOf = (agentId: string) => `rs-stool-${agentId}`
/** Every goal remembers when it was set up, so a new yearly goal starts full. */
function stamp(v: Saved): Saved {
  const created = { ...(v.created ?? {}) }
  const t = ymd(today())
  for (const l of v.legs) for (const g of l.goals) if (!created[g.id]) created[g.id] = t
  return { ...v, created }
}
function loadSaved(agentId: string): Saved {
  return stamp(store.get<Saved | null>(keyOf(agentId), null) ?? { legs: [fromPreset('Farming', 'Ransom'), fromPreset('Social media', 'Socials')], counts: {}, log: [] })
}

/** Sphere, from what's already logged in Rock Solid. */
function sphereGoals(agent: Profile, data: AgentData): Shown[] {
  const ws = ymd(weekStart())
  const rocks = data.touches.filter((t) => !t.is_group && t.occurred_on >= ws).length
  const cov = cardCoverage(data.cards)
  let cardDays = 0
  for (let i = 0; i < 7; i++) if (cov.has(ymd(addDays(weekStart(), i)))) cardDays++
  const ms = ymd(monthStart())
  const news = data.tallies.filter((t) => (t.kind === 'email' || t.kind === 'newsletter') && t.month === ms).reduce((s, t) => s + t.count, 0)
  return [
    { id: 'rocks', name: 'Daily rocks', target: Math.max(1, agent.weekly_goal || 25), per: 'week', count: rocks, auto: true },
    { id: 'cards', name: 'Card a Day', target: 7, per: 'week', count: cardDays, auto: true },
    { id: 'news', name: 'Newsletter', target: 1, per: 'month', count: Math.min(news, 1), auto: true },
  ]
}

const pct = (g: Shown) => (g.roll ? g.roll.fill : Math.min(1, g.target ? g.count / g.target : 0))
const legPct = (gs: Shown[]) => (gs.length ? gs.reduce((s, g) => s + pct(g), 0) / gs.length : 0)

function useStool(agent: Profile, data: AgentData) {
  const [saved, setSaved] = useState<Saved>(() => loadSaved(agent.id))
  const save = (v: Saved) => { const x = stamp(v); setSaved(x); store.set(keyOf(agent.id), x) }
  const shown = (l: Leg): Shown[] => l.goals.map((g) => {
    if (isRolling(g.per)) {
      const done = saved.done?.[g.id] ?? []
      const last = done.at(-1)
      return { ...g, count: done.length, roll: rolling(g.per, g.target, last ?? saved.created?.[g.id] ?? ymd(today()), last) }
    }
    return { ...g, count: saved.counts[g.id]?.[periodKey(g.per)] ?? 0 }
  })
  const legs = [
    { id: 'sphere', name: 'Sphere', goals: sphereGoals(agent, data), fixed: true },
    ...saved.legs.map((l) => ({ id: l.id, name: l.name, goals: shown(l), fixed: false })),
  ]
  const p = legs.map((l) => legPct(l.goals))
  return { saved, save, legs, p }
}

// ---------- The stool drawing ----------
export function StoolArt({ p, names, onLeg }: { p: number[]; names: string[]; onLeg?: (i: number) => void }) {
  const uid = useId().replace(/:/g, '')
  const legs = [
    { pts: [[76, 82], [106, 88], [62, 236], [38, 233]], back: false },
    { pts: [[136, 92], [164, 92], [160, 216], [140, 216]], back: true },
    { pts: [[194, 88], [224, 82], [262, 233], [238, 236]], back: false },
  ]
  // Like a real stool: it stays planted on its longest front leg and tips toward the shorter one.
  const footL = 85 + 150 * p[0], footR = 85 + 150 * p[2]
  let tilt = (Math.atan2(footL - footR, 200) * 180) / Math.PI * 0.3
  tilt = Math.abs(tilt) < 0.6 ? 0 : Math.max(-7, Math.min(7, tilt))
  const pivot = p[0] >= p[2] ? 50 : 250
  // A short back leg tips it away from you: a little shorter, with less of the seat top showing.
  const back = Math.min(0.08, Math.max(0, (p[0] + p[2]) / 2 - p[1] - 0.05) * 0.25)
  const poly = (pts: number[][]) => pts.map((q) => q.join(',')).join(' ')
  const short = (n: string) => (n.length <= 10 ? n : n.split(' ')[0])
  const leg = (i: number) => {
    const L = legs[i]
    const top = Math.min(L.pts[0][1], L.pts[1][1]), bot = Math.max(L.pts[2][1], L.pts[3][1])
    const len = (bot - top) * p[i]
    const tx = (L.pts[0][0] + L.pts[1][0]) / 2, ty = (L.pts[0][1] + L.pts[1][1]) / 2
    const bx = (L.pts[2][0] + L.pts[3][0]) / 2, by = (L.pts[2][1] + L.pts[3][1]) / 2
    const mx = (tx + bx) / 2, my = (ty + by) / 2
    let ang = (Math.atan2(by - ty, bx - tx) * 180) / Math.PI
    if (ang > 90) ang -= 180
    return (
      <g key={i} className="st-leg" onClick={() => onLeg?.(i)}>
        <clipPath id={`stcl${uid}${i}`}><rect x="0" y={top - 4} width="300" height={len + 4} className="st-fill" /></clipPath>
        <polygon points={poly(L.pts)} fill="var(--st-empty)" stroke="var(--line)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
        <polygon points={poly(L.pts)} fill={COLORS[i]} clipPath={`url(#stcl${uid}${i})`} opacity={L.back ? 0.85 : 1} />
        <polygon points={poly(L.pts)} fill="url(#stgrain)" clipPath={`url(#stcl${uid}${i})`} />
        <text x={mx} y={my} transform={`rotate(${ang} ${mx} ${my})`} textAnchor="middle" dominantBaseline="central" className="st-txt">{short(names[i] ?? '')}</text>
      </g>
    )
  }
  return (
    <svg viewBox="0 0 300 256" className="st-svg" role="img" aria-label={`Your stool: ${names.map((n, i) => `${n} ${Math.round(p[i] * 100)} percent`).join(', ')}`}>
      <defs>
        <linearGradient id="stgrain" x1="0" x2="1"><stop offset="0" stopColor="#fff" stopOpacity=".22" /><stop offset=".45" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".18" /></linearGradient>
        <linearGradient id="stseat" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e2bd84" /><stop offset="1" stopColor="#b98a4e" /></linearGradient>
      </defs>
      <ellipse cx="150" cy="242" rx="122" ry="10" fill="var(--line)" opacity=".8" />
      <g className="st-seat" style={{ transformOrigin: `${pivot}px 236px`, transform: `rotate(${tilt}deg) scaleY(${1 - back})` }}>
        {leg(1)}{leg(0)}{leg(2)}
        <g className="st-top" style={{ transform: `scaleY(${1 - back * 2})` }}>
          <path d="M40 64 L40 80 A110 26 0 0 0 260 80 L260 64 Z" fill="#93683a" />
          <ellipse cx="150" cy="64" rx="110" ry="26" fill="url(#stseat)" />
          <ellipse cx="150" cy="64" rx="84" ry="18" fill="none" stroke="#8a5f30" strokeWidth="1.5" opacity=".6" />
          <ellipse cx="150" cy="64" rx="56" ry="11" fill="none" stroke="#8a5f30" strokeWidth="1.2" opacity=".45" />
        </g>
      </g>
    </svg>
  )
}

function message(p: number[], names: string[]) {
  const min = Math.min(...p)
  if (p.every((x) => x >= 0.999)) return ['Rock solid. Every leg reaches the floor.', 'Enjoy it. The plan resets on its own.']
  if (Math.max(...p) < 0.2) return ['Every leg is just getting started.', 'A few check-offs on each one gets you standing.']
  if (Math.max(...p) - min < 0.2) return ['Your stool is steady.', 'All three legs are moving together.']
  return [`Your ${names[p.indexOf(min)]} leg is short.`, 'A couple of check-offs there will level you out.']
}

/** Small card on Today that opens the full stool. */
export function MiniStool({ agent, data, onOpen }: { agent: Profile; data: AgentData; onOpen: () => void }) {
  const { legs, p } = useStool(agent, data)
  const names = legs.map((l) => l.name)
  return (
    <button className="card st-mini" onClick={onOpen}>
      <span className="st-mini-art"><StoolArt p={p} names={names} /></span>
      <span className="st-mini-txt">
        <span className="st-tag">Your three legs · preview</span>
        <b>{message(p, names)[0]}</b>
        <span className="st-pcts">{legs.map((l, i) => <span key={l.id}><i style={{ background: COLORS[i] }} />{l.name} {Math.round(p[i] * 100)}%</span>)}</span>
      </span>
    </button>
  )
}

/** The full stool: this week and the plan. */
export function StoolPage({ agent, data, onBack }: { agent: Profile; data: AgentData; onBack: () => void }) {
  const toast = useToast()
  const { saved, save, legs, p } = useStool(agent, data)
  const swipeRef = useSwipeBack(onBack)
  const [view, setView] = useState<'week' | 'plan'>('week')
  const [open, setOpen] = useState(0)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const names = legs.map((l) => l.name)
  const [m1, m2] = message(p, names)
  const L = legs[open]

  const bump = (g: Shown, d: number) => {
    if (g.roll) {
      // Did it: the clock restarts today and the leg fills back up. Minus undoes the last one.
      const list = saved.done?.[g.id] ?? []
      const next = d > 0 ? [...list, ymd(today())] : list.slice(0, -1)
      save({ ...saved, done: { ...(saved.done ?? {}), [g.id]: next } })
      if (d > 0) { setNoteFor(g.id); setNote(''); toast(`${g.name}: done. The clock restarts today.`) }
      return
    }
    const k = periodKey(g.per)
    const cur = saved.counts[g.id]?.[k] ?? 0
    const n = Math.max(0, cur + d)
    save({ ...saved, counts: { ...saved.counts, [g.id]: { ...(saved.counts[g.id] ?? {}), [k]: n } } })
    if (d > 0) { setNoteFor(g.id); setNote(''); toast(`${g.name}: ${n} of ${g.target} ${PER_NOW[g.per]}`) }
  }
  const saveNote = (legId: string, goalId: string) => {
    if (note.trim()) { save({ ...saved, log: [...saved.log, { leg: legId, goal: goalId, note: note.trim(), day: ymd(today()) }] }); toast('Note saved.') }
    setNoteFor(null)
  }
  const editLeg = (i: number, f: (l: Leg) => Leg) => save({ ...saved, legs: saved.legs.map((l, j) => (j === i ? f(l) : l)) })

  return (
    <section className="st" ref={swipeRef as RefObject<HTMLElement>}>
      <div className="roomhdr">
        <button className="iconbtn" aria-label="Back to Today" onClick={onBack}><IChevL /></button>
        <h2 style={{ margin: 0, fontSize: 21, flex: 1 }}>Your three legs</h2>
      </div>
      <p className="note st-pre">Preview, only you can see this. Sphere fills in from Rock Solid. Your other two legs save on this phone for now.</p>
      <div className="seg" role="group" aria-label="View">
        <button aria-pressed={view === 'week'} onClick={() => setView('week')}>This week</button>
        <button aria-pressed={view === 'plan'} onClick={() => setView('plan')}>My plan</button>
      </div>

      {view === 'week' ? (
        <>
          <div className="card st-card">
            <StoolArt p={p} names={names} onLeg={(i) => { setOpen(i); setNoteFor(null) }} />
            <p className="st-msg">{m1}<small>{m2}</small></p>
            <div className="st-labels">
              {legs.map((l, i) => (
                <button key={l.id} aria-pressed={open === i} onClick={() => { setOpen(i); setNoteFor(null) }}>
                  <i style={{ background: COLORS[i] }} /><b>{l.name}</b><span>{Math.round(p[i] * 100)}%</span>
                </button>
              ))}
            </div>
          </div>
          {L && (
            <div className="card st-legcard">
              <h3><i style={{ background: COLORS[open] }} />{L.name}</h3>
              <p className="note">{L.fixed ? 'From Rock Solid. These fill in as you log your people.' : 'Tap + when you do one. Add a note if you want to remember it.'}</p>
              {L.goals.map((g) => (
                <div key={g.id}>
                  <div className="st-goal">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{g.name}</b>
                      <small className={g.roll ? `st-due ${g.roll.state}` : undefined}>
                        {g.roll
                          ? g.roll.state === 'over' ? `${g.target} ${PER[g.per]} · overdue since ${fmt(g.roll.due)}`
                            : g.roll.state === 'soon' ? `${g.target} ${PER[g.per]} · due by ${fmt(g.roll.due)}`
                            : `${g.target} ${PER[g.per]} · ${g.roll.last ? `done ${fmt(g.roll.last)}, ` : ''}next by ${fmt(g.roll.due)}`
                          : `${g.target} ${PER[g.per]}`}
                      </small>
                      <div className="st-bar"><i style={{ width: `${pct(g) * 100}%`, background: COLORS[open] }} /></div>
                    </div>
                    {g.roll ? <span className="st-cnt">{g.roll.state === 'good' ? '✓' : g.roll.state === 'soon' ? <small>Soon</small> : <small>Due</small>}</span> : <span className="st-cnt">{g.count}<small>/{g.target}</small></span>}
                    {g.auto ? <span className="st-auto">from Today</span> : (
                      <span className="st-pm">
                        <button aria-label={`Take one off ${g.name}`} disabled={g.count <= 0} onClick={() => bump(g, -1)}>−</button>
                        <button className="plus" aria-label={`Add one to ${g.name}`} onClick={() => bump(g, 1)}>+</button>
                      </span>
                    )}
                  </div>
                  {noteFor === g.id && (
                    <form className="st-notebox" onSubmit={(e) => { e.preventDefault(); saveNote(L.id, g.id) }}>
                      <input aria-label="Note" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                      <button className="btn primary">Save</button>
                      <button type="button" className="btn ghost" onClick={() => setNoteFor(null)}>Skip</button>
                    </form>
                  )}
                </div>
              ))}
              {!L.fixed && saved.log.filter((x) => x.leg === L.id).length > 0 && (
                <div className="st-feed">
                  <div className="grp" style={{ margin: '12px 0 4px' }}>Notes</div>
                  {[...saved.log].reverse().filter((x) => x.leg === L.id).slice(0, 6).map((x, k) => (
                    <div key={k} className="hrow" style={{ alignItems: 'flex-start' }}>
                      <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: 500 }}>{L.goals.find((g) => g.id === x.goal)?.name ?? ''}</b><small>{x.note}</small></span>
                      <span className="note">{x.day.slice(5).replace('-', '/')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="stack">
          <div className="card stack">
            <b><i className="st-dot" style={{ background: COLORS[0] }} /> Leg 1: Sphere</b>
            <p className="note" style={{ margin: 0 }}>Always on. Daily rocks, Card a Day and your newsletter fill in from Rock Solid.</p>
          </div>
          {saved.legs.map((l, i) => (
            <div key={l.id} className="card stack">
              <b><i className="st-dot" style={{ background: COLORS[i + 1] }} /> Leg {i + 2}</b>
              <label className="field"><span>What is this leg?</span>
                <select value={l.preset ?? '__custom'} onChange={(e) => {
                  const v = e.target.value
                  editLeg(i, (x) => (v === '__custom' ? { ...x, preset: null, goals: [{ id: gid(), name: 'New goal', target: 1, per: 'week' }] } : { ...fromPreset(v, x.name), id: x.id }))
                }}>
                  {Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}
                  <option value="__custom">Something else</option>
                </select>
              </label>
              <label className="field"><span>Name it</span>
                <input value={l.name} onChange={(e) => editLeg(i, (x) => ({ ...x, name: e.target.value }))} onBlur={(e) => !e.target.value.trim() && editLeg(i, (x) => ({ ...x, name: 'My leg' }))} />
              </label>
              <span className="note">Goals</span>
              {l.goals.map((g) => (
                <SwipeRow key={g.id} label={g.name} onDelete={l.goals.length > 1 ? () => editLeg(i, (x) => ({ ...x, goals: x.goals.filter((y) => y.id !== g.id) })) : undefined}>
                  <div className="st-gedit">
                    <input aria-label="Goal name" value={g.name} onChange={(e) => editLeg(i, (x) => ({ ...x, goals: x.goals.map((y) => (y.id === g.id ? { ...y, name: e.target.value } : y)) }))} />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input aria-label="How many" inputMode="numeric" style={{ width: 70, textAlign: 'center' }} value={g.target} onChange={(e) => editLeg(i, (x) => ({ ...x, goals: x.goals.map((y) => (y.id === g.id ? { ...y, target: Math.max(1, parseInt(e.target.value, 10) || 1) } : y)) }))} />
                      <select aria-label="How often" style={{ flex: 1 }} value={g.per} onChange={(e) => editLeg(i, (x) => ({ ...x, goals: x.goals.map((y) => (y.id === g.id ? { ...y, per: e.target.value as Per } : y)) }))}>
                        {(Object.keys(PER) as Per[]).map((k) => <option key={k} value={k}>{PER[k]}</option>)}
                      </select>
                    </div>
                  </div>
                </SwipeRow>
              ))}
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => editLeg(i, (x) => ({ ...x, goals: [...x.goals, { id: gid(), name: 'New goal', target: 1, per: 'week' }] }))}>+ Add a goal</button>
            </div>
          ))}
          <p className="note">Three legs, on purpose: one or two and the stool falls over.</p>
        </div>
      )}
    </section>
  )
}
