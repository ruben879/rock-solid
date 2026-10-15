import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Profile } from '../lib/model'
import { addDays, fmt, monthStart, today, ymd } from '../lib/dates'
import * as tg from '../lib/together'
import { supabase } from '../supabase'
import type { Challenge, DayCount, Period, Person, Post } from '../lib/together'
import { Sheet, store, useToast } from '../ui'
import { IChevL, IMore, IPlus } from '../icons'

const COLORS = ['#2f6bd8', '#13806a', '#b07c1c', '#7a5ab8', '#c8401c', '#1e3a6e', '#0f7a8a', '#a2456e']
const colorOf = (id: string) => COLORS[[...id].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length]
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?'
const firstName = (n: string) => n.split(/\s+/)[0] || n
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr`
  return fmt(new Date(iso))
}
const singular = (w: string) => w.split(' or ').map((x) => (x.endsWith('touches') ? x.slice(0, -2) : x.endsWith('s') ? x.slice(0, -1) : x)).join(' or ')

function Avatar({ id, name, size = 34 }: { id: string; name: string; size?: number }) {
  return <span className="tav" style={{ background: colorOf(id), width: size, height: size, fontSize: size * 0.38 }}>{initials(name)}</span>
}

/** The Together tab: your challenges, or one challenge's room. */
export function Together({ me }: { me: Profile }) {
  const toast = useToast()
  const [list, setList] = useState<{ c: Challenge; members: number; progress: DayCount[] }[] | null>(null)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [joinCode, setJoinCode] = useState<string | null>(() => store.get<string | null>('rs-join', null))
  const [invites, setInvites] = useState<tg.Invite[]>([])

  const load = useCallback(async () => {
    try {
      const cs = await tg.myChallenges(me.id)
      const rows = await Promise.all(cs.map(async (c) => {
        const r = await tg.loadRoom(c).catch(() => ({ people: [], progress: [] as DayCount[] }))
        return { c, members: r.people.length, progress: r.progress }
      }))
      setList(rows)
      setErr('')
      const inv = await tg.myInvites()
      setInvites(inv)
      window.dispatchEvent(new CustomEvent('rs-invites', { detail: inv.length }))
    } catch (e) {
      setErr((e as Error).message)
      setList([])
    }
  }, [me.id])
  useEffect(() => { load() }, [load])

  const open = list?.find((x) => x.c.id === openId)?.c
  if (open) return <Room me={me} c={open} onBack={() => { setOpenId(null); load() }} />

  const t = ymd(today())
  const active = (list ?? []).filter((x) => x.c.ends_on >= t)
  const past = (list ?? []).filter((x) => x.c.ends_on < t)
  return (
    <section>
      <h2 style={{ marginTop: 14 }}>Together</h2>
      <p className="sub">Challenges you're in with other agents. Cheer each other on.</p>
      {err && <p className="error">{err}</p>}
      {list === null ? <p className="muted">Loading…</p> : (
        <>
          {invites.map((v) => (
            <div key={v.challenge_id} className="tcard invited">
              <p className="note" style={{ margin: 0 }}>{v.invited_by} invited you</p>
              <div className="row"><b>{v.name}</b></div>
              <p>{v.members} in · {fmt(v.starts_on)} to {fmt(v.ends_on)}</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn gold" style={{ flex: 1 }} onClick={async () => { try { const id = await tg.join(v.code); toast("You're in!"); await load(); setOpenId(id) } catch (e) { toast((e as Error).message) } }}>Join</button>
                <button className="btn" style={{ flex: 1 }} onClick={async () => { await tg.declineInvite(v.challenge_id, me.id); load() }}>No thanks</button>
              </div>
            </div>
          ))}
          {active.length === 0 && invites.length === 0 && !err && (
            <div className="card empty" style={{ marginBottom: 12 }}>
              <p>No challenges yet. Start one and invite a few people, or join one with a link someone sent you.</p>
            </div>
          )}
          {active.map((x) => <ChallengeCard key={x.c.id} me={me} {...x} onOpen={() => setOpenId(x.c.id)} />)}
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button className="btn primary lg" style={{ flex: 1, whiteSpace: "nowrap" }} onClick={() => setStarting(true)}><IPlus size={18} /> New challenge</button>
            <button className="btn lg" style={{ flex: 1, whiteSpace: "nowrap" }} onClick={() => setJoinCode('')}>Join with a link</button>
          </div>
          {past.length > 0 && (
            <details className="more" style={{ marginTop: 20 }}>
              <summary>Finished ({past.length})</summary>
              <div className="stack">{past.map((x) => <ChallengeCard key={x.c.id} me={me} {...x} onOpen={() => setOpenId(x.c.id)} />)}</div>
            </details>
          )}
        </>
      )}
      {starting && <StartSheet me={me} onClose={() => setStarting(false)} onStarted={(c) => { setStarting(false); toast('Challenge started. Invite a few people!'); load().then(() => setOpenId(c.id)) }} />}
      {joinCode !== null && (
        <JoinSheet code={joinCode} onClose={() => { setJoinCode(null); store.set('rs-join', null) }}
          onJoined={(id) => { setJoinCode(null); store.set('rs-join', null); toast("You're in!"); load().then(() => setOpenId(id)) }} />
      )}
    </section>
  )
}

function ChallengeCard({ me, c, members, progress, onOpen }: { me: Profile; c: Challenge; members: number; progress: DayCount[]; onOpen: () => void }) {
  const mine = tg.current(c, progress, me.id)
  const s = tg.streak(c, progress, me.id)
  const done = c.ends_on < ymd(today())
  return (
    <button className="tcard" onClick={onOpen}>
      <div className="row"><b>{c.name}</b>
        <span className="tpill">{c.kind === 'cards' ? `🔥 ${s}` : `${mine} of ${c.target}`}</span>
      </div>
      <p>{c.kind === 'cards' ? 'Card a Day' : `${c.target} ${tg.noun(c)} ${tg.per(c.period)}`} · {done ? `ended ${fmt(c.ends_on)}` : `ends ${fmt(c.ends_on)}`} · {members} in</p>
    </button>
  )
}

function Room({ me, c, onBack }: { me: Profile; c: Challenge; onBack: () => void }) {
  const toast = useToast()
  const [room, setRoom] = useState<{ people: Person[]; progress: DayCount[]; posts: Post[]; kudos: { post_id: string; user_id: string }[] } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [menu, setMenu] = useState(false)
  const load = useCallback(async () => {
    try { setRoom(await tg.loadRoom(c)) } catch (e) { toast((e as Error).message) }
  }, [c, toast])
  useEffect(() => {
    load()
    // Live: new posts and kudos show up the moment they happen. The 30-second check is a backup.
    const ch = supabase.channel(`room-${c.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'challenge_posts', filter: `challenge_id=eq.${c.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'challenge_kudos' }, () => load())
      .subscribe()
    const t = setInterval(load, 30000)
    const back = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', back)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); supabase.removeChannel(ch) }
  }, [load, c.id])

  const names = useMemo(() => new Map((room?.people ?? []).map((p) => [p.user_id, p.name])), [room])
  const people = [...(room?.people ?? [])].sort((a, b) => (a.user_id === me.id ? -1 : b.user_id === me.id ? 1 : a.name.localeCompare(b.name)))
  const t = ymd(today())

  async function send(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try { await tg.say(c.id, me.id, body); setText(''); await load() } catch (err) { toast((err as Error).message) }
    setBusy(false)
  }
  async function toggleKudo(p: Post, on: boolean) {
    if (!room) return
    // Show it right away, then save.
    setRoom({ ...room, kudos: on ? [...room.kudos, { post_id: p.id, user_id: me.id }] : room.kudos.filter((k) => !(k.post_id === p.id && k.user_id === me.id)) })
    try { await tg.kudo(p.id, me.id, on) } catch (err) { toast((err as Error).message); load() }
  }
  async function remove(p: Post) {
    try { await tg.removePost(p.id); await load() } catch (err) { toast((err as Error).message) }
  }

  function autoText(p: Post) {
    const n = p.auto_n
    const when = p.auto_day && p.auto_day !== t ? ` on ${fmt(p.auto_day)}` : ' today'
    if (c.kind === 'cards') return n === 1 ? `✍️ Wrote a card${when}` : `✍️ Wrote ${n} cards${when}`
    const w = tg.noun(c)
    return `✅ Logged ${n} ${n === 1 ? singular(w) : w}${when}`
  }

  return (
    <section className="room">
      <div className="roomhdr">
        <button className="iconbtn" aria-label="Back to challenges" onClick={onBack}><IChevL /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 21 }}>{c.name}</h2>
          <p className="note" style={{ margin: 0 }}>
            {c.kind === 'cards' ? 'Card a Day' : `${c.target} ${tg.noun(c)} ${tg.per(c.period)}`} · {fmt(c.starts_on)} to {fmt(c.ends_on)}
          </p>
        </div>
        <button className="btn" onClick={() => setInviting(true)}>Invite</button>
        <button className="iconbtn" aria-label="More" onClick={() => setMenu(true)}><IMore /></button>
      </div>

      <div className="crew">
        {people.map((p) => {
          const s = room ? tg.streak(c, room.progress, p.user_id) : 0
          const cur = room ? tg.current(c, room.progress, p.user_id) : 0
          return (
            <div key={p.user_id} className="mem">
              <span className="memav">
                <Avatar id={p.user_id} name={p.name} size={48} />
                {s > 0 && <span className="streakb">🔥{s}</span>}
              </span>
              <span className="memn">{p.user_id === me.id ? 'You' : firstName(p.name)}</span>
              {c.kind === 'custom' && <span className={`memp ${cur >= c.target ? 'hit' : ''}`}>{cur}/{c.target}</span>}
            </div>
          )
        })}
      </div>

      <form className="composer" onSubmit={send}>
        <input aria-label="Message" placeholder="Say something encouraging…" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>

      <div className="feed">
        {room === null && <p className="muted">Loading…</p>}
        {room && room.posts.length === 0 && <p className="note" style={{ textAlign: 'center', padding: 20 }}>Nothing yet. When anyone logs something for this challenge, it shows up here on its own.</p>}
        {room?.posts.map((p) => {
          const name = names.get(p.user_id) ?? 'Someone'
          const ks = room.kudos.filter((k) => k.post_id === p.id)
          const mine = ks.some((k) => k.user_id === me.id)
          const s = p.auto_day ? tg.streak(c, room.progress, p.user_id) : 0
          return (
            <div key={p.id} className="post">
              <Avatar id={p.user_id} name={name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ph"><b>{p.user_id === me.id ? 'You' : name}</b><span className="note"> · {ago(p.created_at)}</span>
                  {p.user_id === me.id && !p.auto_day && <button className="link pdel" onClick={() => remove(p)}>Remove</button>}
                </div>
                {p.auto_day ? (
                  <div className="auto">{autoText(p)}{s >= 2 ? ` · 🔥 ${s} ${tg.unit(c.kind === 'cards' ? 'day' : c.period, s)} in a row` : ''}</div>
                ) : (
                  <div className="pbody">{p.body}</div>
                )}
                <button className={`kudo ${mine ? 'on' : ''}`} disabled={p.user_id === me.id} aria-pressed={mine}
                  onClick={() => toggleKudo(p, !mine)}>👏 Kudos{ks.length ? ` · ${ks.length}` : ''}</button>
              </div>
            </div>
          )
        })}
      </div>

      {inviting && <InviteSheet c={c} me={me} members={(room?.people ?? []).map((p) => p.user_id)} onClose={() => setInviting(false)} />}
      {menu && (
        <Sheet label="Challenge options" onClose={() => setMenu(false)}>
          <h3>{c.name}</h3>
          <div className="menu" style={{ marginTop: 8 }}>
            <button onClick={() => { setMenu(false); setInviting(true) }}>Invite people</button>
            {c.created_by === me.id ? (
              <button style={{ color: 'var(--bad)' }} onClick={async () => { setMenu(false); try { await tg.endChallenge(c.id); toast('Challenge removed.'); onBack() } catch (e) { toast((e as Error).message) } }}>Delete this challenge for everyone</button>
            ) : (
              <button style={{ color: 'var(--bad)' }} onClick={async () => { setMenu(false); try { await tg.leave(c.id, me.id); toast('You left the challenge.'); onBack() } catch (e) { toast((e as Error).message) } }}>Leave this challenge</button>
            )}
            <button onClick={() => setMenu(false)} style={{ color: 'var(--muted)' }}>Cancel</button>
          </div>
        </Sheet>
      )}
    </section>
  )
}

function InviteSheet({ c, me, members, onClose }: { c: Challenge; me: Profile; members: string[]; onClose: () => void }) {
  const toast = useToast()
  const link = tg.joinLink(c)
  const msg = `Join my "${c.name}" challenge on Rock Solid: ${link}\n\nAlready have the app? Open Together, tap Join with a link, and enter code ${c.code}.`
  const [people, setPeople] = useState<Person[] | null>(null)
  const [sent, setSent] = useState<string[]>([])
  const [q, setQ] = useState('')
  useEffect(() => {
    Promise.all([tg.brokeragePeople(), tg.invited(c.id)]).then(([p, inv]) => { setPeople(p); setSent(inv) }, () => setPeople([]))
  }, [c.id])
  const shown = (people ?? []).filter((p) => !members.includes(p.user_id) && p.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
  async function ask(p: Person) {
    try { await tg.invite(c.id, p.user_id, me.id); setSent([...sent, p.user_id]); toast(`${firstName(p.name)} is invited. It's waiting on their Together tab.`) } catch (e) { toast((e as Error).message) }
  }
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> }
    if (nav.share) { try { await nav.share({ title: c.name, text: `Join my "${c.name}" challenge on Rock Solid. Already have the app? Open Together, tap Join with a link, and enter code ${c.code}.`, url: link }) } catch { /* closed */ } }
    else location.href = `sms:?&body=${encodeURIComponent(msg)}`
  }
  return (
    <Sheet label="Invite people" onClose={onClose}>
      <h3>Invite people</h3>
      <p className="note">Anyone with a Rock Solid account can join with this link. They'll see streaks and posts in this challenge, never anyone's people or notes.</p>
      <div className="tlink">🔗 {link.replace(/^https?:\/\//, '')}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button className="btn primary lg" style={{ flex: 1 }} onClick={share}>Send it</button>
        <button className="btn lg" style={{ flex: 1 }} onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied.'), () => toast("Copying isn't available here."))}>Copy link</button>
      </div>
      <p className="note" style={{ marginTop: 10, textAlign: 'center' }}>Code: <b>{c.code}</b></p>
      {people && people.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="grp" style={{ marginTop: 0 }}>Invite someone at your brokerage</div>
          <p className="note" style={{ marginTop: -6 }}>It shows up on their Together tab. One tap to join.</p>
          <input aria-label="Search people" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
          <div className="invlist">
            {shown.map((p) => (
              <div key={p.user_id} className="invrow">
                <Avatar id={p.user_id} name={p.name} size={30} />
                <span style={{ flex: 1 }}>{p.name}</span>
                {sent.includes(p.user_id) ? <span className="note">Invited ✓</span> : <button className="btn" onClick={() => ask(p)}>Invite</button>}
              </div>
            ))}
            {shown.length === 0 && <p className="note">Everyone's already in.</p>}
          </div>
        </div>
      )}
    </Sheet>
  )
}

function JoinSheet({ code: initial, onClose, onJoined }: { code: string; onClose: () => void; onJoined: (id: string) => void }) {
  const [code, setCode] = useState(initial)
  const [info, setInfo] = useState<Awaited<ReturnType<typeof tg.preview>> | undefined>(undefined)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const clean = code.trim().replace(/.*\/j\//, '').toUpperCase()
  useEffect(() => {
    setInfo(undefined); setErr('')
    if (clean.length < 6) return
    tg.preview(clean).then((r) => { setInfo(r); if (!r) setErr("That code doesn't match a challenge.") }, (e) => setErr((e as Error).message))
  }, [clean])
  return (
    <Sheet label="Join a challenge" onClose={onClose}>
      <h3>Join a challenge</h3>
      <p className="note">Paste the link someone sent you, or type its 6-letter code.</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input aria-label="Link or code" placeholder="Link or code" value={code} autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} style={{ flex: 1 }} />
        {navigator.clipboard?.readText && <button type="button" className="btn" onClick={() => navigator.clipboard.readText().then((t) => setCode(t.trim()), () => {})}>Paste</button>}
      </div>
      {info && (
        <div className="card" style={{ marginTop: 12, background: 'var(--bg)', boxShadow: 'none' }}>
          <b>{info.name}</b>
          <p className="note" style={{ margin: 0 }}>Started by {info.started_by} · {info.members} in · {fmt(info.starts_on)} to {fmt(info.ends_on)}</p>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn gold lg" style={{ flex: 1 }} disabled={!info || busy} onClick={async () => { setBusy(true); try { onJoined(await tg.join(clean)) } catch (e) { setErr((e as Error).message); setBusy(false) } }}>Join</button>
        <button className="btn lg" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  )
}

function StartSheet({ me, onClose, onStarted }: { me: Profile; onClose: () => void; onStarted: (c: Challenge) => void }) {
  const toast = useToast()
  const t = today()
  const endOfMonth = addDays(monthStart(new Date(t.getFullYear(), t.getMonth() + 1, 1, 12)), -1)
  const [kind, setKind] = useState<'cards' | 'custom'>('cards')
  const [name, setName] = useState('')
  const [counts, setCounts] = useState<string[]>(['popby'])
  const [target, setTarget] = useState('5')
  const [period, setPeriod] = useState<Period>('week')
  const [from, setFrom] = useState(ymd(t))
  const [to, setTo] = useState(ymd(endOfMonth))
  const [busy, setBusy] = useState(false)
  const n = Math.max(1, parseInt(target, 10) || 0)
  const autoName = kind === 'cards'
    ? `${t.toLocaleDateString('en-US', { month: 'long' })} Card a Day`
    : `${n} ${tg.noun({ kind: 'custom', counts } as Challenge)} ${tg.per(period)}`
  const ok = kind === 'cards' || counts.length > 0
  async function go() {
    if (!ok || to < from) return
    setBusy(true)
    try {
      const c = await tg.startChallenge(me.id, {
        name: name.trim() || autoName, kind, counts: kind === 'cards' ? [] : counts,
        target: kind === 'cards' ? 1 : n, period: kind === 'cards' ? 'day' : period, starts_on: from, ends_on: to,
      })
      onStarted(c)
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }
  const toggle = (k: string) => setCounts(k === 'any' ? ['any'] : counts.includes(k) ? counts.filter((x) => x !== k) : [...counts.filter((x) => x !== 'any'), k])
  return (
    <Sheet label="Start a challenge" onClose={onClose}>
      <h3>Start a challenge</h3>
      <p className="note">It fills in on its own from what everyone already logs. Nothing extra to record.</p>
      <div className="field" style={{ marginTop: 12 }}><span>What kind?</span>
        <div className="chips">
          <button type="button" aria-pressed={kind === 'cards'} onClick={() => setKind('cards')}>Card a Day</button>
          <button type="button" aria-pressed={kind === 'custom'} onClick={() => { setKind('custom'); setTo(ymd(addDays(t, 6))) }}>Custom</button>
        </div>
      </div>
      {kind === 'custom' && (
        <>
          <div className="field" style={{ marginTop: 12 }}><span>What counts?</span>
            <div className="chips">{tg.COUNTABLE.map(([k, l]) => <button type="button" key={k} aria-pressed={counts.includes(k)} onClick={() => toggle(k)}>{l}</button>)}</div>
          </div>
          <div className="field" style={{ marginTop: 12 }}><span>The goal</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input inputMode="numeric" aria-label="How many" value={target} onFocus={(e) => e.target.select()} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} style={{ width: 70, textAlign: 'center' }} />
              <div className="chips">{(['day', 'week', 'month'] as Period[]).map((p) => <button type="button" key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>{tg.per(p)}</button>)}</div>
            </div>
          </div>
        </>
      )}
      <label className="field" style={{ marginTop: 12 }}><span>Name it</span>
        <input value={name} placeholder={autoName} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field" style={{ marginTop: 12 }}><span>Runs</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="date" aria-label="Starts" value={from} onChange={(e) => setFrom(e.target.value)} style={{ flex: 1 }} />
          <input type="date" aria-label="Ends" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={{ flex: 1 }} />
        </div>
      </div>
      <button className="btn gold lg block" style={{ marginTop: 16 }} disabled={busy || !ok || to < from} onClick={go}>{busy ? 'Starting…' : 'Start it'}</button>
      <button className="btn ghost block" style={{ marginTop: 6 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}
