import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as api from '../lib/data'
import { monthStart, monthName, ymd } from '../lib/dates'
import type { Brokerage, Profile } from '../lib/model'
import { HeatStack, useToast } from '../ui'
import { agentSummary } from './agent'

const nameOf = (p: Profile) => p.full_name || p.email

// ======================================================================
// My agents (coach) / All agents (broker)
// ======================================================================
export function AgentsOverview({ me, team, brokerage, onOpen }: { me: Profile; team: Profile[]; brokerage: Brokerage | null; onOpen: (p: Profile) => void }) {
  const isBroker = me.role === 'broker'
  const [coachFilter, setCoachFilter] = useState('')
  const coaches = team.filter((p) => p.role === 'coach' || p.role === 'broker')
  const visible = team.filter((p) => (isBroker ? true : p.coach_id === me.id)).filter((p) => !coachFilter || p.coach_id === coachFilter)
  const ids = useMemo(() => visible.map((p) => p.id), [visible.map((p) => p.id).join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error } = api.useAgentData(ids)
  const goal = brokerage?.settings?.touch_goal ?? 36
  const monthly = (brokerage?.settings?.monthly_goals?.call ?? 21) + (brokerage?.settings?.monthly_goals?.text ?? 21) + (brokerage?.settings?.monthly_goals?.card ?? 7)

  return (
    <section>
      <h2>{isBroker ? 'All agents' : 'My agents'}</h2>
      <p className="sub">{isBroker ? 'Everyone across every coach.' : 'The agents you coach.'} A flag means it's time for a check-in.</p>
      {isBroker && (
        <div className="toolbar">
          <select aria-label="Filter by coach" value={coachFilter} onChange={(e) => setCoachFilter(e.target.value)}>
            <option value="">All coaches</option>
            {coaches.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}
          </select>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="card empty">{isBroker ? 'No agents have signed in yet. Add invites on the Team tab.' : 'No agents are assigned to you yet.'}</div>
      ) : (
        <div className="agentcards">
          {visible.map((p) => {
            const s = agentSummary(data, p.id, goal, p.tier_days)
            const pct = Math.round((s.monthTouches / monthly) * 100)
            const cls = pct >= 75 ? 'ok' : pct >= 45 ? 'mid' : 'low'
            const coach = team.find((c) => c.id === p.coach_id)
            const flag =
              s.lastLogDays === null ? { t: 'No touches logged yet.', c: 'var(--muted)' }
              : s.lastLogDays >= 14 ? { t: `No logs in ${s.lastLogDays} days. Reach out this week.`, c: 'var(--urgent)' }
              : s.heat[2] >= 50 && s.contacts > 0 ? { t: `${s.heat[2]}% of their database is urgent.`, c: 'var(--ink)' }
              : { t: 'On rhythm.', c: 'var(--muted)' }
            return (
              <div key={p.id} className="ac">
                <div className="top"><b>{nameOf(p)}</b><span className={`pill ${cls}`}>{pct}% of month</span></div>
                <div className="note">Coach: {coach ? nameOf(coach) : 'None'} · Last log {s.lastLogDays === null ? 'never' : s.lastLogDays === 0 ? 'today' : s.lastLogDays === 1 ? 'yesterday' : `${s.lastLogDays} days ago`}</div>
                <div className="nums">
                  <span>Calls <b>{s.calls}</b></span><span>Texts <b>{s.texts}</b></span><span>Cards <b>{s.cards}</b></span><span>Database <b>{s.contacts}</b></span>
                </div>
                {s.contacts > 0 && <HeatStack parts={s.heat} />}
                <span className="note" style={{ color: flag.c }}>{flag.t}</span>
                <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => onOpen(p)}>Open tracker</button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ======================================================================
// Team admin (broker): invites, roles, coaches
// ======================================================================
export function TeamAdmin({ me, team, onChange }: { me: Profile; team: Profile[]; onChange: () => void }) {
  const toast = useToast()
  const [invites, setInvites] = useState<api.Invite[]>([])
  const [f, setF] = useState<api.Invite>({ email: '', full_name: '', role: 'agent', coach_email: '' })
  const loadInv = useCallback(() => api.loadInvites().then(setInvites).catch((e) => toast(e.message)), [toast])
  useEffect(() => { loadInv() }, [loadInv])
  const coaches = team.filter((p) => p.role !== 'agent')
  const signedIn = new Set(team.map((p) => p.email))
  const pending = invites.filter((i) => !signedIn.has(i.email))

  async function add(e: FormEvent) {
    e.preventDefault()
    try {
      await api.addInvite(me, { ...f, coach_email: f.coach_email || null, full_name: f.full_name || null })
      toast(`${f.full_name || f.email} can now sign in.`)
      setF({ email: '', full_name: '', role: 'agent', coach_email: f.coach_email })
      loadInv()
    } catch (err) {
      toast(`Couldn't add: ${(err as Error).message}`)
    }
  }
  async function act(fn: () => Promise<void>, msg: string) {
    try {
      await fn()
      toast(msg)
      onChange()
      loadInv()
    } catch (err) {
      toast(`Couldn't save: ${(err as Error).message}`)
    }
  }
  return (
    <section>
      <h2>Team</h2>
      <p className="sub">Invite people, set who coaches whom, and change roles. Only invited emails can sign in.</p>

      <div className="grp">Invite someone</div>
      <form className="card" onSubmit={add} style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', alignItems: 'end' }}>
        <label className="field"><span>Name</span><input value={f.full_name ?? ''} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></label>
        <label className="field"><span>Email</span><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>Role</span>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as api.Invite['role'] })}>
            <option value="agent">Agent</option><option value="coach">Coach</option><option value="broker">Broker</option>
          </select>
        </label>
        <label className="field"><span>Coach</span>
          <select value={f.coach_email ?? ''} onChange={(e) => setF({ ...f, coach_email: e.target.value })}>
            <option value="">None</option>
            {coaches.map((c) => <option key={c.id} value={c.email}>{nameOf(c)}</option>)}
            {invites.filter((i) => i.role !== 'agent' && !signedIn.has(i.email)).map((i) => <option key={i.email} value={i.email}>{i.full_name || i.email} (not signed in yet)</option>)}
          </select>
        </label>
        <button className="btn primary lg">Add invite</button>
      </form>

      <div className="grp">Signed in ({team.length})</div>
      <div className="tblwrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Coach</th></tr></thead>
          <tbody>
            {team.map((p) => (
              <tr key={p.id}>
                <td>{nameOf(p)}</td>
                <td>{p.email}</td>
                <td>
                  <select aria-label={`Role for ${nameOf(p)}`} value={p.role} disabled={p.id === me.id} onChange={(e) => act(() => api.setRole(p.id, e.target.value as Profile['role']), 'Role updated.')}>
                    <option value="agent">Agent</option><option value="coach">Coach</option><option value="broker">Broker</option>
                  </select>
                </td>
                <td>
                  <select aria-label={`Coach for ${nameOf(p)}`} value={p.coach_id ?? ''} onChange={(e) => act(() => api.setCoach(p.id, e.target.value || null), 'Coach updated.')}>
                    <option value="">None</option>
                    {coaches.filter((c) => c.id !== p.id).map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grp">Invited, not signed in yet ({pending.length})</div>
      {pending.length === 0 ? (
        <div className="card note">Everyone you've invited has signed in.</div>
      ) : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Coach</th><th /></tr></thead>
            <tbody>
              {pending.map((i) => (
                <tr key={i.email}>
                  <td>{i.full_name}</td><td>{i.email}</td><td>{i.role}</td>
                  <td>{i.coach_email ?? ''}</td>
                  <td><button className="btn ghost" onClick={() => act(() => api.removeInvite(i.email), 'Invite removed.')}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note" style={{ marginTop: 10 }}>Send new people to {location.origin}. They sign in with the email you entered here.</p>
    </section>
  )
}

// ======================================================================
// Monthly drawing (broker)
// ======================================================================
export function DrawingView({ me, team, brokerage }: { me: Profile; team: Profile[]; brokerage: Brokerage | null }) {
  const toast = useToast()
  const prizes = brokerage?.settings?.prizes ?? [25, 15, 10]
  const month = ymd(monthStart())
  const [entries, setEntries] = useState<{ agent_id: string; entries: number }[] | null>(null)
  const [draws, setDraws] = useState<api.Drawing[]>([])
  const [spinning, setSpinning] = useState(false)
  const angle = useRef(0)
  const canvas = useRef<HTMLCanvasElement>(null)

  const load = useCallback(async () => {
    try {
      const [e, d] = await Promise.all([api.loadDrawingEntries(month), api.loadDrawings(month)])
      setEntries(e)
      setDraws(d)
    } catch (err) {
      toast((err as Error).message)
    }
  }, [month, toast])
  useEffect(() => { load() }, [load])

  const name = (id: string | null) => { const p = team.find((x) => x.id === id); return p ? nameOf(p) : 'Unknown' }
  const won = new Set(draws.map((d) => d.winner_id))
  const live = (entries ?? []).filter((e) => e.entries > 0 && !won.has(e.agent_id))
  const total = live.reduce((s, e) => s + e.entries, 0)

  const paint = useCallback(() => {
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const R = cv.width / 2
    const cs = getComputedStyle(document.documentElement)
    const cols = ['--navy-2', '--ok', '--gold', '--urgent', '--good', '--behind'].map((v) => cs.getPropertyValue(v).trim())
    ctx.clearRect(0, 0, cv.width, cv.height)
    if (!total) { ctx.fillStyle = cs.getPropertyValue('--line'); ctx.beginPath(); ctx.arc(R, R, R - 8, 0, 7); ctx.fill(); return }
    let a0 = angle.current
    live.forEach((e, i) => {
      const sweep = (e.entries / total) * Math.PI * 2
      ctx.beginPath(); ctx.moveTo(R, R); ctx.arc(R, R, R - 8, a0, a0 + sweep); ctx.closePath(); ctx.fillStyle = cols[i % cols.length]; ctx.fill()
      ctx.strokeStyle = cs.getPropertyValue('--surface'); ctx.lineWidth = 3; ctx.stroke()
      if (sweep > 0.18) {
        ctx.save(); ctx.translate(R, R); ctx.rotate(a0 + sweep / 2); ctx.fillStyle = '#fff'; ctx.font = '500 24px Lexend, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
        ctx.fillText(name(e.agent_id).split(' ')[0], R - 28, 0); ctx.restore()
      }
      a0 += sweep
    })
    ctx.beginPath(); ctx.arc(R, R, 34, 0, 7); ctx.fillStyle = cs.getPropertyValue('--surface'); ctx.fill()
    ctx.beginPath(); ctx.moveTo(R - 18, 2); ctx.lineTo(R + 18, 2); ctx.lineTo(R, 40); ctx.closePath(); ctx.fillStyle = cs.getPropertyValue('--ink'); ctx.fill()
  }, [live, total]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!spinning) paint() }, [paint, spinning])

  function spin() {
    if (!total || draws.length >= prizes.length) return
    let r = Math.random() * total
    let start = 0
    let pick = live[0]
    for (const e of live) { if (r < e.entries) { pick = e; break } r -= e.entries; start += e.entries }
    const mid = ((start + pick.entries * (0.2 + Math.random() * 0.6)) / total) * Math.PI * 2
    const targetA = -Math.PI / 2 - mid
    const from = angle.current
    // Land the pointer on the winner's slice after six full turns.
    const m = ((((targetA - from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2))
    const end = from + m + Math.PI * 12
    const prize = prizes[draws.length]
    const finish = async () => {
      angle.current = end % (Math.PI * 2)
      setSpinning(false)
      try {
        await api.saveDrawing(me, { month, prize_dollars: prize, winner_id: pick.agent_id, winner_entries: pick.entries, total_entries: total })
        toast(`${name(pick.agent_id)} wins $${prize}!`)
        load()
      } catch (err) {
        toast(`Couldn't save: ${(err as Error).message}`)
      }
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { angle.current = end; paint(); finish(); return }
    setSpinning(true)
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 4200)
      angle.current = from + (end - from) * (1 - Math.pow(1 - k, 4))
      paint()
      if (k < 1) requestAnimationFrame(step)
      else finish()
    }
    requestAnimationFrame(step)
  }

  async function reset() {
    try { await api.clearDrawings(month); toast('Drawing reset.'); load() } catch (err) { toast((err as Error).message) }
  }

  const n = draws.length
  return (
    <section>
      <h2>{monthName()} drawing</h2>
      <p className="sub">Every individual touch logged this month is one entry, and so is every extra (social post, giveaway, newsletter and so on). No minimum. Spin for each prize in order; once someone wins, they're out of the later spins.</p>
      <div className="draw">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <canvas ref={canvas} width={560} height={560} style={{ width: '100%', maxWidth: 340, aspectRatio: '1', height: 'auto' }} aria-label="Prize wheel" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn gold lg" disabled={spinning || !total || n >= prizes.length} onClick={spin}>{n < prizes.length ? `Spin for $${prizes[n]}` : 'All prizes drawn'}</button>
            <button className="btn ghost" disabled={spinning || !n} onClick={reset}>Start over</button>
          </div>
          <div className="note">{live.length} agents on the wheel · {total} entries</div>
        </div>
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="card">
            <h3 style={{ marginBottom: 8 }}>Winners</h3>
            {prizes.map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <b style={{ fontFamily: 'var(--display)', fontSize: 20 }}>${p}</b>
                <span className={draws[i] ? 'winner' : 'note'}>{draws[i] ? name(draws[i].winner_id) : 'Not drawn yet'}</span>
              </div>
            ))}
          </div>
          <div className="tblwrap">
            <table>
              <thead><tr><th>Agent</th><th>Entries</th></tr></thead>
              <tbody>
                {(entries ?? []).sort((a, b) => b.entries - a.entries).map((e) => (
                  <tr key={e.agent_id}><td>{name(e.agent_id)}</td><td>{won.has(e.agent_id) ? <span className="pill ok">Won</span> : e.entries}</td></tr>
                ))}
                {entries && entries.length === 0 && <tr><td colSpan={2} className="note">No interactions logged yet this month.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}
