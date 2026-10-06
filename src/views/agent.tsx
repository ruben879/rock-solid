import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as api from '../lib/data'
import { addDays, daysBetween, fmt, monthName, monthStart, parse, today, weekStart, ymd } from '../lib/dates'
import type { Brokerage, Contact, Heat, Profile, Tier, TouchKind } from '../lib/model'
import {
  HEAT_NAME, KIND_LABEL, TIER_NAMES, cardWithin12Months, duePool, fullName, heat, nextDue, score, suggestKind, telOf, tierDays, touchCounts,
} from '../lib/model'
import { Celebrate, HeatTag, Sheet, Therm, store, useToast } from '../ui'

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

export function AgentWorkspace(props: { me: Profile; agent: Profile; brokerage: Brokerage | null; tab: AgentTab; readOnly: boolean; onProfileChange?: () => void }) {
  const { data, error, reload } = useAgentData1(props.agent.id)
  if (error) return <p className="error">Couldn't load data: {error}</p>
  if (!data) return <p className="muted">Loading…</p>
  const ctx: Ctx = { ...props, data, reload, goal: props.brokerage?.settings?.touch_goal ?? 36 }
  return (
    <>
      {props.tab === 'week' && <NextTen ctx={ctx} />}
      {props.tab === 'cards' && <CardADay ctx={ctx} onProfileChange={props.onProfileChange} />}
      {props.tab === 'activity' && <Monthly ctx={ctx} onProfileChange={props.onProfileChange} />}
      {props.tab === 'db' && <Database ctx={ctx} onProfileChange={props.onProfileChange} />}
    </>
  )
}

function useAgentData1(id: string) {
  const ids = useMemo(() => [id], [id])
  return api.useAgentData(ids)
}

// ======================================================================
// Your Next 10
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

function NextTen({ ctx }: { ctx: Ctx }) {
  const { data, agent, readOnly } = ctx
  const toast = useToast()
  const b = useBatch(ctx)
  const byContact = useMemo(() => touchCounts(data.touches), [data.touches])
  const [logFor, setLogFor] = useState<Contact | null>(null)
  const [editFor, setEditFor] = useState<Contact | null>(null)
  const [reach, setReach] = useState<{ c: Contact; kind: 'call' | 'text' } | null>(null)
  const [cele, setCele] = useState<{ eyebrow: string; title: string; sub: string } | null>(null)
  const pendingCheck = useRef(false)

  const byId = new Map(data.contacts.map((c) => [c.id, c]))
  const rows = b.ids.map((id) => byId.get(id)).filter(Boolean) as Contact[]
  const done = rows.filter((c) => b.touchedThisWeek.has(c.id)).length
  const g = goalState(ctx)

  // Celebrate once per goal per day/week, only right after the agent logs something.
  useEffect(() => {
    if (!pendingCheck.current || readOnly) return
    pendingCheck.current = false
    const dk = ymd(today())
    const wk = ymd(weekStart())
    const seen = store.get<Record<string, boolean>>(`rs-cele-${agent.id}`, {})
    const caught = rows.length > 0 && done === rows.length && b.waiting === 0
    const list: [boolean, string, string, string, string][] = [
      [caught, `caught-${wk}`, 'Congratulations', "You're all caught up!", "Everyone due this week has been touched. That's a rock solid week."],
      [g.week >= agent.weekly_goal, `week-${wk}`, 'Weekly goal', 'You hit your weekly goal!', `${g.week} touches this week. Every one is a vote for the business you're building.`],
      [g.today >= agent.daily_goal, `day-${dk}`, 'Daily goal', 'You hit your daily goal!', `${g.today} touches today. Same time tomorrow?`],
      [g.card, `card-${dk}`, 'Card a Day', 'Card a Day: done!', "Today's card is written and logged."],
    ]
    const hit = list.find(([ok, k]) => ok && !seen[k])
    if (!hit) return
    for (const [ok, k] of list) if (ok) seen[k] = true
    store.set(`rs-cele-${agent.id}`, seen)
    setCele({ eyebrow: hit[2], title: hit[3], sub: hit[4] })
  })

  async function log(c: Contact, kind: TouchKind, note: string) {
    try {
      await api.logTouch(ctx.me, c.id, kind, note)
      pendingCheck.current = true
      await ctx.reload()
      const nd = addDays(today(), tierDays(agent, c.tier))
      toast(`${KIND_LABEL[kind]} logged for ${c.first_name}. Next up ${fmt(nd)}.`)
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`)
    }
  }

  async function skip(c: Contact) {
    try {
      await api.skipToNextWeek(c)
      const nx = b.replace(c.id)
      await ctx.reload()
      toast(`${c.first_name} moved to next week.${nx ? ` ${nx.first_name} took their spot.` : ''}`)
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`)
    }
  }

  // Calendar blocks for what's left this round
  const remaining = rows.filter((c) => !b.touchedThisWeek.has(c.id))
  const days = [0, 1, 2, 3, 4].map((i) => addDays(weekStart(), i))
  const t0 = today()
  const open = days.filter((d) => ymd(d) >= ymd(t0))
  const buckets: Contact[][] = days.map(() => [])
  if (open.length) remaining.forEach((c, i) => buckets[days.findIndex((d) => ymd(d) === ymd(open[i % open.length]))].push(c))
  const slots = ['9:00–9:30 AM', '9:00–9:30 AM', '8:30–9:00 AM', '9:00–9:30 AM', '8:30–9:00 AM']

  function copyPlan() {
    const txt = days
      .map((d, i) => ({ d, i, people: buckets[i] }))
      .filter((x) => x.people.length)
      .map((x) => `${x.d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} ${slots[x.i]}\n` + x.people.map((c) => `  - ${KIND_LABEL[suggestKind(c, data.touches)]} ${fullName(c)}${c.phone ? ` (${c.phone})` : ''}`).join('\n'))
      .join('\n\n')
    if (!txt) return toast('Nothing left to plan this round.')
    navigator.clipboard?.writeText(txt).then(() => toast('Week plan copied. Paste it into your calendar.'), () => toast("Copy isn't available here."))
  }

  const p = rows.length ? Math.round((done / rows.length) * 100) : 100
  return (
    <section>
      <h2>Your next 10</h2>
      <p className="sub">Work these 10 and the next 10 load on their own. Anyone you don't get to just waits their turn, so the list never piles up.</p>
      <div className="progress">
        {rows.length ? (
          <>
            <b>{done} of {rows.length}</b>
            <div className="track"><div className={`fill ${p === 100 ? 'hit' : ''}`} style={{ width: `${p}%` }} /></div>
            <span className="note">Round {b.round} this week</span>
          </>
        ) : (
          <>
            <b>All caught up</b>
            <span className="note">{data.contacts.length ? 'Nobody else is due this week.' : 'Add or import contacts on the Database tab to get started.'}</span>
          </>
        )}
      </div>
      <div className="goals">
        <GoalTile label="Today" n={g.today} goal={agent.daily_goal} hit="Daily goal hit ✓" />
        <GoalTile label="This week" n={g.week} goal={agent.weekly_goal} hit="Weekly goal hit ✓" />
        <GoalTile label="Card a Day" n={g.card ? 1 : 0} goal={1} hit="Card written ✓" />
      </div>
      {b.justCleared && (
        <div className="banner" style={{ marginTop: 10 }}>
          <p><b>You cleared 10.</b> Your next 10 are loaded below. Keep the streak going or come back tomorrow.</p>
          <button className="btn ghost" onClick={() => b.setJustCleared(false)}>Got it</button>
        </div>
      )}
      {!b.justCleared && rows.length > 0 && done === rows.length && b.waiting === 0 && (
        <div className="banner" style={{ marginTop: 10 }}><p><b>You're caught up for the week.</b> Everyone else is scheduled for a later week.</p></div>
      )}

      <div className="grp">On deck</div>
      <div className="list">
        {rows.map((c) => {
          const isDone = b.touchedThisWeek.has(c.id)
          const last = [...data.touches].reverse().find((t) => t.contact_id === c.id)
          return (
            <div key={c.id} className={`row ${isDone ? 'done' : ''}`}>
              <div className={`tier t${c.tier}`} title={c.tier === 'U' ? 'No tier yet' : `Tier ${c.tier}`}>{c.tier === 'U' ? '?' : c.tier}</div>
              <div style={{ minWidth: 0 }}>
                <div className="nm">{fullName(c)}</div>
                <div className="meta">
                  {isDone ? <span className="chip">{last ? KIND_LABEL[last.kind] : 'Touched'} ✓</span> : <span className="chip sug">Suggested: {KIND_LABEL[suggestKind(c, data.touches)]}</span>}
                  {c.tier === 'U' && !isDone && <span className="chip">Needs a tier</span>}
                  <span>{c.last_touch_on ? `Last touch ${fmt(c.last_touch_on)}` : 'No touches yet'}</span>
                </div>
                <div style={{ marginTop: 4 }}><Therm c={c} byContact={byContact} goal={ctx.goal} sm /></div>
              </div>
              {!isDone && !readOnly && (
                <div className="acts">
                  {c.phone && (
                    <>
                      <a className="btn" href={`tel:${telOf(c.phone)}`} onClick={() => setReach({ c, kind: 'call' })}>Call</a>
                      <a className="btn" href={`sms:${telOf(c.phone)}`} onClick={() => setReach({ c, kind: 'text' })}>Text</a>
                    </>
                  )}
                  <button className="btn primary" onClick={() => setLogFor(c)}>Log</button>
                  <button className="btn ghost" onClick={() => setEditFor(c)}>Edit</button>
                  <button className="btn ghost" onClick={() => skip(c)}>Next week</button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {remaining.length > 0 && (
        <>
          <div className="grp">
            <span>Suggested calendar blocks</span>
            <button className="btn" onClick={copyPlan}>Copy week plan</button>
          </div>
          <div className="plan">
            {days.map((d, i) => {
              const isToday = ymd(d) === ymd(t0)
              const past = ymd(d) < ymd(t0)
              return (
                <div key={i} className={`day ${isToday ? 'today' : ''}`}>
                  <div className="dn">{d.toLocaleDateString('en-US', { weekday: 'short' })} {fmt(d)}</div>
                  <div className="slot">{past ? 'Done' : buckets[i].length ? `${slots[i]} · ${buckets[i].length}` : 'Open'}</div>
                  {buckets[i].length > 0 && (
                    <ul>{buckets[i].map((c) => <li key={c.id}>{KIND_LABEL[suggestKind(c, data.touches)]} {c.first_name} {c.last_name.slice(0, 1)}.</li>)}</ul>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {logFor && <LogSheet c={logFor} suggested={suggestKind(logFor, data.touches)} onClose={() => setLogFor(null)} onLog={(k, n) => { setLogFor(null); log(logFor, k, n) }} />}
      {editFor && <EditSheet ctx={ctx} c={editFor} onClose={() => setEditFor(null)} />}
      {reach && (
        <div className="reach" role="status">
          <span>{reach.kind === 'call' ? 'Called' : 'Texted'} {reach.c.first_name}? <span style={{ opacity: 0.75 }}>{reach.c.phone}</span></span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn gold" onClick={() => { const r = reach; setReach(null); log(r.c, r.kind, '') }}>Log {reach.kind}</button>
            <button className="btn" onClick={() => setReach(null)}>Not yet</button>
          </span>
        </div>
      )}
      {cele && <Celebrate {...cele} onClose={() => setCele(null)} />}
    </section>
  )
}

function GoalTile({ label, n, goal, hit }: { label: string; n: number; goal: number; hit: string }) {
  const ok = n >= goal
  const p = Math.min(100, Math.round((n / Math.max(1, goal)) * 100))
  return (
    <div className={`goal ${ok ? 'hit' : ''}`}>
      <div className="top"><span>{ok ? hit : label}</span><b>{n} / {goal}</b></div>
      <div className="track"><div className={`fill ${ok ? 'hit' : ''}`} style={{ width: `${p}%` }} /></div>
    </div>
  )
}

function LogSheet({ c, suggested, onClose, onLog }: { c: Contact; suggested: TouchKind; onClose: () => void; onLog: (k: TouchKind, note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Sheet label="Log a touch" onClose={onClose}>
      <h3>{fullName(c)}</h3>
      <div className="note">{c.phone ?? 'No phone'} · {c.tier === 'U' ? 'No tier yet' : `Tier ${c.tier} · ${TIER_NAMES[c.tier]}`}</div>
      <div className="opts">
        {(['call', 'text', 'card', 'popby'] as TouchKind[]).map((k) => (
          <button key={k} className={`btn lg ${k === suggested ? 'primary' : ''}`} onClick={() => onLog(k, note)}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <textarea aria-label="Note" placeholder="Quick note (optional): kids, job change, thinking about selling…" value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Sheet>
  )
}

// ======================================================================
// Edit / add contact
// ======================================================================
function EditSheet({ ctx, c, onClose }: { ctx: Ctx; c: Contact | null; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({
    first_name: c?.first_name ?? '', last_name: c?.last_name ?? '', phone: c?.phone ?? '', email: c?.email ?? '',
    address: c?.address ?? '', city: c?.city ?? '', state: c?.state ?? 'TX', zip: c?.zip ?? '',
    tier: (c?.tier ?? 'U') as Tier, birthday: c?.birthday ?? '', home_anniversary: c?.home_anniversary ?? '', notes: c?.notes ?? '',
  })
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!f.first_name.trim()) return
    setBusy(true)
    try {
      const input: api.ContactInput = {
        ...f, first_name: f.first_name.trim(), last_name: f.last_name.trim(),
        phone: f.phone || null, email: f.email || null, address: f.address || null, city: f.city || null, state: f.state || null, zip: f.zip || null,
        birthday: f.birthday || null, home_anniversary: f.home_anniversary || null, notes: f.notes || null,
      }
      await api.saveContact(ctx.me, input, c?.id)
      await ctx.reload()
      toast(c ? 'Saved.' : `${f.first_name} added. They're due now.`)
      onClose()
    } catch (err) {
      toast(`Couldn't save: ${(err as Error).message}`)
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
    <Sheet label={c ? 'Edit contact' : 'Add contact'} onClose={onClose}>
      <form onSubmit={submit}>
        <h3 style={{ marginBottom: 10 }}>{c ? 'Edit contact' : 'Add contact'}</h3>
        <div className="ed">
          <label className="field"><span>First name</span><input required value={f.first_name} onChange={set('first_name')} /></label>
          <label className="field"><span>Last name</span><input value={f.last_name} onChange={set('last_name')} /></label>
          <label className="field"><span>Phone</span><input inputMode="tel" value={f.phone} onChange={set('phone')} /></label>
          <label className="field"><span>Tier</span>
            <select value={f.tier} onChange={set('tier')}>
              {(['U', 'A', 'B', 'C', 'D'] as Tier[]).map((t) => <option key={t} value={t}>{t === 'U' ? 'No tier · monthly' : `${t} · ${TIER_NAMES[t]}`}</option>)}
            </select>
          </label>
          <label className="field full"><span>Email</span><input type="email" value={f.email} onChange={set('email')} /></label>
          <label className="field full"><span>Address</span><input value={f.address} onChange={set('address')} /></label>
          <label className="field"><span>City</span><input value={f.city} onChange={set('city')} /></label>
          <label className="field"><span>Zip</span><input value={f.zip} onChange={set('zip')} /></label>
          <label className="field"><span>Birthday</span><input type="date" value={f.birthday} onChange={set('birthday')} /></label>
          <label className="field"><span>Home anniversary</span><input type="date" value={f.home_anniversary} onChange={set('home_anniversary')} /></label>
          <label className="field full"><span>Notes</span><textarea value={f.notes} onChange={set('notes')} placeholder="Kids, pets, what they care about" /></label>
        </div>
        {confirmDel && (
          <div className="warn" style={{ marginTop: 10 }}>
            Remove {c?.first_name} from your database? <button type="button" className="btn" onClick={del}>Remove</button> <button type="button" className="btn ghost" onClick={() => setConfirmDel(false)}>Keep</button>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {c ? <button type="button" className="btn ghost" onClick={() => setConfirmDel(true)}>Remove contact</button> : <span />}
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </span>
        </div>
      </form>
    </Sheet>
  )
}

// ======================================================================
// Card a Day
// ======================================================================
const RELS = ['Friend', 'Family', 'Client', 'Agent/Colleague', 'Vendor', 'Other']
const OCCASIONS = ['Thank You', 'Birthday', 'Just Because', 'Congratulations', 'Encouragement', 'Follow-Up', 'Other']

function CardADay({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly } = ctx
  const toast = useToast()
  const [name, setName] = useState('')
  const [rel, setRel] = useState('')
  const [occ, setOcc] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [cele, setCele] = useState(false)
  const dup = name.trim() ? cardWithin12Months(data.cards, name) : undefined
  const counting = data.cards.filter((c) => c.counts_for_challenge)
  const days = new Set(counting.map((c) => c.sent_on))
  let streak = 0
  for (let d = today(); ; d = addDays(d, -1)) {
    if (days.has(ymd(d))) streak++
    else if (ymd(d) === ymd(today())) continue
    else break
  }
  const ms = ymd(monthStart())
  const monthDays = [...days].filter((d) => d >= ms).length
  const yearCount = counting.filter((c) => c.sent_on.startsWith(String(today().getFullYear()))).length

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return toast('Add who you wrote to.')
    if (!rel || !occ) return toast(!rel ? 'Pick who they are to you.' : 'Pick which card.')
    setBusy(true)
    try {
      const hadCardToday = data.cards.some((c) => c.sent_on === ymd(today()) && c.counts_for_challenge)
      const r = await api.logCard(ctx.me, data.cards, data.contacts, { name, relationship: rel, occasion: occ, note })
      await ctx.reload()
      setName(''); setRel(''); setOcc(''); setNote('')
      toast(`Card logged ✓${r.repeat ? ' Counted as a touch only, since it repeats within 12 months.' : ''}${r.match ? ` ${r.match.first_name} checked off in your database too.` : ''}`)
      const key = `rs-cele-${agent.id}`
      const seen = store.get<Record<string, boolean>>(key, {})
      if (!r.repeat && !hadCardToday && !seen[`card-${ymd(today())}`]) {
        seen[`card-${ymd(today())}`] = true
        store.set(key, seen)
        setCele(true)
      }
    } catch (err) {
      toast(`Couldn't save: ${(err as Error).message}`)
    }
    setBusy(false)
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
      <h2>Card a Day</h2>
      <p className="sub">One handwritten card a day. Log it here and it counts toward your monthly cards and the drawing.</p>
      <div className="cad">
        {!readOnly ? (
          <form className="card stack" onSubmit={submit}>
            <label className="field"><span>Who did you write a card to today?</span>
              <input list="cad-people" autoComplete="off" placeholder="Start typing a name" value={name} onChange={(e) => setName(e.target.value)} />
              <datalist id="cad-people">{data.contacts.map((c) => <option key={c.id} value={fullName(c)} />)}</datalist>
            </label>
            {dup && agent.card_rule && (
              <div className="warn">Already wrote {name.trim()} a card on {fmt(dup.sent_on)}. It will still log as a touch, but won't count toward Card a Day until {fmt(addDays(parse(dup.sent_on), 365))}.</div>
            )}
            <div className="field"><span>Who are they to you?</span>
              <div className="chips">{RELS.map((r) => <button type="button" key={r} aria-pressed={rel === r} onClick={() => setRel(r)}>{r}</button>)}</div>
            </div>
            <div className="field"><span>Which card?</span>
              <div className="chips">{OCCASIONS.map((r) => <button type="button" key={r} aria-pressed={occ === r} onClick={() => setOcc(r)}>{r}</button>)}</div>
            </div>
            <label className="field"><span>Note (optional)</span><textarea placeholder="Leave blank to skip" value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <label className="note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={agent.card_rule} onChange={(e) => toggleRule(e.target.checked)} /> Only count each person once every 12 months
            </label>
            <button className="btn gold lg" disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Saving…' : 'Log card'}</button>
          </form>
        ) : (
          <div className="card note">Cards are logged by the agent. Their history is on the right.</div>
        )}
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="stats">
            <div className="stat"><div className="n">{streak}</div><div className="l">Day streak</div></div>
            <div className="stat"><div className="n">{monthDays}/{today().getDate()}</div><div className="l">Days this month</div></div>
            <div className="stat"><div className="n">{yearCount}</div><div className="l">Cards this year</div></div>
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 8 }}>{today().toLocaleDateString('en-US', { month: 'long' })} cards</h3>
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
          </div>
          <div className="card">
            <h3 style={{ marginBottom: 6 }}>Recent cards</h3>
            <div className="stack" style={{ gap: 6, fontSize: 14 }}>
              {[...data.cards].reverse().slice(0, 8).map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                  <span><b>{c.recipient_name}</b> <span className="note">· {c.occasion} · {c.relationship}{c.counts_for_challenge ? '' : ' · touch only'}</span></span>
                  <span className="note">{fmt(c.sent_on)}</span>
                </div>
              ))}
              {data.cards.length === 0 && <span className="note">No cards yet.</span>}
            </div>
          </div>
        </div>
      </div>
      {cele && <Celebrate eyebrow="Card a Day" title="Card a Day: done!" sub="Today's card is written and logged." onClose={() => setCele(false)} />}
    </section>
  )
}

// ======================================================================
// Monthly activity + my plan + goals
// ======================================================================
const TALLIES = [
  { k: 'giveaway', l: 'Monthly giveaway' },
  { k: 'video', l: 'Squeeze / video' },
  { k: 'email', l: 'Monthly email' },
  { k: 'openhouse', l: 'Open houses' },
  { k: 'social', l: 'Social posts' },
]

function Monthly({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly, brokerage } = ctx
  const toast = useToast()
  const ms = ymd(monthStart())
  const month = data.touches.filter((t) => !t.is_group && t.occurred_on >= ms)
  const goals = { call: 21, text: 21, card: 7, ...(brokerage?.settings?.monthly_goals ?? {}) }
  const count = (k: TouchKind) => month.filter((t) => t.kind === k).length

  async function bump(k: string, d: number) {
    try {
      await api.bumpTally(ctx.me, data.tallies, k, d)
      await ctx.reload()
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`)
    }
  }
  return (
    <section>
      <h2>{monthName()}</h2>
      <p className="sub">Every touch logged on Your Next 10 and Card a Day counts here automatically. Tap + and − for everything else.</p>
      <div className="grp">Rock Solid · database touches</div>
      <div className="card bars">
        {(['call', 'text', 'card'] as const).map((k) => {
          const n = count(k)
          const goal = goals[k] ?? 1
          const p = Math.min(100, Math.round((n / goal) * 100))
          return (
            <div key={k} className="bar">
              <div className="top"><span>{KIND_LABEL[k]}s</span><b>{n} / {goal} · {p}%</b></div>
              <div className="track"><div className={`fill ${p >= 100 ? 'hit' : ''}`} style={{ width: `${p}%` }} /></div>
            </div>
          )
        })}
        <div className="note">Pop-bys this month: {count('popby')}</div>
      </div>
      <div className="grp">Monthly push</div>
      <div className="tally">
        {TALLIES.map((t) => {
          const v = data.tallies.find((x) => x.kind === t.k)?.count ?? 0
          return (
            <div key={t.k} className="tl">
              <div style={{ fontWeight: 600 }}>{t.l}</div>
              <div className="c">
                {!readOnly && <button className="btn sq" aria-label={`Subtract one ${t.l}`} onClick={() => bump(t.k, -1)}>−</button>}
                <span className="v">{v}</span>
                {!readOnly && <button className="btn sq" aria-label={`Add one ${t.l}`} onClick={() => bump(t.k, 1)}>+</button>}
              </div>
            </div>
          )
        })}
      </div>
      <MyPlan ctx={ctx} onProfileChange={onProfileChange} />
      {!readOnly && <MyGoals agent={agent} me={ctx.me} onProfileChange={onProfileChange} />}
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
    <>
      <div className="grp">My goals</div>
      <div className="card toolbar" style={{ margin: 0 }}>
        <label className="note" htmlFor="gDay">Daily goal (touches)</label>
        <input id="gDay" type="number" min={1} style={{ width: 80 }} value={day} onChange={(e) => setDay(+e.target.value)} onBlur={() => save({ daily_goal: Math.max(1, day || 1) })} />
        <label className="note" htmlFor="gWeek">Weekly goal (touches)</label>
        <input id="gWeek" type="number" min={1} style={{ width: 80 }} value={week} onChange={(e) => setWeek(+e.target.value)} onBlur={() => save({ weekly_goal: Math.max(1, week || 1) })} />
      </div>
    </>
  )
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
  async function save() {
    await api.updateMyProfile(ctx.me, { plan: p })
    onProfileChange?.()
  }
  const num = (k: keyof typeof p, label: string, step = 1) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} disabled={readOnly} value={p[k]} onChange={(e) => setP({ ...p, [k]: +e.target.value })} onBlur={save} />
    </label>
  )
  return (
    <>
      <div className="grp">My {today().getFullYear()} plan</div>
      <div className="card stack">
        <div className="ed" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          {num('income', 'Take-home goal ($)', 1000)}
          {num('cap', 'Cap / splits ($)', 500)}
          {num('price', 'Avg sale price ($)', 5000)}
          {num('rate', 'Commission rate (%)', 0.1)}
          {num('conversion', 'Database conversion (%)', 1)}
        </div>
        <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          <div className="stat"><div className="n">{money(gci)}</div><div className="l">GCI needed</div></div>
          <div className="stat"><div className="n">{money(perDeal)}</div><div className="l">Per transaction</div></div>
          <div className="stat"><div className="n">{deals}</div><div className="l">Transactions</div></div>
          <div className="stat"><div className="n">{dbNeeded}</div><div className="l">Contacts needed</div></div>
        </div>
        <p className="note">
          You have {have} contacts {have >= dbNeeded ? `, enough for this plan at ${p.conversion}% conversion.` : `. Add ${dbNeeded - have} more to support this plan.`} At 36 touches each, that's about {Math.round((dbNeeded * 36) / 52)} touches a week.
        </p>
      </div>
    </>
  )
}

// ======================================================================
// Database
// ======================================================================
function Database({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly } = ctx
  const toast = useToast()
  const byContact = useMemo(() => touchCounts(data.touches), [data.touches])
  const [q, setQ] = useState('')
  const [tf, setTf] = useState<Tier | ''>('')
  const [hf, setHf] = useState<Heat | ''>('')
  const [sort, setSort] = useState<'cold' | 'hot' | 'next' | 'name'>('cold')
  const [edit, setEdit] = useState<Contact | null | 'new'>(null)
  const [group, setGroup] = useState(false)
  const [importing, setImporting] = useState(false)

  const heats = new Map(data.contacts.map((c) => [c.id, heat(c, byContact, ctx.goal)]))
  const counts: Record<Heat, number> = { hot: 0, warm: 0, cold: 0, new: 0 }
  for (const h of heats.values()) counts[h]++
  const sorter = {
    cold: (a: Contact, b: Contact) => score(a, byContact) - score(b, byContact),
    hot: (a: Contact, b: Contact) => score(b, byContact) - score(a, byContact),
    next: (a: Contact, b: Contact) => nextDue(a, agent).getTime() - nextDue(b, agent).getTime(),
    name: (a: Contact, b: Contact) => fullName(a).localeCompare(fullName(b)),
  }[sort]
  const list = data.contacts
    .filter((c) => (!tf || c.tier === tf) && (!hf || heats.get(c.id) === hf) && fullName(c).toLowerCase().includes(q.toLowerCase()))
    .sort(sorter)

  async function setTier(c: Contact, tier: Tier) {
    try {
      await api.saveContact(ctx.me, { first_name: c.first_name, tier }, c.id)
      await ctx.reload()
      toast(`${c.first_name} is now ${tier === 'U' ? 'untagged (monthly)' : `Tier ${tier}`}.`)
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`)
    }
  }
  async function setDays(t: Tier, v: number) {
    await api.updateMyProfile(ctx.me, { tier_days: { ...agent.tier_days, [t]: Math.max(1, v || 1) } })
    onProfileChange?.()
  }

  return (
    <section>
      <h2>Database</h2>
      <p className="sub">Tier sets how often someone comes up, and the thermometer shows whether each relationship is on pace over the last 12 months. Anyone without a tier comes up monthly until you tag them.</p>
      <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 12 }}>
        {(['A', 'B', 'C', 'D', 'U'] as Tier[]).map((t) => (
          <div key={t} className="stat">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`tier t${t}`} style={{ width: 22, height: 22, fontSize: 12 }}>{t === 'U' ? '?' : t}</span>
              <b style={{ fontFamily: 'var(--display)', fontSize: 16 }}>{TIER_NAMES[t]}</b>
            </div>
            <div className="note" style={{ marginTop: 4 }}>
              {data.contacts.filter((c) => c.tier === t).length} contacts · every{' '}
              {readOnly ? tierDays(agent, t) : (
                <input type="number" min={1} aria-label={`Days between touches for tier ${t}`} defaultValue={tierDays(agent, t)} style={{ width: 54, padding: '2px 6px' }} onBlur={(e) => setDays(t, +e.target.value)} />
              )}{' '}days
            </div>
          </div>
        ))}
      </div>
      <div className="heatbar">
        {(['hot', 'warm', 'cold', ...(counts.new ? ['new'] : [])] as Heat[]).map((h) => (
          <button key={h} className={`therm h-${h}`} aria-pressed={hf === h} onClick={() => setHf(hf === h ? '' : h)}>
            <HeatTag h={h} label /> <span className="note">{counts[h]}</span>
          </button>
        ))}
        <span className="note">Bulb = touches in the last 12 months, out of {ctx.goal}.</span>
      </div>
      <div className="toolbar">
        <select aria-label="Sort contacts" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="cold">Most urgent first</option>
          <option value="hot">On pace first</option>
          <option value="next">Next up</option>
          <option value="name">Name</option>
        </select>
        <input type="search" placeholder="Search name" aria-label="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by tier" value={tf} onChange={(e) => setTf(e.target.value as Tier | '')}>
          <option value="">All tiers</option>
          {(['A', 'B', 'C', 'D', 'U'] as Tier[]).map((t) => <option key={t} value={t}>{t === 'U' ? 'No tier' : t}</option>)}
        </select>
        {!readOnly && (
          <>
            <button className="btn primary" onClick={() => setEdit('new')}>Add contact</button>
            <button className="btn" onClick={() => setImporting(true)}>Import CSV</button>
            <button className="btn" onClick={() => setGroup(true)}>Log a group touch</button>
          </>
        )}
      </div>
      {data.contacts.length === 0 ? (
        <div className="card empty">No contacts yet. Add one or import a CSV to get started.</div>
      ) : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Tier</th><th>Last touch</th><th>Next up</th><th>Last 12 months</th><th /></tr></thead>
            <tbody>
              {list.map((c) => {
                const nd = nextDue(c, agent)
                return (
                  <tr key={c.id}>
                    <td>{fullName(c)}</td>
                    <td>{c.phone ?? ''}</td>
                    <td>
                      {readOnly ? (c.tier === 'U' ? 'None' : c.tier) : (
                        <select aria-label={`Tier for ${c.first_name}`} value={c.tier} onChange={(e) => setTier(c, e.target.value as Tier)}>
                          {(['U', 'A', 'B', 'C', 'D'] as Tier[]).map((t) => <option key={t} value={t}>{t === 'U' ? 'None' : t}</option>)}
                        </select>
                      )}
                    </td>
                    <td>{c.last_touch_on ? fmt(c.last_touch_on) : '—'}</td>
                    <td>{nd <= addDays(weekStart(), 6) ? 'This week' : fmt(nd)}</td>
                    <td><Therm c={c} byContact={byContact} goal={ctx.goal} /></td>
                    <td>{!readOnly && <button className="btn ghost" onClick={() => setEdit(c)}>Edit</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
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
          {(['A', 'B', 'C', 'D', 'U'] as Tier[]).map((t) => (
            <button key={t} type="button" aria-pressed={tiers.includes(t)} onClick={() => setTiers(tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t])}>{t === 'U' ? 'No tier' : `Tier ${t}`}</button>
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

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

function ImportSheet({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const toast = useToast()
  const [rows, setRows] = useState<api.ContactInput[] | null>(null)
  const [dupes, setDupes] = useState(0)
  const [busy, setBusy] = useState(false)
  function read(file: File) {
    const r = new FileReader()
    r.onload = () => {
      const all = parseCsv(String(r.result))
      if (all.length < 2) return toast('That file has no rows to import.')
      const head = all[0].map((h) => h.toLowerCase().trim())
      const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)))
      const fi = col('first name', 'first'), li = col('last name', 'last'), pi = col('cell phone 1', 'phone', 'mobile'), ei = col('email')
      const ai = col('primary address', 'address'), ci = col('primary city', 'city'), si = col('primary state', 'state'), zi = col('primary zip', 'zip')
      const ti = col('tier'), bi = col('birthday'), hi = col('last closing date', 'anniversary')
      const existing = new Set(ctx.data.contacts.map((c) => fullName(c).toLowerCase()))
      let d = 0
      const out: api.ContactInput[] = []
      for (const r of all.slice(1)) {
        const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
        const first = get(fi >= 0 ? fi : 0)
        if (!first) continue
        const last = get(li)
        if (existing.has(`${first} ${last}`.trim().toLowerCase())) { d++; continue }
        const tierRaw = get(ti).toUpperCase()
        const date = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)
        out.push({
          first_name: first, last_name: last, phone: get(pi) || null, email: get(ei) || null, address: get(ai) || null,
          city: get(ci) || null, state: get(si) || null, zip: get(zi) || null,
          tier: (['A', 'B', 'C', 'D'].includes(tierRaw) ? tierRaw : 'U') as Tier,
          birthday: date(get(bi)), home_anniversary: date(get(hi)), source: 'CSV import',
        })
      }
      setRows(out)
      setDupes(d)
    }
    r.readAsText(file)
  }
  async function go() {
    if (!rows?.length) return
    setBusy(true)
    try {
      await api.importContacts(ctx.me, rows)
      await ctx.reload()
      const untagged = rows.filter((r) => r.tier === 'U').length
      toast(`${rows.length} imported${untagged ? `, ${untagged} with no tier (they'll come up monthly until tagged)` : ''}.`)
      onClose()
    } catch (e) {
      toast(`Couldn't import: ${(e as Error).message}`)
      setBusy(false)
    }
  }
  return (
    <Sheet label="Import contacts" onClose={onClose}>
      <h3>Import contacts from a CSV</h3>
      <p className="note" style={{ margin: '4px 0 12px' }}>Columns it understands: First Name, Last Name, Phone, Email, Address, City, State, Zip, Tier, Birthday. A BoldTrail export works as is. People already in your database are skipped.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      {rows && (
        <p style={{ marginTop: 12 }}>
          <b>{rows.length}</b> new contacts ready{dupes ? `, ${dupes} already in your database skipped` : ''}. They start as New and are spread across the next few weeks by the 10-at-a-time list.
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn gold" disabled={!rows?.length || busy} onClick={go}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
    </Sheet>
  )
}

// Re-exported helpers for coach and broker views
export function agentSummary(d: api.AgentData, agentId: string, goal: number) {
  const ms = ymd(monthStart())
  const mine = d.touches.filter((t) => t.agent_id === agentId)
  const month = mine.filter((t) => !t.is_group && t.occurred_on >= ms)
  const contacts = d.contacts.filter((c) => c.agent_id === agentId)
  const byContact = touchCounts(mine)
  const h = { hot: 0, warm: 0, cold: 0, new: 0 }
  for (const c of contacts) h[heat(c, byContact, goal)]++
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
