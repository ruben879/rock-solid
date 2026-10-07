import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import * as api from '../lib/data'
import { addDays, daysBetween, fmt, monthStart, parse, today, weekStart, ymd } from '../lib/dates'
import type { Brokerage, Contact, Heat, Profile, Tier, Touch, TouchKind } from '../lib/model'
import {
  HEAT_NAME, KIND_LABEL, TIERS, TIER_NAMES, cardWithin12Months, duePool, fullName, heat, score, signal, suggestKind, telOf, tierDays, touchCounts,
} from '../lib/model'
import { planImport, readContacts } from '../lib/importer'
import { Celebrate, HeatTag, Sheet, Signal, store, useToast } from '../ui'
import { ICard, ICheck, IDoor, IFace, IFlame, IMore, IPhone, IPlus, ISearch, IText } from '../icons'

export type AgentTab = 'week' | 'cards' | 'activity' | 'db'

interface Ctx {
  me: Profile
  agent: Profile
  brokerage: Brokerage | null
  data: api.AgentData
  reload: () => Promise<void>
  readOnly: boolean
  goal: number
}

export function AgentWorkspace(props: { me: Profile; agent: Profile; brokerage: Brokerage | null; tab: AgentTab; readOnly: boolean; onProfileChange?: () => void; onGo?: (t: AgentTab) => void }) {
  const { data, error, reload } = useAgentData1(props.agent.id)
  if (error) return <p className="error" style={{ marginTop: 24 }}>Couldn't load your list: {error}. Pull down to refresh.</p>
  if (!data) return <p className="muted" style={{ marginTop: 24 }}>Loading…</p>
  const ctx: Ctx = { ...props, data, reload, goal: props.brokerage?.settings?.touch_goal ?? 36 }
  return (
    <>
      {props.tab === 'week' && <Today ctx={ctx} onGo={props.onGo} />}
      {props.tab === 'cards' && <CardADay ctx={ctx} onProfileChange={props.onProfileChange} />}
      {props.tab === 'activity' && <Progress ctx={ctx} onProfileChange={props.onProfileChange} />}
      {props.tab === 'db' && <People ctx={ctx} onProfileChange={props.onProfileChange} />}
    </>
  )
}

function useAgentData1(id: string) {
  const ids = useMemo(() => [id], [id])
  return api.useAgentData(ids)
}

/** Older tiers that now behave like the three we use. */
const LEGACY: Partial<Record<Tier, Tier>> = { B: 'U', C: 'D' }
const withLegacy = (ts: Tier[]) => [...new Set(ts.flatMap((t) => (LEGACY[t] ? [t, LEGACY[t] as Tier] : [t])))]
const DID_LABEL: Record<string, string> = { call: 'I called', text: 'I texted', card: 'I sent a card', popby: 'I popped by', facetoface: 'We met face to face' }
const KIND_ICON: Record<string, ReactNode> = { call: <IPhone />, text: <IText />, card: <ICard />, popby: <IDoor />, facetoface: <IFace /> }

// ======================================================================
// Today: the next 10
// ======================================================================
const BATCH = 10

function useBatch(ctx: Ctx) {
  const { data, agent, readOnly } = ctx
  const ws = ymd(weekStart())
  const key = `rs-batch-${agent.id}-${ws}`
  const touchedThisWeek = useMemo(
    () => new Set(data.touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on >= ws).map((t) => t.contact_id as string)),
    [data.touches, ws],
  )
  const [saved, setSaved] = useState<{ ids: string[]; round: number }>(() => store.get(key, { ids: [], round: 0 }))
  const [justCleared, setJustCleared] = useState(false)

  const result = useMemo(() => {
    const exists = new Set(data.contacts.map((c) => c.id))
    let ids = saved.ids.filter((id) => exists.has(id))
    let round = saved.round
    let cleared = false
    const poolExcluding = (ex: string[]) => duePool(data.contacts, agent, touchedThisWeek, new Set(ex))
    if (ids.length === 0) {
      ids = poolExcluding([]).slice(0, BATCH).map((c) => c.id)
      round = ids.length ? 1 : 0
    } else if (ids.every((id) => touchedThisWeek.has(id))) {
      const next = poolExcluding(ids).slice(0, BATCH).map((c) => c.id)
      if (next.length) {
        ids = next
        round += 1
        cleared = true
      }
    }
    return { ids, round, cleared, waiting: poolExcluding(ids).length }
  }, [saved, data.contacts, agent, touchedThisWeek])

  useEffect(() => {
    if (result.ids.join() !== saved.ids.join() || result.round !== saved.round) {
      const v = { ids: result.ids, round: result.round }
      if (!readOnly) store.set(key, v)
      setSaved(v)
      if (result.cleared) setJustCleared(true)
    }
  }, [result, saved, key, readOnly])

  const replace = (id: string) => {
    const pool = duePool(data.contacts, agent, touchedThisWeek, new Set([...result.ids, id]))
    const ids = result.ids.filter((x) => x !== id)
    if (pool[0]) ids.push(pool[0].id)
    const v = { ids, round: result.round }
    if (!readOnly) store.set(key, v)
    setSaved(v)
    return pool[0]
  }
  return { ...result, touchedThisWeek, justCleared, setJustCleared, replace }
}

function goalState(ctx: Ctx) {
  const t = ymd(today())
  const ws = ymd(weekStart())
  const ind = ctx.data.touches.filter((x) => !x.is_group)
  return {
    today: ind.filter((x) => x.occurred_on === t).length,
    week: ind.filter((x) => x.occurred_on >= ws).length,
    card: ctx.data.cards.some((c) => c.sent_on === t && c.counts_for_challenge),
  }
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

/** One short, plain line about why this person is on the list. */
function whyLine(c: Contact, last: { kind: TouchKind; occurred_on: string; is_group?: boolean } | undefined) {
  if (c.birthday) {
    const b = parse(c.birthday)
    const next = new Date(today().getFullYear(), b.getMonth(), b.getDate(), 12)
    const d = daysBetween(today(), next)
    if (d >= 0 && d <= 10) return d === 0 ? 'Birthday is today!' : `Birthday ${fmt(next)}`
  }
  if (!last && !c.last_touch_on) return 'First touch'
  if (last) return `Last time: ${last.is_group ? 'group ' : ''}${KIND_LABEL[last.kind].toLowerCase()} on ${fmt(last.occurred_on)}`
  return `Last touch ${fmt(c.last_touch_on as string)}`
}

function Today({ ctx, onGo }: { ctx: Ctx; onGo?: (t: AgentTab) => void }) {
  const { data, agent, readOnly } = ctx
  const toast = useToast()
  const b = useBatch(ctx)
  const [logFor, setLogFor] = useState<Contact | null>(null)
  const [moreFor, setMoreFor] = useState<Contact | null>(null)
  const [doneFor, setDoneFor] = useState<Contact | null>(null)
  const [editFor, setEditFor] = useState<Contact | null>(null)
  const [cardFor, setCardFor] = useState<Contact | null>(null)
  const [reach, setReach] = useState<{ c: Contact; kind: 'call' | 'text' } | null>(null)
  const [cele, setCele] = useState<{ eyebrow: string; title: string; sub: string } | null>(null)
  const pendingCheck = useRef<boolean[] | null>(null)

  const byId = new Map(data.contacts.map((c) => [c.id, c]))
  const rows = b.ids.map((id) => byId.get(id)).filter(Boolean) as Contact[]
  const todo = rows.filter((c) => !b.touchedThisWeek.has(c.id))
  const doneRows = rows.filter((c) => b.touchedThisWeek.has(c.id))
  const done = doneRows.length
  // Position in the list decides ties, so each day's list mixes calls, texts and cards.
  const sug = (c: Contact) => suggestKind(c, data.touches, Math.max(0, b.ids.indexOf(c.id)) + b.round * 3)
  const byContact = useMemo(() => touchCounts(data.touches), [data.touches])
  const lastOf = (c: Contact) => data.touches.filter((t) => t.contact_id === c.id).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on)).at(-1)
  const g = goalState(ctx)

  // Which goals are met right now: all caught up, weekly, daily, Card a Day.
  const flags = () => [rows.length > 0 && done === rows.length && b.waiting === 0, g.week >= agent.weekly_goal, g.today >= agent.daily_goal, g.card]
  const snapshot = () => { pendingCheck.current = flags() }

  // Celebrate only a goal that THIS log just completed, once per day/week.
  useEffect(() => {
    const before = pendingCheck.current
    if (!before || readOnly) return
    pendingCheck.current = null
    const now = flags()
    const dk = ymd(today())
    const wk = ymd(weekStart())
    const seen = store.get<Record<string, boolean>>(`rs-cele-${agent.id}`, {})
    const list: [string, string, string, string][] = [
      [`caught-${wk}`, 'Congratulations', "You're all caught up!", "Everyone due this week has been touched. That's a rock solid week."],
      [`week-${wk}`, 'Weekly goal', 'You hit your weekly goal!', `${g.week} touches this week. Every one is a vote for the business you're building.`],
      [`day-${dk}`, 'Daily goal', 'You hit your daily goal!', `${g.today} touches today. Same time tomorrow?`],
      [`card-${dk}`, 'Card a Day', 'Card a Day: done!', "Today's card is written and logged."],
    ]
    const hit = list.find(([k], i) => now[i] && !before[i] && !seen[k])
    list.forEach(([k], i) => { if (now[i]) seen[k] = true })
    store.set(`rs-cele-${agent.id}`, seen)
    if (hit) setCele({ eyebrow: hit[1], title: hit[2], sub: hit[3] })
  })

  async function log(c: Contact, kind: TouchKind, note: string) {
    try {
      const before = flags()
      const t = await api.logTouch(ctx.me, c.id, kind, note)
      pendingCheck.current = before
      await ctx.reload()
      toast(`${KIND_LABEL[kind]} logged for ${c.first_name}.`, { label: 'Undo', run: () => undo(t) })
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
    }
  }

  async function undo(t: Touch) {
    try {
      await api.deleteTouch(t, data.touches, data.cards)
      await ctx.reload()
      toast('Undone.')
    } catch (e) {
      toast(`Couldn't undo: ${(e as Error).message}`)
    }
  }

  async function skip(c: Contact) {
    try {
      await api.skipToNextWeek(c)
      const nx = b.replace(c.id)
      await ctx.reload()
      toast(`${c.first_name} moved to next week.${nx ? ` ${nx.first_name} took their spot.` : ''}`)
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
    }
  }

  function copyList() {
    const txt = todo.map((c) => `${KIND_LABEL[sug(c)]} ${fullName(c)}${c.phone ? ` ${c.phone}` : ''}`).join('\n')
    navigator.clipboard?.writeText(`Rock Solid: my next ${todo.length}\n${txt}`).then(
      () => toast('Copied. Paste it into a calendar block.'),
      () => toast("Copying isn't available here."),
    )
  }

  const first = (agent.full_name || agent.email).split(' ')[0]
  const caughtUp = rows.length === 0 || (todo.length === 0 && b.waiting === 0)
  return (
    <section>
      <p className="date">{today().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h2 className="hello">{readOnly ? `${first}'s list` : `${greeting()}, ${first}`}</h2>

      {rows.length > 0 && (
        <>
          <div className="stones" role="img" aria-label={`${done} of ${rows.length} done`}>
            {rows.map((c, i) => <span key={c.id} className={`stone ${i < done ? 'on' : ''}`} />)}
          </div>
          <p className="stones-l"><b>{done} of {rows.length}</b> done{b.round > 1 ? ` (set ${b.round} this week)` : ''}</p>
        </>
      )}

      <Momentum ctx={ctx} />

      {b.justCleared && (
        <div className="banner" style={{ marginTop: 16 }}>
          <p><b>You finished 10!</b> Here are your next 10. Keep going or come back tomorrow.</p>
          <button className="btn" onClick={() => b.setJustCleared(false)}>OK</button>
        </div>
      )}

      {caughtUp ? (
        <div className="card empty" style={{ marginTop: 20 }}>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>{data.contacts.length ? "You're all caught up" : 'Your list is empty'}</h3>
          <p>{data.contacts.length ? 'Nobody else is due this week. Enjoy it.' : 'Add the people you know and they will show up here, 10 at a time.'}</p>
          {!data.contacts.length && !readOnly && <button className="btn primary" style={{ marginTop: 14 }} onClick={() => onGo?.('db')}>Add people</button>}
        </div>
      ) : (
        <div className="people">
          {todo.map((c) => {
            const k = sug(c)
            const name = c.first_name || fullName(c)
            return (
              <article key={c.id} className="person">
                <div className="head">
                  <div style={{ minWidth: 0 }}>
                    <h3>{fullName(c)}</h3>
                    <p className="why">{whyLine(c, lastOf(c))}</p>
                  </div>
                  <div className="sig">
                    <Signal bars={signal(c, byContact, agent.tier_days)} plain />
                    {!readOnly && <button className="iconbtn" aria-label={`More for ${name}`} onClick={() => setMoreFor(c)}><IMore /></button>}
                  </div>
                </div>
                {readOnly ? (
                  <p className={`kind k-${k}`} style={{ marginTop: 8 }}>{KIND_ICON[k]} {KIND_LABEL[k]} suggested</p>
                ) : k === 'card' ? (
                  <button className="go k-card" onClick={() => setCardFor(c)}><ICard /> Write {name} a card</button>
                ) : c.phone ? (
                  <a className={`go k-${k}`} href={`${k === 'call' ? 'tel' : 'sms'}:${telOf(c.phone)}`} onClick={() => setReach({ c, kind: k })}>
                    {KIND_ICON[k]} {k === 'call' ? 'Call' : 'Text'} {name}
                  </a>
                ) : (
                  <button className="go k-other" onClick={() => setLogFor(c)}><ICheck /> Mark {name} done</button>
                )}
                {!readOnly && (
                  <div className="alts">
                    {c.phone && k !== 'call' && <a className="alt k-call" href={`tel:${telOf(c.phone)}`} onClick={() => setReach({ c, kind: 'call' })}><IPhone size={18} /> Call</a>}
                    {c.phone && k !== 'text' && <a className="alt k-text" href={`sms:${telOf(c.phone)}`} onClick={() => setReach({ c, kind: 'text' })}><IText size={18} /> Text</a>}
                    {k !== 'card' && <button className="alt k-card" onClick={() => setCardFor(c)}><ICard size={18} /> Card</button>}
                    <button className="alt" onClick={() => setLogFor(c)}><ICheck size={18} /> Already did it</button>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}

      {doneRows.length > 0 && (
        <details className="donelist">
          <summary>Done this week ({doneRows.length}). Tap one to change or undo it.</summary>
          <div className="card" style={{ padding: '4px 16px' }}>
            {doneRows.map((c) => {
              const l = lastOf(c)
              return (
                <button key={c.id} className="donerow" disabled={readOnly} onClick={() => setDoneFor(c)}>
                  <span className="tick"><ICheck size={16} /></span>
                  <span style={{ flex: 1 }}>{fullName(c)}</span>
                  {l && <span className="note">{KIND_LABEL[l.kind]}</span>}
                </button>
              )
            })}
          </div>
        </details>
      )}

      <div className="todaybar">
        <div className={g.today >= agent.daily_goal ? 'hit' : ''}><b>{g.today} of {agent.daily_goal}</b><span>today</span></div>
        <div className={g.week >= agent.weekly_goal ? 'hit' : ''}><b>{g.week} of {agent.weekly_goal}</b><span>this week</span></div>
        <div className={g.card ? 'hit' : ''} role={readOnly ? undefined : 'button'} style={{ cursor: readOnly ? undefined : 'pointer' }} onClick={() => !readOnly && onGo?.('cards')}>
          <b>{g.card ? 'Done' : 'Not yet'}</b><span>today's card</span>
        </div>
      </div>
      {!readOnly && todo.length > 0 && (
        <p className="note" style={{ textAlign: 'center', marginTop: 18 }}>
          <button className="link" onClick={copyList}>Copy my list</button> to paste into a calendar block.
        </p>
      )}

      <Extras ctx={ctx} />

      {logFor && <LogSheet c={logFor} suggested={sug(logFor)} goal={ctx.goal} onClose={() => setLogFor(null)} onLog={(k, n) => { const c = logFor; setLogFor(null); log(c, k, n) }} />}
      {moreFor && (
        <Sheet label={`More for ${moreFor.first_name}`} onClose={() => setMoreFor(null)}>
          <h3>{fullName(moreFor)}</h3>
          {moreFor.phone && <p className="note">{moreFor.phone}</p>}
          <div className="menu" style={{ marginTop: 8 }}>
            <button onClick={() => { const c = moreFor; setMoreFor(null); setLogFor(c) }}>Record something I already did</button>
            <button onClick={() => { const c = moreFor; setMoreFor(null); setEditFor(c) }}>See or edit details</button>
            <button onClick={() => { const c = moreFor; setMoreFor(null); skip(c) }}>Move to next week</button>
            <button onClick={() => setMoreFor(null)} style={{ color: 'var(--muted)' }}>Cancel</button>
          </div>
        </Sheet>
      )}
      {editFor && <EditSheet ctx={ctx} c={editFor} onClose={() => setEditFor(null)} />}
      {doneFor && <DoneSheet ctx={ctx} c={doneFor} onClose={() => setDoneFor(null)} onEdit={() => { const c = doneFor; setDoneFor(null); setEditFor(c) }} />}
      {cardFor && (
        <Sheet label={`Card for ${cardFor.first_name}`} onClose={() => setCardFor(null)}>
          <CardSteps ctx={ctx} preset={fullName(cardFor)} onBefore={snapshot} onLogged={() => setCardFor(null)} />
        </Sheet>
      )}
      {reach && (
        <div className="reach" role="status">
          <p>Did you {reach.kind} {reach.c.first_name}?</p>
          <div>
            <button className="btn gold lg" onClick={() => { const r = reach; setReach(null); log(r.c, r.kind, '') }}>Yes, mark done</button>
            <button className="btn lg" onClick={() => setReach(null)}>Not yet</button>
          </div>
        </div>
      )}
      {cele && <Celebrate {...cele} onClose={() => setCele(null)} />}
    </section>
  )
}

/** Change or undo what was logged for someone this week. */
function DoneSheet({ ctx, c, onClose, onEdit }: { ctx: Ctx; c: Contact; onClose: () => void; onEdit: () => void }) {
  const toast = useToast()
  const ws = ymd(weekStart())
  const mine = ctx.data.touches.filter((t) => t.contact_id === c.id && !t.is_group && t.occurred_on >= ws).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))
  const [edits, setEdits] = useState<Record<string, { kind: TouchKind; note: string }>>(() =>
    Object.fromEntries(mine.map((t) => [t.id, { kind: t.kind, note: t.note ?? '' }])),
  )
  const [busy, setBusy] = useState(false)
  async function run(fn: () => Promise<void>, msg: string) {
    setBusy(true)
    try {
      await fn()
      await ctx.reload()
      toast(msg)
      onClose()
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
      setBusy(false)
    }
  }
  return (
    <Sheet label={`What you logged for ${c.first_name}`} onClose={onClose}>
      <h3>{fullName(c)}</h3>
      <p className="note">What you logged this week. Change it, or undo it to put {c.first_name} back on your list.</p>
      {mine.map((t) => {
        const e = edits[t.id]
        const isCad = t.kind === 'card' && t.note?.startsWith('Card a Day: ')
        return (
          <div key={t.id} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 14 }}>
            <span className="note">{fmt(t.occurred_on)}</span>
            {isCad ? (
              <p className={`kind k-card`}><ICard /> Card a Day card</p>
            ) : (
              <div className="chips">
                {(['call', 'text', 'card', 'popby', 'facetoface'] as TouchKind[]).map((k) => (
                  <button key={k} aria-pressed={e.kind === k} onClick={() => setEdits({ ...edits, [t.id]: { ...e, kind: k } })}>{KIND_LABEL[k]}</button>
                ))}
              </div>
            )}
            {!isCad && <textarea aria-label="Note" placeholder="Note (optional)" value={e.note} onChange={(ev) => setEdits({ ...edits, [t.id]: { ...e, note: ev.target.value } })} />}
            <div style={{ display: 'flex', gap: 8 }}>
              {!isCad && (
                <button className="btn primary" style={{ flex: 1 }} disabled={busy || (e.kind === t.kind && e.note === (t.note ?? ''))} onClick={() => run(() => api.updateTouch(t.id, { kind: e.kind, note: e.note || null }), 'Saved.')}>Save change</button>
              )}
              <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => run(() => api.deleteTouch(t, ctx.data.touches, ctx.data.cards), `Undone. ${c.first_name} is back on your list.`)}>Undo this</button>
            </div>
          </div>
        )
      })}
      {mine.length === 0 && <p className="note" style={{ marginTop: 12 }}>Nothing logged for {c.first_name} this week.</p>}
      <div className="menu" style={{ marginTop: 14 }}>
        <button onClick={onEdit}>See or edit {c.first_name}'s details</button>
        <button onClick={onClose} style={{ color: 'var(--muted)' }}>Close</button>
      </div>
    </Sheet>
  )
}

// ======================================================================
// Momentum: an always-positive gauge of the last 7 days, plus a streak
// ======================================================================
const LEVELS = [
  { at: 0, name: 'Warming up', msg: 'Every touch counts. Get one on the board.' },
  { at: 0.25, name: 'Building', msg: 'Momentum is building. Keep stacking touches.' },
  { at: 0.5, name: 'Rolling', msg: "You're rolling. Keep it going!" },
  { at: 0.85, name: 'On fire', msg: "You're on fire this week!" },
  { at: 1.2, name: 'Unstoppable', msg: 'Unstoppable. Your people can feel it.' },
]

function momentum(ctx: Ctx) {
  const ind = ctx.data.touches.filter((t) => !t.is_group)
  const days = new Set(ind.map((t) => t.occurred_on))
  const since = ymd(addDays(today(), -6))
  const ratio = ind.filter((t) => t.occurred_on >= since).length / Math.max(1, ctx.agent.weekly_goal)
  // Days in a row with a touch. Weekends without a touch don't break it, and today doesn't count against you yet.
  let streak = 0
  for (let d = today(), i = 0; i < 400; d = addDays(d, -1), i++) {
    const k = ymd(d)
    if (days.has(k)) streak++
    else if (i === 0 || d.getDay() === 0 || d.getDay() === 6) continue
    else break
  }
  const level = [...LEVELS].reverse().find((l) => ratio >= l.at) ?? LEVELS[0]
  return { ratio, streak, level, today: days.has(ymd(today())) }
}

function Momentum({ ctx }: { ctx: Ctx }) {
  const m = momentum(ctx)
  const fill = Math.min(1, m.ratio / 1.2)
  // Half-circle gauge: arc length of a radius-40 semicircle is about 125.7
  const L = 125.7
  const streakLine =
    m.streak >= 2 ? `${m.streak} days in a row` : m.streak === 1 ? (m.today ? 'Day 1 of a new streak' : '1 day so far') : 'Start a streak today'
  return (
    <div className="momentum" role="group" aria-label={`Momentum: ${m.level.name}. ${streakLine}.`}>
      <svg viewBox="0 0 100 58" className="gauge" aria-hidden>
        <path d="M10 50 A40 40 0 0 1 90 50" className="g-track" />
        <path d="M10 50 A40 40 0 0 1 90 50" className="g-fill" style={{ strokeDasharray: `${L * Math.max(0.04, fill)} ${L}` }} />
      </svg>
      <div className="m-text">
        <b>{m.level.name}</b>
        <span className="m-streak">{m.streak >= 2 && <IFlame size={16} />}{streakLine}</span>
        <span className="m-msg">{m.level.at === 0 && m.today ? "Nice start! Every touch builds momentum." : m.level.msg}</span>
      </div>
    </div>
  )
}

function LogSheet({ c, suggested, goal, onClose, onLog }: { c: Contact; suggested: TouchKind; goal: number; onClose: () => void; onLog: (k: TouchKind, note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Sheet label="Log a touch" onClose={onClose}>
      <h3>What did you already do for {c.first_name || fullName(c)}?</h3>
      <p className="note">This just records it. Anything you pick counts toward their {goal} touches this year.</p>
      <div className="opts">
        {([suggested, ...(['call', 'text', 'card', 'popby', 'facetoface'] as TouchKind[]).filter((x) => x !== suggested)]).map((k) => (
          <button key={k} className={`opt k-${k}`} onClick={() => onLog(k, note)}>
            {KIND_ICON[k]}{DID_LABEL[k] ?? KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <textarea aria-label="Note" placeholder="Want to remember anything? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

// ======================================================================
// Edit / add a person
// ======================================================================
function EditSheet({ ctx, c, onClose }: { ctx: Ctx; c: Contact | null; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({
    first_name: c?.first_name ?? '', last_name: c?.last_name ?? '', phone: c?.phone ?? '', email: c?.email ?? '',
    address: c?.address ?? '', city: c?.city ?? '', state: c?.state ?? 'TX', zip: c?.zip ?? '',
    tier: (c?.tier === 'U' ? 'B' : c?.tier === 'D' ? 'C' : c?.tier ?? 'B') as Tier, birthday: c?.birthday ?? '', home_anniversary: c?.home_anniversary ?? '', notes: c?.notes ?? '',
  })
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const byContact = useMemo(() => touchCounts(ctx.data.touches), [ctx.data.touches])
  const ro = ctx.readOnly

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!f.first_name.trim() || ro) return
    setBusy(true)
    try {
      const input: api.ContactInput = {
        ...f, first_name: f.first_name.trim(), last_name: f.last_name.trim(),
        phone: f.phone || null, email: f.email || null, address: f.address || null, city: f.city || null, state: f.state || null, zip: f.zip || null,
        birthday: f.birthday || null, home_anniversary: f.home_anniversary || null, notes: f.notes || null,
      }
      await api.saveContact(ctx.me, input, c?.id)
      await ctx.reload()
      toast(c ? 'Saved.' : `${f.first_name} added. They'll show up on Today soon.`)
      onClose()
    } catch (err) {
      toast(`That didn't save: ${(err as Error).message}`)
      setBusy(false)
    }
  }
  async function del() {
    if (!c) return
    try {
      await api.deleteContact(c.id)
      await ctx.reload()
      toast(`${c.first_name} removed.`)
      onClose()
    } catch (err) {
      toast(`Couldn't remove: ${(err as Error).message}`)
    }
  }
  return (
    <Sheet label={c ? 'Person details' : 'Add a person'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <h3>{c ? fullName(c) : 'Add a person'}</h3>
        {c && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Meter c={c} byContact={byContact} goal={ctx.goal} agent={ctx.agent} />
            <span className="note">touches in the last 12 months</span>
          </div>
        )}
        <div className="ed">
          <label className="field"><span>First name</span><input required disabled={ro} value={f.first_name} onChange={set('first_name')} /></label>
          <label className="field"><span>Last name</span><input disabled={ro} value={f.last_name} onChange={set('last_name')} /></label>
          <label className="field full"><span>Phone</span><input inputMode="tel" disabled={ro} value={f.phone} onChange={set('phone')} /></label>
        </div>
        <div className="field">
          <span>How close are you? {TIER_NAMES[f.tier]}: every {tierDays(ctx.agent, f.tier)} days.</span>
          <div className="tiersel" role="group" aria-label="Tier">
            {TIERS.map((t) => (
              <button type="button" key={t} disabled={ro} aria-pressed={f.tier === t} onClick={() => setF({ ...f, tier: t })}>{t}</button>
            ))}
          </div>
        </div>
        <label className="field"><span>Notes</span><textarea disabled={ro} value={f.notes} onChange={set('notes')} placeholder="Kids, pets, what they care about" /></label>
        <details className="more" style={{ marginTop: 0 }}>
          <summary>Email, address and dates</summary>
          <div className="ed">
            <label className="field full"><span>Email</span><input type="email" disabled={ro} value={f.email} onChange={set('email')} /></label>
            <label className="field full"><span>Address</span><input disabled={ro} value={f.address} onChange={set('address')} /></label>
            <label className="field"><span>City</span><input disabled={ro} value={f.city} onChange={set('city')} /></label>
            <label className="field"><span>Zip</span><input disabled={ro} value={f.zip} onChange={set('zip')} /></label>
            <label className="field"><span>Birthday</span><input type="date" disabled={ro} value={f.birthday} onChange={set('birthday')} /></label>
            <label className="field"><span>Home anniversary</span><input type="date" disabled={ro} value={f.home_anniversary} onChange={set('home_anniversary')} /></label>
          </div>
        </details>
        {confirmDel && (
          <div className="warn">
            Remove {c?.first_name} from your people for good?
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn" onClick={del}>Yes, remove</button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDel(false)}>Keep</button>
            </div>
          </div>
        )}
        {ro ? (
          <button type="button" className="btn block" onClick={onClose}>Close</button>
        ) : (
          <>
            <button className="btn primary lg block" disabled={busy}>{busy ? 'Saving…' : c ? 'Save' : 'Add person'}</button>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              {c ? <button type="button" className="btn ghost" onClick={() => setConfirmDel(true)}>Remove</button> : <span />}
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </form>
    </Sheet>
  )
}

// ======================================================================
// Card a Day: one question at a time, like the Shortcut
// ======================================================================
const RELS = ['Friend', 'Family', 'Client', 'Agent/Colleague', 'Vendor', 'Other']
const OCCASIONS = ['Thank You', 'Birthday', 'Just Because', 'Congratulations', 'Encouragement', 'Follow-Up', 'Other']

function CardSteps({ ctx, preset, onBefore, onLogged }: { ctx: Ctx; preset?: string; onBefore?: () => void; onLogged?: (r: { counts: boolean; firstToday: boolean }) => void }) {
  const { data, agent } = ctx
  const toast = useToast()
  const start = preset ? 1 : 0
  const [step, setStep] = useState(start)
  const [name, setName] = useState(preset ?? '')
  const [rel, setRel] = useState('')
  const [occ, setOcc] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const dup = name.trim() ? cardWithin12Months(data.cards, name) : undefined
  const q = name.trim().toLowerCase()
  const matches = q ? data.contacts.filter((c) => fullName(c).toLowerCase().includes(q) && fullName(c).toLowerCase() !== q).slice(0, 5) : []
  const who = name.trim().split(' ')[0] || 'them'
  const total = 4 - start

  async function submit() {
    setBusy(true)
    try {
      const hadCardToday = data.cards.some((c) => c.sent_on === ymd(today()) && c.counts_for_challenge)
      onBefore?.()
      const r = await api.logCard(ctx.me, data.cards, data.contacts, { name, relationship: rel, occasion: occ, note })
      await ctx.reload()
      toast(r.repeat ? `Card logged for ${who}. It counts as a touch, not toward Card a Day.` : `Card logged for ${who}!`)
      setName(preset ?? ''); setRel(''); setOcc(''); setNote(''); setStep(start)
      onLogged?.({ counts: !r.repeat, firstToday: !r.repeat && !hadCardToday })
    } catch (err) {
      toast(`That didn't save: ${(err as Error).message}`)
    }
    setBusy(false)
  }

  return (
    <div>
      <div className="steps" aria-hidden>{Array.from({ length: total }, (_, i) => <span key={i} className={i <= step - start ? 'on' : ''} />)}</div>
      {step === 0 && (
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(1) }}>
          <p className="q">Who did you write a card to?</p>
          <input aria-label="Name" autoComplete="off" placeholder="Start typing a name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
          {matches.length > 0 && (
            <div className="sugs">{matches.map((c) => <button type="button" key={c.id} onClick={() => { setName(fullName(c)); setStep(1) }}>{fullName(c)}</button>)}</div>
          )}
          <button className="btn primary lg block" style={{ marginTop: 14 }} disabled={!name.trim()}>Next</button>
        </form>
      )}
      {step === 1 && (
        <>
          <p className="q">Who is {who} to you?</p>
          <div className="big-opts">{RELS.map((r) => <button key={r} aria-pressed={rel === r} onClick={() => { setRel(r); setStep(2) }}>{r}</button>)}</div>
        </>
      )}
      {step === 2 && (
        <>
          <p className="q">What kind of card?</p>
          <div className="big-opts">{OCCASIONS.map((r) => <button key={r} aria-pressed={occ === r} onClick={() => { setOcc(r); setStep(3) }}>{r}</button>)}</div>
        </>
      )}
      {step === 3 && (
        <div className="stack">
          <p className="q" style={{ margin: 0 }}>Anything to remember?</p>
          <p className="note" style={{ marginTop: -8 }}>{occ} card to {name.trim()} ({rel.toLowerCase()})</p>
          <textarea aria-label="Note" placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} />
          {dup && agent.card_rule && (
            <div className="warn">You wrote {who} a card on {fmt(dup.sent_on)}. This one still counts as a touch, just not toward Card a Day until {fmt(addDays(parse(dup.sent_on), 365))}.</div>
          )}
          <button className="btn gold lg block" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Log my card'}</button>
        </div>
      )}
      {step > start && <button className="back" onClick={() => setStep(step - 1)}>Back</button>}
    </div>
  )
}

function CardADay({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly } = ctx
  const [cele, setCele] = useState(false)
  const counting = data.cards.filter((c) => c.counts_for_challenge)
  const days = new Set(counting.map((c) => c.sent_on))
  const doneToday = days.has(ymd(today()))
  let streak = 0
  for (let d = today(); ; d = addDays(d, -1)) {
    if (days.has(ymd(d))) streak++
    else if (ymd(d) === ymd(today())) continue
    else break
  }
  const ms = ymd(monthStart())
  const monthDays = [...days].filter((d) => d >= ms).length
  const yearCount = counting.filter((c) => c.sent_on.startsWith(String(today().getFullYear()))).length

  function logged(r: { firstToday: boolean }) {
    const key = `rs-cele-${agent.id}`
    const seen = store.get<Record<string, boolean>>(key, {})
    if (r.firstToday && !seen[`card-${ymd(today())}`]) {
      seen[`card-${ymd(today())}`] = true
      store.set(key, seen)
      setCele(true)
    }
  }
  async function toggleRule(v: boolean) {
    await api.updateMyProfile(ctx.me, { card_rule: v })
    onProfileChange?.()
  }

  const first = monthStart()
  const pad = (first.getDay() + 6) % 7
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return (
    <section>
      <h2 style={{ marginTop: 14 }}>Card a Day</h2>
      <div className="streak" style={{ margin: '10px 0 4px' }}>
        <b>{streak}</b><span>day streak</span>
      </div>
      <p className="muted" style={{ marginBottom: 18 }}>{doneToday ? "Today's card is done. Nice work." : 'One handwritten card today keeps it going.'}</p>

      {!readOnly && (
        <div className="card">
          <CardSteps ctx={ctx} onLogged={logged} />
        </div>
      )}

      <div className="grp">{today().toLocaleDateString('en-US', { month: 'long' })}: {monthDays} of {today().getDate()} days</div>
      <div className="card">
        <div className="cal">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x, i) => <div key={i} className="h">{x}</div>)}
          {Array.from({ length: pad }, (_, i) => <div key={`p${i}`} />)}
          {Array.from({ length: dim }, (_, i) => {
            const d = new Date(first.getFullYear(), first.getMonth(), i + 1, 12)
            const k = ymd(d)
            const who = counting.filter((c) => c.sent_on === k).map((c) => c.recipient_name).join(', ')
            return <div key={k} title={who} className={`d ${days.has(k) ? 'on' : ''} ${k === ymd(today()) ? 'today' : ''} ${d > today() ? 'fut' : ''}`}>{i + 1}</div>
          })}
        </div>
        <p className="note" style={{ marginTop: 12, textAlign: 'center' }}>{yearCount} cards so far this year</p>
      </div>

      <details className="more">
        <summary>Recent cards and settings</summary>
        <div className="card" style={{ padding: '4px 16px' }}>
          {[...data.cards].reverse().slice(0, 10).map((c) => (
            <div key={c.id} className="donerow">
              <span style={{ flex: 1 }}><b style={{ fontWeight: 500 }}>{c.recipient_name}</b><br /><span className="note">{c.occasion}{c.counts_for_challenge ? '' : ' (touch only)'}</span></span>
              <span className="note">{fmt(c.sent_on)}</span>
            </div>
          ))}
          {data.cards.length === 0 && <p className="note" style={{ padding: '12px 0' }}>No cards yet.</p>}
        </div>
        {!readOnly && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, fontSize: 15 }}>
            <input type="checkbox" style={{ width: 22, height: 22 }} checked={agent.card_rule} onChange={(e) => toggleRule(e.target.checked)} />
            Only count each person once every 12 months
          </label>
        )}
      </details>
      {cele && <Celebrate eyebrow="Card a Day" title="Card a Day: done!" sub="Today's card is written and logged." onClose={() => setCele(false)} />}
    </section>
  )
}

// ======================================================================
// Progress
// ======================================================================
/** Monthly lead-gen extras. "reach" ones can also credit a touch to people in the database. */
const EXTRAS: { k: string; l: string; reach?: TouchKind }[] = [
  { k: 'social', l: 'Social post' },
  { k: 'video', l: 'Video' },
  { k: 'openhouse', l: 'Open house' },
  { k: 'giveaway', l: 'Monthly giveaway' },
  { k: 'email', l: 'Email newsletter', reach: 'email' },
  { k: 'newsletter', l: 'Mailed newsletter', reach: 'newsletter' },
  { k: 'event', l: 'Client event' },
]

function Extras({ ctx }: { ctx: Ctx }) {
  const { data, readOnly } = ctx
  const toast = useToast()
  const [open, setOpen] = useState<(typeof EXTRAS)[number] | null>(null)
  const val = (k: string) => data.tallies.find((x) => x.kind === k)?.count ?? 0
  async function plusOne(k: string, l: string) {
    try {
      await api.bumpTally(ctx.me, data.tallies, k, 1)
      await ctx.reload()
      toast(`${l} added.`, { label: 'Undo', run: async () => { await api.setTally(ctx.me, k, val(k)); await ctx.reload() } })
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
    }
  }
  return (
    <>
      <div className="grp" style={{ marginTop: 28 }}>This month <span className="note" style={{ fontWeight: 400 }}>Each one is a drawing entry</span></div>
      <div className="extras">
        {EXTRAS.map((x) => {
          const n = val(x.k)
          return (
            <div key={x.k} className={`extra ${n ? 'did' : ''}`}>
              <button className="ex-body" disabled={readOnly} onClick={() => setOpen(x)} aria-label={`${x.l}: ${n} this month. Tap to change.`}>
                <b>{n}</b><span>{x.l}</span>
              </button>
              {!readOnly && (
                <button className="ex-plus" aria-label={`Add ${x.l}`} onClick={() => (x.reach ? setOpen(x) : plusOne(x.k, x.l))}><IPlus size={20} /></button>
              )}
            </div>
          )
        })}
      </div>
      {open && <ExtraSheet ctx={ctx} x={open} current={val(open.k)} onClose={() => setOpen(null)} />}
    </>
  )
}

function ExtraSheet({ ctx, x, current, onClose }: { ctx: Ctx; x: (typeof EXTRAS)[number]; current: number; onClose: () => void }) {
  const toast = useToast()
  const [total, setTotal] = useState(current)
  const [tiers, setTiers] = useState<Tier[]>(['A', 'B', 'C', 'D', 'U'])
  const [busy, setBusy] = useState(false)
  const who = ctx.data.contacts.filter((c) => tiers.includes(c.tier))
  const all = TIERS.every((t) => tiers.includes(t))
  async function run(fn: () => Promise<void>, msg: string) {
    setBusy(true)
    try { await fn(); await ctx.reload(); toast(msg); onClose() } catch (e) { toast(`That didn't save: ${(e as Error).message}`); setBusy(false) }
  }
  return (
    <Sheet label={x.l} onClose={onClose}>
      <h3>{x.l}</h3>
      <p className="note">{current} so far this month.</p>
      {x.reach && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="field"><span>Who got it? Each person gets credit toward their {ctx.goal}.</span>
            <div className="chips">
              <button aria-pressed={all} onClick={() => setTiers(all ? [] : ['A', 'B', 'C', 'D', 'U'])}>Everyone</button>
              {TIERS.map((t) => (
                <button key={t} aria-pressed={!all && tiers.includes(t)} onClick={() => setTiers(all ? withLegacy([t]) : tiers.includes(t) ? tiers.filter((y) => y !== t && y !== LEGACY[t]) : withLegacy([...tiers, t]))}>{`${t}s`}</button>
              ))}
            </div>
          </div>
          <button className="btn gold lg block" disabled={busy || !who.length} onClick={() => run(async () => { await api.groupTouch(ctx.me, who, x.reach as TouchKind, x.l); await api.setTally(ctx.me, x.k, current + 1) }, `${x.l} logged for ${who.length} people.`)}>
            {who.length ? `Log it for ${who.length} people` : 'Pick who got it'}
          </button>
        </div>
      )}
      <div className="field" style={{ marginTop: 20 }}>
        <span>{x.reach ? 'Or just set the count for this month' : 'How many this month?'}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <NumInput label={`${x.l} this month`} value={total} onChange={setTotal} style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || total === current} onClick={() => run(() => api.setTally(ctx.me, x.k, total), 'Saved.')}>Save</button>
        </div>
      </div>
      <button className="btn ghost block" style={{ marginTop: 10 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

function Progress({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly, brokerage } = ctx
  const toast = useToast()
  const ms = ymd(monthStart())
  const month = data.touches.filter((t) => !t.is_group && t.occurred_on >= ms)
  const goals = { call: 21, text: 21, card: 7, ...(brokerage?.settings?.monthly_goals ?? {}) }
  const count = (k: TouchKind) => month.filter((t) => t.kind === k).length
  const g = goalState(ctx)

  return (
    <section>
      <h2 style={{ marginTop: 14 }}>{today().toLocaleDateString('en-US', { month: 'long' })}</h2>
      <p className="sub">Everything you log on Today and Cards adds up here on its own.</p>
      <div className="card bigbars">
        {(['call', 'text', 'card'] as const).map((k) => {
          const n = count(k)
          const goal = goals[k] ?? 1
          const p = Math.min(100, Math.round((n / goal) * 100))
          return (
            <div key={k} className={`bigbar k-${k}`}>
              <div className="row1"><span className={`kind k-${k}`}>{KIND_ICON[k]} {KIND_LABEL[k]}s</span><b>{n} of {goal}</b></div>
              <div className="track"><div className="fill" style={{ width: `${p}%` }} /></div>
            </div>
          )
        })}
        <p className="note">Pop-bys this month: {count('popby')} · Face to face: {count('facetoface')}</p>
      </div>
      <div className="stats" style={{ marginTop: 12, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <div className="stat"><div className="n">{g.today} of {agent.daily_goal}</div><div className="l">today</div></div>
        <div className="stat"><div className="n">{g.week} of {agent.weekly_goal}</div><div className="l">this week</div></div>
      </div>

      <div className="card tally" style={{ padding: '4px 16px', marginTop: 12 }}>
        {EXTRAS.map((t) => (
          <div key={t.k} className="tl"><span>{t.l}</span><span className="v">{data.tallies.find((x) => x.kind === t.k)?.count ?? 0}</span></div>
        ))}
      </div>
      <p className="note" style={{ marginTop: 8 }}>Add these from the bottom of Today. Each one is also an entry in the monthly drawing.</p>
      {!readOnly && (
        <details className="more" style={{ marginTop: 0 }}>
          <summary>My daily and weekly goals</summary>
          <MyGoals agent={agent} me={ctx.me} onProfileChange={onProfileChange} />
        </details>
      )}
      <details className="more" style={{ marginTop: 0 }}>
        <summary>My plan for the year</summary>
        <MyPlan ctx={ctx} onProfileChange={onProfileChange} />
      </details>
    </section>
  )
}

function MyGoals({ agent, me, onProfileChange }: { agent: Profile; me: Profile; onProfileChange?: () => void }) {
  const [day, setDay] = useState(agent.daily_goal)
  const [week, setWeek] = useState(agent.weekly_goal)
  async function save(f: Partial<Profile>) {
    await api.updateMyProfile(me, f)
    onProfileChange?.()
  }
  return (
    <div className="card ed">
      <label className="field"><span>Touches a day</span><NumInput value={day} onChange={setDay} onCommit={(n) => save({ daily_goal: Math.max(1, n || 1) })} /></label>
      <label className="field"><span>Touches a week</span><NumInput value={week} onChange={setWeek} onCommit={(n) => save({ weekly_goal: Math.max(1, n || 1) })} /></label>
    </div>
  )
}

/** A number box that behaves on phones: no stuck leading zero, selects all on tap, commas for dollars. */
function NumInput({ value, onChange, onCommit, money, decimals, disabled, label, style }: {
  value: number; onChange: (n: number) => void; onCommit?: (n: number) => void; money?: boolean; decimals?: boolean; disabled?: boolean; label?: string; style?: CSSProperties
}) {
  const show = (n: number) => (money ? n.toLocaleString('en-US') : String(n))
  const [text, setText] = useState(show(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(show(value)) }, [value, focused]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      inputMode={decimals ? 'decimal' : 'numeric'} aria-label={label} disabled={disabled} style={style}
      value={money && focused ? text.replace(/,/g, '') : text}
      onFocus={(e) => { setFocused(true); const el = e.target; setTimeout(() => el.select(), 0) }}
      onChange={(e) => {
        let v = e.target.value.replace(decimals ? /[^0-9.]/g : /[^0-9]/g, '')
        if (decimals) v = v.replace(/(\..*)\./g, '$1')
        v = v.replace(/^0+(?=\d)/, '')
        setText(v)
        onChange(Number(v) || 0)
      }}
      onBlur={() => { setFocused(false); setText(show(value)); onCommit?.(value) }}
    />
  )
}

function TierDays({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) {
  const [v, setV] = useState(value)
  return <NumInput value={v} label={label} style={{ width: 64 }} onChange={setV} onCommit={(n) => onCommit(Math.max(1, n || 1))} />
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function MyPlan({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { agent, readOnly, data } = ctx
  const init = { income: 80000, cap: 0, price: 275000, rate: 2.7, conversion: 12, ...(agent.plan ?? {}) }
  const [p, setP] = useState(init)
  const gci = p.income + p.cap
  const perDeal = p.price * (p.rate / 100)
  const deals = perDeal > 0 ? Math.ceil(gci / perDeal) : 0
  const dbNeeded = p.conversion > 0 ? Math.ceil(deals / (p.conversion / 100)) : 0
  const have = data.contacts.length
  async function save(next: typeof p) {
    await api.updateMyProfile(ctx.me, { plan: next })
    onProfileChange?.()
  }
  const num = (k: keyof typeof p, label: string, kind: 'money' | 'decimal') => {
    const money = kind === 'money'
    const decimals = kind === 'decimal'
    return (
    <label className="field">
      <span>{label}</span>
      <NumInput disabled={readOnly} value={p[k]} money={money} decimals={decimals} onChange={(n) => setP({ ...p, [k]: n })} onCommit={(n) => save({ ...p, [k]: n })} />
    </label>
    )
  }
  return (
    <div className="card stack">
      <div className="ed">
        {num('income', 'Take-home goal ($)', 'money')}
        {num('cap', 'Cap and splits ($)', 'money')}
        {num('price', 'Average sale price ($)', 'money')}
        {num('rate', 'Commission rate (%)', 'decimal')}
        <label className="field full"><span>Of your people, how many buy or sell or refer each year? (%)</span>
          <NumInput disabled={readOnly} value={p.conversion} decimals onChange={(n) => setP({ ...p, conversion: n })} onCommit={(n) => save({ ...p, conversion: n })} />
        </label>
      </div>
      <div className="stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <div className="stat"><div className="n">{money(gci)}</div><div className="l">You need to earn</div></div>
        <div className="stat"><div className="n">{deals}</div><div className="l">Closings</div></div>
        <div className="stat"><div className="n">{dbNeeded}</div><div className="l">People you need</div></div>
        <div className="stat"><div className="n">{have}</div><div className="l">People you have</div></div>
      </div>
      <p className="note">
        {have >= dbNeeded ? 'You have enough people for this plan. ' : `Add ${dbNeeded - have} more people to support this plan. `}
        At 36 touches each, that's about {Math.round((dbNeeded * 36) / 52)} touches a week.
      </p>
    </div>
  )
}

// ======================================================================
// People
// ======================================================================
function Meter({ c, byContact, goal, agent }: { c: Contact; byContact: Map<string, string[]>; goal: number; agent: Profile }) {
  const n = score(c, byContact)
  const h = heat(c, byContact, goal, agent.tier_days)
  return (
    <span className={`meter h-${h}`} title={`${n} of ${goal} touches. ${HEAT_NAME[h]}.`}>
      <HeatTag h={h} />
      <span className="mt"><i style={{ width: `${Math.min(100, (n / goal) * 100)}%` }} /></span>
      {n}/{goal}
    </span>
  )
}

function People({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly } = ctx
  const byContact = useMemo(() => touchCounts(data.touches), [data.touches])
  const [q, setQ] = useState('')
  const [hf, setHf] = useState<Heat | ''>('')
  const [edit, setEdit] = useState<Contact | null | 'new'>(null)
  const [group, setGroup] = useState(false)
  const [importing, setImporting] = useState(false)
  const [shown, setShown] = useState(60)

  const heats = new Map(data.contacts.map((c) => [c.id, heat(c, byContact, ctx.goal, agent.tier_days)]))
  const counts: Record<Heat, number> = { hot: 0, warm: 0, cold: 0, new: 0 }
  for (const h of heats.values()) counts[h]++
  const list = data.contacts
    .filter((c) => (!hf || heats.get(c.id) === hf) && fullName(c).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (hf ? score(a, byContact) - score(b, byContact) : 0) || fullName(a).localeCompare(fullName(b)))

  async function setDays(t: Tier, v: number) {
    await api.updateMyProfile(ctx.me, { tier_days: { ...agent.tier_days, [t]: Math.max(1, v || 1) } })
    onProfileChange?.()
  }

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <h2 style={{ margin: 0 }}>People</h2>
        {!readOnly && <button className="btn primary" onClick={() => setEdit('new')}><IPlus size={18} /> Add</button>}
      </div>
      <p className="sub" style={{ marginTop: 4 }}>{data.contacts.length} people. Tap anyone to see or change their details.</p>

      <div className="search"><ISearch size={20} /><input type="search" placeholder="Find someone" aria-label="Find someone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="chips" style={{ margin: '12px 0' }}>
        <button aria-pressed={!hf} onClick={() => setHf('')}>Everyone</button>
        {(['cold', 'warm', 'hot', ...(counts.new ? ['new'] : [])] as Heat[]).map((h) => (
          <button key={h} aria-pressed={hf === h} onClick={() => setHf(hf === h ? '' : h)}>{HEAT_NAME[h]} ({counts[h]})</button>
        ))}
      </div>

      {data.contacts.length === 0 ? (
        <div className="card empty">
          <p>No one here yet. Add people one at a time, or bring in a spreadsheet under More tools.</p>
        </div>
      ) : list.length === 0 ? (
        <div className="card empty"><p>No one matches that.</p></div>
      ) : (
        <div className="plist">
          {list.slice(0, shown).map((c) => (
            <button key={c.id} className="prow" onClick={() => setEdit(c)}>
              <span className="nm">
                <b>{fullName(c)}</b>
                <small>{c.tier === 'U' ? 'Tier B' : c.tier === 'D' ? 'Tier C' : `Tier ${c.tier}`}{c.last_touch_on ? ` · last touch ${fmt(c.last_touch_on)}` : ''}</small>
              </span>
              <Meter c={c} byContact={byContact} goal={ctx.goal} agent={ctx.agent} />
            </button>
          ))}
        </div>
      )}
      {list.length > shown && <button className="btn block" style={{ marginTop: 12 }} onClick={() => setShown(shown + 100)}>Show more ({list.length - shown})</button>}
      <p className="note" style={{ marginTop: 12 }}>The bar shows touches in the last 12 months out of {ctx.goal}. Red means it's been a long time since you reached out.</p>

      {!readOnly && (
        <details className="more">
          <summary>More tools</summary>
          <div className="stack">
            <div className="card stack">
              <h3>Bring in a spreadsheet</h3>
              <p className="note">A CSV file, like a BoldTrail export. People already here are skipped.</p>
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setImporting(true)}>Import CSV</button>
            </div>
            <div className="card stack">
              <h3>How often each tier comes up</h3>
              {TIERS.map((t) => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                  <span>{`${t}: ${TIER_NAMES[t]}`} <span className="note">({data.contacts.filter((c) => c.tier === t || c.tier === LEGACY[t]).length})</span></span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    every <TierDays value={tierDays(agent, t)} label={`Days between touches for tier ${t}`} onCommit={(n) => setDays(t, n)} /> days
                  </span>
                </label>
              ))}
            </div>
          </div>
        </details>
      )}
      {edit && <EditSheet ctx={ctx} c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {group && <GroupSheet ctx={ctx} onClose={() => setGroup(false)} />}
      {importing && <ImportSheet ctx={ctx} onClose={() => setImporting(false)} />}
    </section>
  )
}

function GroupSheet({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const toast = useToast()
  const [kind, setKind] = useState<TouchKind>('email')
  const [tiers, setTiers] = useState<Tier[]>(['A', 'B', 'C', 'D', 'U'])
  const [busy, setBusy] = useState(false)
  const who = ctx.data.contacts.filter((c) => tiers.includes(c.tier))
  async function go() {
    setBusy(true)
    try {
      await api.groupTouch(ctx.me, who, kind)
      await ctx.reload()
      toast(`${KIND_LABEL[kind]} credited to ${who.length} contacts.`)
      onClose()
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`)
      setBusy(false)
    }
  }
  return (
    <Sheet label="Log a group touch" onClose={onClose}>
      <h3>Log a group touch</h3>
      <p className="note" style={{ margin: '4px 0 12px' }}>For touches that go to many people at once. Everyone you pick gets credit toward their {ctx.goal}. Group touches don't count toward daily goals or the drawing.</p>
      <div className="field"><span>What went out?</span>
        <div className="chips">
          {([['email', 'Email or Flodesk send'], ['newsletter', 'Mailed newsletter'], ['event', 'Client event']] as [TouchKind, string][]).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><span>Who got it?</span>
        <div className="chips">
          {TIERS.map((t) => (
            <button key={t} type="button" aria-pressed={tiers.includes(t)} onClick={() => setTiers(tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t])}>{`Tier ${t}`}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <span className="note">{who.length} contacts will get credit</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn gold" disabled={busy || !who.length} onClick={go}>{busy ? 'Saving…' : 'Give credit'}</button>
        </span>
      </div>
    </Sheet>
  )
}

function ImportSheet({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const toast = useToast()
  const [plan, setPlan] = useState<ReturnType<typeof planImport> | null>(null)
  const [busy, setBusy] = useState(false)
  function read(file: File) {
    const r = new FileReader()
    r.onload = () => {
      const rows = readContacts(String(r.result))
      if (!rows.length) return toast("That file doesn't have any names to bring in.")
      setPlan(planImport(rows, ctx.data.contacts))
    }
    r.readAsText(file)
  }
  async function go() {
    if (!plan) return
    setBusy(true)
    try {
      if (plan.fresh.length) await api.importContacts(ctx.me, plan.fresh.map((r) => ({ ...r, tier: r.tier ?? 'B', source: 'CSV import' })))
      if (plan.updates.length) await api.updateContacts(plan.updates)
      await ctx.reload()
      toast([plan.fresh.length && `${plan.fresh.length} added`, plan.updates.length && `${plan.updates.length} updated`].filter(Boolean).join(', ') + '.')
      onClose()
    } catch (e) {
      toast(`Couldn't import: ${(e as Error).message}`)
      setBusy(false)
    }
  }
  const nothing = plan && !plan.fresh.length && !plan.updates.length
  return (
    <Sheet label="Import contacts" onClose={onClose}>
      <h3>Bring in a spreadsheet</h3>
      <p className="note" style={{ margin: '4px 0 12px' }}>A CSV file, like a BoldTrail export. It reads names, phone, email, address, birthday, closing date and tier. Anyone already here gets their info updated instead of added twice.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      {plan && (
        <div className="card stack" style={{ marginTop: 14, background: 'var(--bg)', boxShadow: 'none' }}>
          <p><b>{plan.fresh.length}</b> new {plan.fresh.length === 1 ? 'person' : 'people'} to add</p>
          <p><b>{plan.updates.length}</b> already here with new info to update{plan.same ? ` (${plan.same} already up to date)` : ''}</p>
          {plan.updates.length > 0 && (
            <details className="more" style={{ marginTop: 0 }}>
              <summary>See what changes</summary>
              <div style={{ fontSize: 14 }}>
                {plan.updates.slice(0, 50).map((u) => (
                  <p key={u.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}><b style={{ fontWeight: 500 }}>{u.name}</b>: {Object.keys(u.fields).map((k) => k.replace('_', ' ').replace('home anniversary', 'closing date')).join(', ')}</p>
                ))}
                {plan.updates.length > 50 && <p className="note">and {plan.updates.length - 50} more</p>}
              </div>
            </details>
          )}
          <p className="note">Updates only fill in or change info. Nothing gets erased, and tiers you set in the app stay as they are.</p>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn gold" disabled={!plan || !!nothing || busy} onClick={go}>{busy ? 'Working…' : nothing ? 'Nothing new' : 'Import'}</button>
      </div>
    </Sheet>
  )
}

// Re-exported helpers for coach and broker views
export function agentSummary(d: api.AgentData, agentId: string, goal: number, tierDaysMap?: Profile['tier_days']) {
  const ms = ymd(monthStart())
  const mine = d.touches.filter((t) => t.agent_id === agentId)
  const month = mine.filter((t) => !t.is_group && t.occurred_on >= ms)
  const contacts = d.contacts.filter((c) => c.agent_id === agentId)
  const byContact = touchCounts(mine)
  const h = { hot: 0, warm: 0, cold: 0, new: 0 }
  for (const c of contacts) h[heat(c, byContact, goal, tierDaysMap)]++
  const n = contacts.length || 1
  const lastLog = mine.filter((t) => !t.is_group).map((t) => t.occurred_on).sort().at(-1)
  return {
    calls: month.filter((t) => t.kind === 'call').length,
    texts: month.filter((t) => t.kind === 'text').length,
    cards: month.filter((t) => t.kind === 'card').length,
    monthTouches: month.length,
    contacts: contacts.length,
    heat: [Math.round((h.hot / n) * 100), Math.round((h.warm / n) * 100), Math.round(((h.cold + h.new) / n) * 100)] as [number, number, number],
    lastLogDays: lastLog ? daysBetween(parse(lastLog), today()) : null,
  }
}

export { HEAT_NAME }
