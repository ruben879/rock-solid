import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Contact, Profile, Stage, Temp, Touch, TouchKind } from '../lib/model'
import {
  KIND_LABEL, RECRUIT_KINDS, RETAIN_KINDS, STAGES, STAGE_HINT, STAGE_NAME, TEMP_NAME,
  fullName, joinAnniversaries, lastRecruitTouch, licenseCards, recruitDue, recruitQueue, telOf,
} from '../lib/model'
import { daysBetween, fmt, parse, today, ymd } from '../lib/dates'
import * as api from '../lib/data'
import type { RecruitData } from '../lib/data'
import { Celebrate, Sheet, store, useToast } from '../ui'
import { ICheck, IPhone, IPlus, ISearch, IText } from '../icons'
import { DateField, MonthDayField } from './agent'

/*
  Recruit mode: the broker's second sphere. Same people cards and touch logging, its own queue and rhythm.
  Recruits never show up in the client Today, People, Progress or Card a Day.
*/

export type Sphere = 'client' | 'recruit'
export interface RCtx { me: Profile; recruits: RecruitData; reload: () => Promise<void> }

/** Which side each screen is on. Kept while the app is open; every fresh open starts on My Sphere. */
const sphereNow = new Map<string, Sphere>()
export function useSphere(screen: string): [Sphere, (s: Sphere) => void] {
  const [v, setV] = useState<Sphere>(() => sphereNow.get(screen) ?? 'client')
  return [v, (s) => { setV(s); sphereNow.set(screen, s) }]
}

/** How many on the Agents side need a touch today: pipeline, retention, license cards and join anniversaries. */
export function agentsDueCount(contacts: Contact[], touches: Touch[]) {
  const q = recruitQueue(contacts, touches)
  const ids = new Set([...q.pipeline, ...q.retention].map((x) => x.c.id))
  for (const l of licenseCards(contacts, touches)) ids.add(l.c.id)
  for (const a of joinAnniversaries(contacts)) ids.add(a.c.id)
  return ids.size
}

export function SphereSwitch({ value, onChange, counts, badge }: { value: Sphere; onChange: (s: Sphere) => void; counts?: { client: number; recruit: number }; badge?: boolean }) {
  // The Today bubble follows whichever side is showing.
  useEffect(() => {
    if (!badge) return
    if (value === 'recruit' && counts) window.dispatchEvent(new CustomEvent('rs-open', { detail: counts.recruit }))
    if (value === 'client' && counts) window.dispatchEvent(new CustomEvent('rs-open', { detail: counts.client }))
  }, [badge, value, counts?.client, counts?.recruit]) // eslint-disable-line react-hooks/exhaustive-deps
  const n = (k: Sphere) => (counts && counts[k] > 0 ? <b className="swn">{counts[k]}</b> : null)
  return (
    <div className="seg4 x2 sphereswitch" role="group" aria-label="Which people">
      <button type="button" aria-pressed={value === 'client'} onClick={() => onChange('client')}>My Sphere{n('client')}</button>
      <button type="button" aria-pressed={value === 'recruit'} onClick={() => onChange('recruit')}>Agents{n('recruit')}</button>
    </div>
  )
}

const KIND_ICON: Partial<Record<TouchKind, string>> = {
  call: '📞', text: '💬', card: '✉️', coffee: '☕', intel: '📊', congrats: '🎉', invite: '📅', social: '👍',
  checkin: '👋', capchat: '🎯', win: '🏆', oneonone: '🤝', stage: '➜',
}
const SOURCES = ['Co-op deal', 'Event', 'Referral', 'Class', 'Other']
const ago = (d: string | null) => {
  if (!d) return 'No touch yet'
  const n = daysBetween(parse(d), today())
  return n <= 0 ? 'Touched today' : n === 1 ? 'Touched yesterday' : `Last touch ${n} days ago`
}
const dueLine = (due: string) => {
  const n = daysBetween(today(), parse(due))
  return n === 0 ? 'Due today' : n < 0 ? `${-n} ${n === -1 ? 'day' : 'days'} overdue` : `Next touch ${fmt(due)}`
}

function Chips({ c }: { c: Contact }) {
  const st = c.stage ?? 'cold'
  return (
    <span className="rchips">
      <span className={`rstage s-${st}`}>{STAGE_NAME[st]}</span>
      {st !== 'joined' && st !== 'nofit' && c.temperature && <span className={`rtemp t-${c.temperature}`}>{c.temperature === 'watch' ? 'Watch' : c.temperature}</span>}
    </span>
  )
}

// ======================================================================
// Recruiting Today: who's due in the pipeline, then retention check-ins
// ======================================================================
export function RecruitToday({ rc, onBoard }: { rc: RCtx; onBoard: () => void }) {
  const { recruits } = rc
  const q = useMemo(() => recruitQueue(recruits.contacts, recruits.touches), [recruits])
  const anniv = useMemo(() => joinAnniversaries(recruits.contacts), [recruits])
  const lic = useMemo(() => licenseCards(recruits.contacts, recruits.touches), [recruits])
  const [open, setOpen] = useState<Contact | null>(null)
  const [adding, setAdding] = useState(false)
  const t = ymd(today())
  const cooling = recruits.contacts.filter((c) => (c.stage === 'talking' || c.stage === 'warm') && (recruitDue(c, recruits.touches)?.due ?? t) < t).length
  const live = (c: Contact) => recruits.contacts.find((x) => x.id === c.id) ?? c
  return (
    <section>
      <div className="rhead">
        <h2>Agents</h2>
        <button className="btn primary" onClick={() => setAdding(true)}><IPlus size={18} /> Add agent</button>
      </div>
      {cooling > 0 && <p className="rcool">🧊 <b>{cooling} {cooling === 1 ? 'conversation' : 'conversations'} cooling off.</b> A quick touch keeps them warm.</p>}

      {recruits.contacts.length === 0 ? (
        <div className="card empty" style={{ marginTop: 16 }}>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>Your agent pipeline starts here</h3>
          <p>Add agents you'd love to have in the office: people you've met, been referred to, or done a deal across from. Rock Solid keeps the conversation from going cold, and keeps you close to the agents who join.</p>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>Add an agent</button>
        </div>
      ) : (
        <>
          {lic.length > 0 && (
            <>
              <div className="grp" style={{ marginTop: 18 }}>Congratulate <span className="note" style={{ fontWeight: 400 }}>license anniversaries</span></div>
              <div className="people">
                {lic.map(({ c, on, years, left }) => (
                  <LicenseRow key={`l-${c.id}`} rc={rc} c={c} on={on} years={years} left={left} onOpen={() => setOpen(c)} />
                ))}
              </div>
            </>
          )}
          <div className="grp" style={{ marginTop: 18 }}>Pipeline <span className="note" style={{ fontWeight: 400 }}>{q.pipeline.length} due</span></div>
          {q.pipeline.length === 0
            ? <p className="note rnone">Nobody due today. <button className="link" onClick={onBoard}>See the pipeline</button></p>
            : <div className="people">{q.pipeline.map(({ c, d }) => <RecruitRow key={c.id} rc={rc} c={c} due={d.due} onOpen={() => setOpen(c)} />)}</div>}

          {(q.retention.length > 0 || anniv.length > 0) && (
            <>
              <div className="grp" style={{ marginTop: 22 }}>Retention <span className="note" style={{ fontWeight: 400 }}>agents who've joined</span></div>
              <div className="people">
                {anniv.map(({ c, years }) => (
                  <RecruitRow key={`a-${c.id}`} rc={rc} c={c} onOpen={() => setOpen(c)}
                    badge={`🎉 ${years} ${years === 1 ? 'year' : 'years'} on the team today`} />
                ))}
                {q.retention.filter(({ c }) => !anniv.some((a) => a.c.id === c.id)).map(({ c, d }) => (
                  <RecruitRow key={c.id} rc={rc} c={c} due={d.due} onOpen={() => setOpen(c)} badge="Retention" />
                ))}
              </div>
            </>
          )}
          <button className="btn block" style={{ marginTop: 18 }} onClick={onBoard}>Open the pipeline board</button>
        </>
      )}
      {open && <RecruitSheet rc={rc} c={live(open)} onClose={() => setOpen(null)} />}
      {adding && <RecruitEdit rc={rc} c={null} onClose={() => setAdding(false)} />}
    </section>
  )
}

function RecruitRow({ rc, c, due, badge, onOpen }: { rc: RCtx; c: Contact; due?: string; badge?: string; onOpen: () => void }) {
  const [logging, setLogging] = useState(false)
  const [reach, setReach] = useState<'call' | 'text' | null>(null)
  const toast = useToast()
  const last = lastRecruitTouch(c, rc.recruits.touches)
  const name = c.first_name || fullName(c)
  async function log(kind: TouchKind) {
    setReach(null)
    try { await api.logRecruitTouch(rc.me, c, kind); await rc.reload(); toast(`${KIND_LABEL[kind]} logged for ${name}.`) } catch (e) { toast((e as Error).message) }
  }
  return (
    <article className={`person rrow ${badge === 'Retention' ? 'ret' : ''}`}>
      {badge && <span className={`fubadge ${badge === 'Retention' ? 'retbadge' : 'bdbadge'}`}>{badge}</span>}
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <h3><button className="namebtn" onClick={onOpen}>{fullName(c)}</button></h3>
          <p className="why">{[c.current_brokerage, ago(last)].filter(Boolean).join(' · ')}</p>
        </div>
        <Chips c={c} />
      </div>
      {due && <p className={`rdue ${due < ymd(today()) ? 'late' : ''}`}>{dueLine(due)}</p>}
      {reach ? (
        <div className="preach" role="status">
          <p>Did you {reach} {name}?</p>
          <div>
            <button className="btn gold" onClick={() => log(reach)}>Yes, log it</button>
            <button className="btn" onClick={() => setReach(null)}>Not yet</button>
          </div>
        </div>
      ) : (
        <div className="alts">
          {c.phone && <a className="alt k-call" href={`tel:${telOf(c.phone)}`} onClick={() => setReach('call')}><IPhone size={18} /> Call</a>}
          {c.phone && <a className="alt k-text" href={`sms:${telOf(c.phone)}`} onClick={() => setReach('text')}><IText size={18} /> Text</a>}
          <button className="alt" onClick={() => setLogging(true)}><ICheck size={18} /> Log a touch</button>
        </div>
      )}
      {logging && <LogSheet rc={rc} c={c} onClose={() => setLogging(false)} />}
    </article>
  )
}

/** A license anniversary (or someone newly licensed): a card to congratulate them. */
function LicenseRow({ rc, c, on, years, left, onOpen }: { rc: RCtx; c: Contact; on: string; years: number; left: number; onOpen: () => void }) {
  const toast = useToast()
  const name = c.first_name || fullName(c)
  const what = years === 0 ? `Newly licensed ${fmt(on)}` : `${years} ${years === 1 ? 'year' : 'years'} licensed ${left === 0 ? 'today' : fmt(on)}`
  async function sent() {
    try {
      await api.logRecruitTouch(rc.me, c, 'card', years === 0 ? 'Congrats on getting licensed card' : `${years}-year license anniversary card`)
      await rc.reload()
      toast(`Card logged for ${name}.`)
    } catch (e) { toast((e as Error).message) }
  }
  return (
    <article className="person rrow lic">
      <span className="fubadge licbadge">🎓 {what}</span>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <h3><button className="namebtn" onClick={onOpen}>{fullName(c)}</button></h3>
          <p className="why">{left > 0 ? 'Mail a congratulations card so it lands in time.' : left === 0 ? 'A card that shows up a little late still means a lot.' : 'A belated congratulations card still says you noticed.'}</p>
        </div>
        <Chips c={c} />
      </div>
      <button className="go k-card" onClick={sent}>✉️ I sent {name} a card</button>
    </article>
  )
}

/** Pick a recruiting touch type (or a retention one for agents who've joined), with an optional note. */
function LogSheet({ rc, c, onClose }: { rc: RCtx; c: Contact; onClose: () => void }) {
  const toast = useToast()
  const kinds = c.stage === 'joined' ? RETAIN_KINDS : RECRUIT_KINDS
  const [kind, setKind] = useState<TouchKind | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!kind) return
    setBusy(true)
    try { await api.logRecruitTouch(rc.me, c, kind, note.trim()); await rc.reload(); toast(`${KIND_LABEL[kind]} logged for ${c.first_name}.`); onClose() } catch (e) { toast((e as Error).message); setBusy(false) }
  }
  return (
    <Sheet label={`Log a touch with ${c.first_name}`} onClose={onClose}>
      <h3>Log a touch with {c.first_name}</h3>
      <div className="rkinds">
        {kinds.map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}><span>{KIND_ICON[k]}</span>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <label className="field" style={{ marginTop: 12 }}><span>Note (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you talked about, what to remember next time" />
      </label>
      <button className="btn primary lg block" style={{ marginTop: 12 }} disabled={!kind || busy} onClick={save}>{busy ? 'Saving…' : 'Log it'}</button>
    </Sheet>
  )
}

// ======================================================================
// Pipeline board: six stages, side by side
// ======================================================================
export function RecruitBoard({ rc }: { rc: RCtx }) {
  const { recruits } = rc
  const [open, setOpen] = useState<Contact | null>(null)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const list = recruits.contacts.filter((c) => !term || fullName(c).toLowerCase().includes(term) || (c.current_brokerage ?? '').toLowerCase().includes(term))
  const y = String(today().getFullYear())
  const joinedYear = recruits.contacts.filter((c) => c.stage === 'joined' && c.joined_on?.startsWith(y)).length
  const talking = recruits.contacts.filter((c) => c.stage === 'talking').length
  const live = (c: Contact) => recruits.contacts.find((x) => x.id === c.id) ?? c
  return (
    <section>
      <div className="rhead">
        <h2>Pipeline<small>{recruits.contacts.length}</small></h2>
        <button className="btn primary" onClick={() => setAdding(true)}><IPlus size={18} /> Add agent</button>
      </div>
      <div className="stats rstats">
        <div className="stat"><div className="n">{recruits.contacts.filter((c) => c.stage !== 'nofit').length}</div><div className="l">In the pipeline</div></div>
        <div className="stat"><div className="n">{talking}</div><div className="l">In conversation</div></div>
        <div className="stat"><div className="n">{joinedYear}</div><div className="l">Joined in {y}</div></div>
      </div>
      <div className="search" style={{ marginTop: 12 }}><ISearch size={20} /><input type="search" placeholder="Find an agent or brokerage" aria-label="Find an agent" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="rboard">
        {STAGES.map((s) => {
          const col = list.filter((c) => (c.stage ?? 'cold') === s).sort((a, b) => (lastRecruitTouch(a, recruits.touches) ?? '').localeCompare(lastRecruitTouch(b, recruits.touches) ?? ''))
          return (
            <div key={s} className={`rcol s-${s}`}>
              <div className="rcolh"><b>{STAGE_NAME[s]}</b><span>{col.length}</span></div>
              <p className="rcolhint">{STAGE_HINT[s]}</p>
              {col.length === 0 && <p className="note rempty">No one here yet.</p>}
              {col.map((c) => {
                const last = lastRecruitTouch(c, recruits.touches)
                const days = last ? daysBetween(parse(last), today()) : null
                const due = recruitDue(c, recruits.touches)
                const late = !!due && due.due < ymd(today())
                return (
                  <button key={c.id} className="rcard" onClick={() => setOpen(c)}>
                    <span className="rcn"><b>{fullName(c)}</b>{s !== 'joined' && s !== 'nofit' && c.temperature && <span className={`rtemp t-${c.temperature}`}>{c.temperature === 'watch' ? 'Watch' : c.temperature}</span>}</span>
                    {c.current_brokerage && <small>{c.current_brokerage}</small>}
                    <span className={`rdays ${late ? 'late' : ''}`}>{days === null ? 'No touch yet' : days === 0 ? 'Today' : `${days}d since last touch`}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {open && <RecruitSheet rc={rc} c={live(open)} onClose={() => setOpen(null)} />}
      {adding && <RecruitEdit rc={rc} c={null} onClose={() => setAdding(false)} />}
    </section>
  )
}

// ======================================================================
// One recruit: stage up top, their recruiting details, touches and history
// ======================================================================
function RecruitSheet({ rc, c, onClose }: { rc: RCtx; c: Contact; onClose: () => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [logging, setLogging] = useState(false)
  const [reach, setReach] = useState<'call' | 'text' | null>(null)
  const [meeting, setMeeting] = useState(false)
  const [joining, setJoining] = useState(false)
  const [moving, setMoving] = useState(false)
  const [delT, setDelT] = useState<Touch | null>(null)
  const st = c.stage ?? 'cold'
  const hist = rc.recruits.touches.filter((t) => t.contact_id === c.id).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const due = recruitDue(c, rc.recruits.touches)
  const name = c.first_name || fullName(c)
  async function stage(s: Stage) {
    if (s === st) return
    if (s === 'meeting') { setMeeting(true); return }
    if (s === 'joined') { setJoining(true); return }
    try { await api.setStage(rc.me, c, s, {}, `${STAGE_NAME[st]} → ${STAGE_NAME[s]}`); await rc.reload(); toast(`${name} moved to ${STAGE_NAME[s]}.`) } catch (e) { toast((e as Error).message) }
  }
  async function temp(t: Temp) {
    try { await api.saveRecruit(rc.me, { first_name: c.first_name, temperature: t }, c.id); await rc.reload() } catch (e) { toast((e as Error).message) }
  }
  async function log(kind: TouchKind) {
    setReach(null)
    try { await api.logRecruitTouch(rc.me, c, kind); await rc.reload(); toast(`${KIND_LABEL[kind]} logged for ${name}.`) } catch (e) { toast((e as Error).message) }
  }
  const facts: [string, string | null | undefined][] = [
    ['Current brokerage', c.current_brokerage], ['Licensed', c.licensed_on ? `${fmt(c.licensed_on)}, ${c.licensed_on.slice(0, 4)} (${Math.max(0, today().getFullYear() - Number(c.licensed_on.slice(0, 4)) - (ymd(today()).slice(5) < c.licensed_on.slice(5) ? 1 : 0))} years)` : null],
    ['Years licensed', !c.licensed_on && c.years_licensed != null ? String(c.years_licensed) : null],
    ['Production', c.production_note], ['How we met', c.source], ['Phone', c.phone], ['Email', c.email],
    ['Birthday', c.birthday ? parse(c.birthday).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : null],
    ['Meeting', st === 'meeting' && c.meeting_on ? fmt(c.meeting_on) : null], ['Joined', c.joined_on ? fmt(c.joined_on) : null], ['Notes', c.notes],
  ]
  return (
    <Sheet label={fullName(c)} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 22 }}>{fullName(c)}</h3><Chips c={c} />
      </div>
      <div className="xsec">Stage</div>
      <div className="rstages" role="group" aria-label="Stage">
        {STAGES.map((s) => <button key={s} type="button" className={`s-${s}`} aria-pressed={st === s} onClick={() => stage(s)}>{STAGE_NAME[s]}</button>)}
      </div>
      {st !== 'joined' && st !== 'nofit' && (
        <>
          <div className="xsec">Temperature</div>
          <div className="seg4 x3" role="group" aria-label="Temperature">
            {(['A', 'B', 'watch'] as Temp[]).map((t) => <button key={t} type="button" aria-pressed={c.temperature === t} onClick={() => temp(t)}>{TEMP_NAME[t]}</button>)}
          </div>
        </>
      )}
      {due && <p className={`rdue ${due.due < ymd(today()) ? 'late' : ''}`} style={{ marginTop: 12 }}>{dueLine(due.due)}{due.retention ? ' · retention check-in' : ''}</p>}

      {c.phone && (reach ? (
        <div className="preach" role="status">
          <p>Did you {reach} {name}?</p>
          <div><button className="btn gold" onClick={() => log(reach)}>Yes, log it</button><button className="btn" onClick={() => setReach(null)}>Not yet</button></div>
        </div>
      ) : (
        <div className="pcall">
          <a className="go k-call" href={`tel:${telOf(c.phone)}`} onClick={() => setReach('call')}><IPhone size={20} /> Call</a>
          <a className="go k-text" href={`sms:${telOf(c.phone)}`} onClick={() => setReach('text')}><IText size={20} /> Text</a>
        </div>
      ))}
      <button className="btn block" style={{ marginTop: 10 }} onClick={() => setLogging(true)}><ICheck size={18} /> Log a touch</button>

      <div className="facts">
        {facts.filter(([, v]) => v).map(([l, v]) => <div key={l}><span>{l}</span><b style={l === 'Notes' ? { fontWeight: 400, whiteSpace: 'pre-wrap' } : undefined}>{v}</b></div>)}
      </div>

      <div className="grp" style={{ marginTop: 18 }}>History <span className="note" style={{ fontWeight: 400 }}>{(() => { const n = hist.filter((t) => t.kind !== 'stage').length; return `${n} ${n === 1 ? 'touch' : 'touches'}` })()}</span></div>
      {hist.length === 0 ? <p className="note">Nothing logged yet.</p> : (
        <div className="hist">
          {hist.map((t) => (
            <button key={t.id} className={`hrow tap ${t.kind === 'stage' ? 'rstagerow' : ''}`} onClick={() => t.kind !== 'stage' && setDelT(t)}>
              <span className="hic">{KIND_ICON[t.kind] ?? '•'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{t.kind === 'stage' ? 'Stage' : KIND_LABEL[t.kind]}</b>
                {t.note && <small className="clip">{t.note}</small>}
              </span>
              <span className="note" style={{ whiteSpace: 'nowrap' }}>{fmt(t.occurred_on)}</span>
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1 }} onClick={() => setEditing(true)}>Edit details</button>
        <button className="btn" style={{ flex: 1 }} onClick={onClose}>Close</button>
      </div>
      <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => setMoving(true)}>Move to My Sphere</button>

      {logging && <LogSheet rc={rc} c={c} onClose={() => setLogging(false)} />}
      {editing && <RecruitEdit rc={rc} c={c} onClose={() => setEditing(false)} />}
      {meeting && <MeetingSheet rc={rc} c={c} onClose={() => setMeeting(false)} />}
      {joining && <JoinSheet rc={rc} c={c} onClose={() => setJoining(false)} />}
      {delT && (
        <Sheet label="Delete this touch" onClose={() => setDelT(null)}>
          <h3>Delete this {KIND_LABEL[delT.kind].toLowerCase()}?</h3>
          <p className="note">{KIND_LABEL[delT.kind]} with {name} on {fmt(delT.occurred_on)}.{delT.note ? ` "${delT.note}"` : ''}</p>
          <div className="warn" style={{ marginTop: 10 }}>This is permanent. It can't be undone.</div>
          <button className="btn danger lg block" style={{ marginTop: 12 }} onClick={async () => { const t = delT; setDelT(null); try { await api.deleteTouch(t, rc.recruits.touches, []); await rc.reload(); toast('Touch removed.') } catch (e) { toast((e as Error).message) } }}>Delete it</button>
          <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => setDelT(null)}>Keep it</button>
        </Sheet>
      )}
      {moving && (
        <Sheet label="Move to My Sphere" onClose={() => setMoving(false)}>
          <h3>Move {name} to My Sphere?</h3>
          <p className="note">They'll leave Agents and show up in your People and Today like any client. Their history and notes come along.</p>
          <button className="btn primary lg block" style={{ marginTop: 12 }} onClick={async () => { try { await api.moveSphere(c, 'client'); await rc.reload(); toast(`${name} moved to My Sphere.`); onClose() } catch (e) { toast((e as Error).message) } }}>Move to My Sphere</button>
          <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => setMoving(false)}>Cancel</button>
        </Sheet>
      )}
    </Sheet>
  )
}

function MeetingSheet({ rc, c, onClose }: { rc: RCtx; c: Contact; onClose: () => void }) {
  const toast = useToast()
  const [d, setD] = useState(c.meeting_on ?? ymd(today()))
  return (
    <Sheet label="Meeting set" onClose={onClose}>
      <h3>When are you meeting {c.first_name}?</h3>
      <p className="note">Rock Solid brings them back up to follow up within 2 days after.</p>
      <label className="field" style={{ marginTop: 10 }}><span>Meeting date</span><input type="date" value={d} onChange={(e) => setD(e.target.value)} /></label>
      <button className="btn primary lg block" style={{ marginTop: 12 }} disabled={!d}
        onClick={async () => { try { await api.setStage(rc.me, c, 'meeting', { meeting_on: d }, `${STAGE_NAME[c.stage ?? 'cold']} → Meeting set (${fmt(d)})`); await rc.reload(); toast(`Meeting set for ${fmt(d)}.`); onClose() } catch (e) { toast((e as Error).message) } }}>
        Save
      </button>
    </Sheet>
  )
}

function JoinSheet({ rc, c, onClose }: { rc: RCtx; c: Contact; onClose: () => void }) {
  const toast = useToast()
  const [d, setD] = useState(ymd(today()))
  const [cele, setCele] = useState(false)
  if (cele) return <Celebrate eyebrow="Welcome to the team" title={`${c.first_name} joined!`} sub="Every conversation you kept warm led here. Retention check-ins start now: every 30 days for the first 90, then every 60." onClose={onClose} />
  return (
    <Sheet label="Joined" onClose={onClose}>
      <h3>🎉 {c.first_name} is joining the team?</h3>
      <p className="note">Their recruiting story stays on their card. Their join anniversary will come up every year, and retention check-ins start on their own.</p>
      <label className="field" style={{ marginTop: 10 }}><span>Joined on</span><input type="date" value={d} max={ymd(today())} onChange={(e) => setD(e.target.value)} /></label>
      <button className="btn primary lg block" style={{ marginTop: 12 }} disabled={!d}
        onClick={async () => { try { await api.setStage(rc.me, c, 'joined', { joined_on: d }, `${STAGE_NAME[c.stage ?? 'cold']} → Joined`); await rc.reload(); setCele(true) } catch (e) { toast((e as Error).message) } }}>
        Yes, they joined
      </button>
    </Sheet>
  )
}

/** Add or edit a recruit. Hand-entered only: someone you've met, been referred to, or done a deal across from. */
function RecruitEdit({ rc, c, onClose }: { rc: RCtx; c: Contact | null; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({
    first_name: c?.first_name ?? '', last_name: c?.last_name ?? '', phone: c?.phone ?? '', email: c?.email ?? '',
    current_brokerage: c?.current_brokerage ?? '', licensed_on: c?.licensed_on ?? '', years_licensed: c?.years_licensed != null ? String(c.years_licensed) : '',
    production_note: c?.production_note ?? '', source: c?.source ?? '', temperature: (c?.temperature ?? 'B') as Temp,
    stage: (c?.stage ?? 'cold') as Stage, birthday: c?.birthday ?? '', notes: c?.notes ?? '',
  })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!f.first_name.trim()) return
    setBusy(true)
    try {
      const input: api.ContactInput = {
        first_name: f.first_name.trim(), last_name: f.last_name.trim(), phone: f.phone || null, email: f.email || null,
        current_brokerage: f.current_brokerage.trim() || null, licensed_on: f.licensed_on || null, years_licensed: f.years_licensed ? Number(f.years_licensed) : null,
        production_note: f.production_note.trim() || null, source: f.source || null, temperature: f.temperature,
        birthday: f.birthday || null, notes: f.notes.trim() || null,
        ...(c ? {} : { stage: f.stage === 'joined' || f.stage === 'meeting' ? 'cold' : f.stage }),
      }
      await api.saveRecruit(rc.me, input, c?.id)
      await rc.reload()
      toast(c ? 'Saved.' : `${f.first_name.trim()} added to Agents.`)
      onClose()
    } catch (err) { toast((err as Error).message); setBusy(false) }
  }
  return (
    <Sheet label={c ? 'Agent details' : 'Add an agent'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <h3>{c ? fullName(c) : 'Add an agent'}</h3>
        {!c && <p className="note" style={{ marginTop: -6 }}>Someone you've met, been referred to, or done a deal across from.</p>}
        <div className="ed">
          <label className="field"><span>First name</span><input required value={f.first_name} onChange={set('first_name')} /></label>
          <label className="field"><span>Last name</span><input value={f.last_name} onChange={set('last_name')} /></label>
          <label className="field full"><span>Phone</span><input inputMode="tel" value={f.phone} onChange={set('phone')} /></label>
          <label className="field full"><span>Email</span><input type="email" value={f.email} onChange={set('email')} /></label>
          <label className="field full"><span>Current brokerage</span><input value={f.current_brokerage} onChange={set('current_brokerage')} placeholder="Keller Williams Lubbock" /></label>
          <div className="field full"><DateField label="Date licensed" ro={false} value={f.licensed_on} onChange={(v) => setF({ ...f, licensed_on: v })} />
            <small className="note">Rock Solid brings up a congratulations card every year around this date.</small></div>
          {!f.licensed_on && <label className="field"><span>Years licensed</span><input inputMode="numeric" value={f.years_licensed} onChange={(e) => setF({ ...f, years_licensed: e.target.value.replace(/\D/g, '').slice(0, 2) })} /></label>}
          <label className="field full"><span>Production</span><input value={f.production_note} onChange={set('production_note')} placeholder="~12 deals a year, mostly listings" /></label>
        </div>
        <div className="field"><span>How you met</span>
          <div className="chips">{SOURCES.map((s) => <button type="button" key={s} aria-pressed={f.source === s} onClick={() => setF({ ...f, source: f.source === s ? '' : s })}>{s}</button>)}</div>
        </div>
        <div className="field"><span>Temperature</span>
          <div className="seg4 x3" role="group" aria-label="Temperature">
            {(['A', 'B', 'watch'] as Temp[]).map((t) => <button type="button" key={t} aria-pressed={f.temperature === t} onClick={() => setF({ ...f, temperature: t })}>{TEMP_NAME[t]}</button>)}
          </div>
          <small className="note">Watch comes up every 60 days, whatever the stage.</small>
        </div>
        {!c && (
          <div className="field"><span>Where are things?</span>
            <div className="chips">{(['cold', 'warm', 'talking'] as Stage[]).map((s) => <button type="button" key={s} aria-pressed={f.stage === s} onClick={() => setF({ ...f, stage: s })}>{STAGE_NAME[s]}</button>)}</div>
          </div>
        )}
        <MonthDayField label="Birthday" ro={false} value={f.birthday} onChange={(v) => setF({ ...f, birthday: v })} />
        <label className="field"><span>Notes</span><textarea value={f.notes} onChange={set('notes')} placeholder="What they care about, what they've said about their brokerage" /></label>
        <button className="btn primary lg block" disabled={busy}>{busy ? 'Saving…' : c ? 'Save' : 'Add agent'}</button>
        <button type="button" className="btn ghost block" onClick={onClose}>Cancel</button>
      </form>
    </Sheet>
  )
}
