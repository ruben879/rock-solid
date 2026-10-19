import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import type { Profile } from '../lib/model'
import { addDays, fmt, monthStart, today, ymd } from '../lib/dates'
import * as tg from '../lib/together'
import { supabase } from '../supabase'
import type { Challenge, DayCount, Period, Person, Post } from '../lib/together'
import { Sheet, store, useSwipeBack, useToast } from '../ui'
import { IChevL, IMore, IPin, IPlus, IText } from '../icons'

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

/** Your own Card a Day, worked out on the Challenges tab from your cards. */
export interface CadInfo { streak: number; banked: number; week: ('on' | 'cov' | '')[]; todayIdx: number; done: boolean; covered: boolean }

type Row = { c: Challenge; members: number; progress: DayCount[] }

/** The Challenges tab: your Card a Day plus every challenge you're in. Each person pins the one they want on top. */
export function Together({ me, cad, renderCad, renderLog }: {
  me: Profile
  cad: CadInfo
  renderCad: (onBack: () => void, feed: ReactNode) => ReactNode
  renderLog: (kinds: string[], onClose: () => void) => ReactNode
}) {
  const toast = useToast()
  const [list, setList] = useState<Row[] | null>(null)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [joinCode, setJoinCode] = useState<string | null>(() => store.get<string | null>('rs-join', null))
  const [invites, setInvites] = useState<tg.Invite[]>([])
  const [news, setNews] = useState<Record<string, number>>({})
  const [pin, setPinState] = useState<string>(() => tg.localPin())
  useEffect(() => { tg.loadPin(me.id).then(setPinState, () => {}) }, [me.id])

  const load = useCallback(async () => {
    try {
      const cs = await tg.myChallenges(me.id)
      const rows = await Promise.all(cs.map(async (c) => {
        const r = await tg.loadRoom(c).catch(() => ({ people: [], progress: [] as DayCount[] }))
        return { c, members: r.people.length, progress: r.progress }
      }))
      setList(rows)
      setErr('')
      setNews(await tg.unread(me.id))
      const inv = await tg.myInvites()
      setInvites(inv)
      window.dispatchEvent(new CustomEvent('rs-invites', { detail: inv.length }))
    } catch (e) {
      setErr(navigator.onLine ? (e as Error).message : "Team challenges show up when you're back online.")
      setList([])
    }
  }, [me.id])
  useEffect(() => { load() }, [load])

  const t = ymd(today())
  const active = (list ?? []).filter((x) => x.c.ends_on >= t)
  const past = (list ?? []).filter((x) => x.c.ends_on < t)
  // Your team Card a Day (the newest one) lives inside your own Card a Day, so cards show up in one place.
  const teamCards = active.filter((x) => x.c.kind === 'cards').sort((a, b) => b.c.starts_on.localeCompare(a.c.starts_on))[0]
  const others = active.filter((x) => x !== teamCards)
  const pinned = pin === teamCards?.c.id || !others.some((x) => x.c.id === pin) ? 'cad' : pin

  async function setPin(id: string) {
    setPinState(id)
    toast(id === 'cad' ? 'Card a Day is pinned to the top.' : 'Pinned to the top.')
    try { await tg.savePin(me.id, id) } catch { /* kept on this phone */ }
  }

  const back = () => { setOpenId(null); load() }
  if (openId === 'cad') return <>{renderCad(back, teamCards ? <Room me={me} c={teamCards.c} embedded onBack={back} renderLog={renderLog} /> : null)}</>
  const chatOnly = openId?.startsWith('chat:') ?? false
  const open = list?.find((x) => x.c.id === (chatOnly ? openId!.slice(5) : openId))?.c
  if (open) return <Room me={me} c={open} onBack={back} renderLog={renderLog} pinned={pinned === open.id} onPin={() => setPin(open.id)} chatOnly={chatOnly || (open.kind === 'cards' && open.id === teamCards?.c.id)} />

  // Pinned first. Then the most urgent: goals not hit yet, with the least time left.
  const urgency = (x: Row) => (x.c.kind === 'cards' ? 50 : tg.current(x.c, x.progress, me.id) >= x.c.target ? 100 : tg.daysLeft(x.c.period))
  const rest = [...others].sort((a, b) => urgency(a) - urgency(b))
  const top = rest.find((x) => x.c.id === pinned)
  const below = rest.filter((x) => x !== top)
  const cadCard = (big: boolean) => <CadCard key="cad" cad={cad} big={big} team={teamCards} fresh={teamCards ? news[teamCards.c.id] ?? 0 : 0} onOpen={() => setOpenId('cad')} onChat={teamCards ? () => setOpenId(teamCards.c.id) : undefined} onPin={big ? undefined : () => setPin('cad')} />
  const card = (x: Row, big: boolean) => <ChallengeCard key={x.c.id} me={me} {...x} big={big} fresh={news[x.c.id] ?? 0} onOpen={() => setOpenId(x.c.id)} onChat={x.members > 1 ? () => setOpenId(`chat:${x.c.id}`) : undefined} onPin={big ? undefined : () => setPin(x.c.id)} />

  return (
    <section>
      <h2 style={{ marginTop: 14 }}>Challenges</h2>
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
      {pinned === 'cad' ? cadCard(true) : top ? card(top, true) : cadCard(true)}
      {pinned !== 'cad' && cadCard(false)}
      {list === null ? <p className="muted">Loading your challenges…</p> : below.map((x) => card(x, false))}
      {err && <p className="note">{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button className="btn primary lg" style={{ flex: 1, whiteSpace: 'nowrap' }} onClick={() => setStarting(true)}><IPlus size={18} /> Start a challenge</button>
        <button className="btn lg" style={{ flex: 1, whiteSpace: 'nowrap' }} onClick={() => setJoinCode('')}>Join</button>
      </div>
      {past.length > 0 && (
        <details className="more" style={{ marginTop: 20 }}>
          <summary>Finished ({past.length})</summary>
          <div className="stack">{past.map((x) => <ChallengeCard key={x.c.id} me={me} {...x} onOpen={() => setOpenId(x.c.id)} />)}</div>
        </details>
      )}
      {starting && <StartSheet me={me} onClose={() => setStarting(false)} onStarted={(c) => { setStarting(false); toast('Challenge started. Invite a few people, or keep it just for you.'); load().then(() => setOpenId(c.id)) }} />}
      {joinCode !== null && (
        <JoinSheet code={joinCode} onClose={() => { setJoinCode(null); store.set('rs-join', null) }}
          onJoined={(id) => { setJoinCode(null); store.set('rs-join', null); toast("You're in!"); load().then(() => setOpenId(id)) }} />
      )}
    </section>
  )
}

/** A tappable card with an optional pin button inside (a real button can't hold another button). */
function Tap({ className, onOpen, label, children }: { className: string; onOpen: () => void; label: string; children: ReactNode }) {
  return (
    <div className={className} role="button" tabIndex={0} aria-label={label} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>{children}</div>
  )
}
function PinBtn({ onPin }: { onPin?: () => void }) {
  if (!onPin) return <span className="pinned"><IPin size={14} /> Pinned</span>
  return <button className="pinbtn" aria-label="Pin to top" onClick={(e) => { e.stopPropagation(); onPin() }}><IPin size={16} /></button>
}

/** Opens the challenge's group chat, with a red count when there's something new. */
function ChatBtn({ fresh, onChat, block }: { fresh: number; onChat: () => void; block?: boolean }) {
  return (
    <button className={`btn chatbtn ${block ? 'lg block' : ''}`} aria-label={`Open group chat${fresh ? `, ${fresh} new` : ''}`} onClick={(e) => { e.stopPropagation(); onChat() }}>
      <IText size={18} /> Group chat{fresh > 0 && <span className="cbubble">{fresh > 99 ? '99+' : fresh}</span>}
    </button>
  )
}

function CadCard({ cad, big, team, fresh, onOpen, onChat, onPin }: { cad: CadInfo; big: boolean; team?: Row; fresh: number; onOpen: () => void; onChat?: () => void; onPin?: () => void }) {
  return (
    <Tap className={`chcard ${big ? 'big' : ''}`} onOpen={onOpen} label="Card a Day">
      <div className="row">
        <span className="chtag">Card a Day{team ? ` · with ${team.members - 1} ${team.members - 1 === 1 ? 'agent' : 'agents'}` : ''}</span>
        <PinBtn onPin={onPin} />
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <div className="chstreak"><b>{cad.streak}</b><span>day streak</span></div>
        {cad.banked > 0 ? <span className="banked">{cad.banked} banked ahead</span> : <span className="note">{cad.done ? (cad.covered ? 'Today is covered' : "Today's card is done") : 'Write one today'}</span>}
      </div>
      {big && (
        <>
          <div className="chweek" aria-hidden>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i}>{d}<i className={`${cad.week[i]} ${i === cad.todayIdx ? 't' : ''}`} /></div>)}
          </div>
          <button className="btn gold lg block" onClick={(e) => { e.stopPropagation(); onOpen() }}>{cad.done ? 'Write another card' : 'Write a card'}</button>
        </>
      )}
      {onChat && <div style={{ marginTop: big ? 10 : 12 }}><ChatBtn fresh={fresh} onChat={onChat} block={big} /></div>}
    </Tap>
  )
}

const PERIOD_TAG: Record<Period, string> = { day: 'Today', week: 'This week', month: 'This month' }
const KIND_COLOR: Record<string, string> = { call: 'var(--call)', text: 'var(--text)', card: 'var(--card)', popby: '#7a5ab8', facetoface: '#0f7a8a' }
const colorFor = (c: Challenge) => (c.kind === 'cards' ? 'var(--card)' : KIND_COLOR[c.counts[0]] ?? 'var(--navy)')

function ChallengeCard({ me, c, members, progress, big = false, fresh = 0, onOpen, onChat, onPin }: Row & { me: Profile; big?: boolean; fresh?: number; onOpen: () => void; onChat?: () => void; onPin?: () => void }) {
  const mine = tg.current(c, progress, me.id)
  const s = tg.streak(c, progress, me.id)
  const done = c.ends_on < ymd(today())
  const solo = members <= 1
  const left = Math.max(0, c.target - mine)
  const hist = big && c.kind === 'custom' ? tg.history(c, progress, me.id) : []
  const tag = done ? `Ended ${fmt(c.ends_on)}` : c.kind === 'cards' ? 'Card a Day' : PERIOD_TAG[c.period]
  return (
    <Tap className={`chcard ${big ? 'big' : ''}`} onOpen={onOpen} label={c.name}>
      <div className="row">
        <span className="chtag">{tag}{solo ? ' · just me' : ` · ${members} in`}</span>
        {!done && <PinBtn onPin={onPin} />}
      </div>
      <div className="row" style={{ marginTop: 2, alignItems: 'flex-end' }}>
        <b className="chname">{c.name}</b>
        <div className="chstreak sm"><b>{s}</b><span>{tg.unit(c.kind === 'cards' ? 'day' : c.period, s)} in a row</span></div>
      </div>
      {c.kind === 'custom' && !done && (
        <>
          <div className="chbar"><i style={{ width: `${Math.min(100, (mine / c.target) * 100)}%`, background: colorFor(c) }} /></div>
          <p className="note" style={{ margin: 0 }}><b style={{ color: 'var(--ink)' }}>{mine} of {c.target}</b> {left ? `· ${left} to go ${c.period === 'day' ? 'today' : c.period === 'week' ? 'this week' : 'this month'}` : '· goal hit!'}</p>
        </>
      )}
      {hist.length > 0 && <History hist={hist} color={colorFor(c)} />}
      {onChat && !done && <div style={{ marginTop: 12 }}><ChatBtn fresh={fresh} onChat={onChat} /></div>}
    </Tap>
  )
}

function History({ hist, color }: { hist: ReturnType<typeof tg.history>; color: string }) {
  return (
    <div className="chhist" aria-hidden>
      {hist.map((h, i) => <div key={i}><i style={h.hit ? { background: color } : h.now && h.n ? { background: `linear-gradient(to top, ${color} 40%, var(--line) 40%)` } : undefined} />{h.label}</div>)}
    </div>
  )
}

/** Your progress inside a challenge: this period's ring, past periods, and a button to log. */
function Mine({ me, c, progress, renderLog }: { me: Profile; c: Challenge; progress: DayCount[]; renderLog: (kinds: string[], onClose: () => void) => ReactNode }) {
  const [logging, setLogging] = useState(false)
  const cur = tg.current(c, progress, me.id)
  const s = tg.streak(c, progress, me.id)
  const left = Math.max(0, c.target - cur)
  const pct = Math.min(1, cur / c.target)
  const touchKinds = ['call', 'text', 'card', 'popby', 'facetoface']
  const kinds = c.counts.includes('any') ? touchKinds : c.counts.filter((k) => touchKinds.includes(k))
  const by = c.period === 'day' ? 'today' : c.period === 'week' ? 'this week' : 'this month'
  const one = singular(tg.noun(c))
  return (
    <div className="card mine">
      <div className="mini">
        <svg className="ring" viewBox="0 0 36 36" aria-hidden>
          <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" strokeWidth="5" />
          <circle cx="18" cy="18" r="15" fill="none" stroke={colorFor(c)} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${pct * 94.2} 94.2`} transform="rotate(-90 18 18)" />
          <text x="18" y="21.5" textAnchor="middle" fontSize="9.5" fontWeight="600" fill="currentColor">{cur}/{c.target}</text>
        </svg>
        <div>
          <b style={{ fontSize: 17 }}>{left ? `${left} more ${by}` : `Goal hit ${by}!`}</b>
          <div className="note">{s} {tg.unit(c.period, s)} in a row</div>
        </div>
      </div>
      <History hist={tg.history(c, progress, me.id)} color={colorFor(c)} />
      {kinds.length > 0 && c.ends_on >= ymd(today()) && (
        <button className="btn primary lg block" style={{ marginTop: 12 }} onClick={() => setLogging(true)}>Log {/^[aeiou]/.test(one) ? 'an' : 'a'} {kinds.length === 1 ? one : 'touch'}</button>
      )}
      {logging && renderLog(kinds, () => setLogging(false))}
    </div>
  )
}

function Room({ me, c, onBack, embedded = false, renderLog, pinned, onPin, chatOnly = false }: {
  me: Profile; c: Challenge; onBack: () => void; embedded?: boolean; chatOnly?: boolean
  renderLog: (kinds: string[], onClose: () => void) => ReactNode; pinned?: boolean; onPin?: () => void
}) {
  const toast = useToast()
  const swipeRef = useSwipeBack(embedded ? undefined : onBack)
  const [room, setRoom] = useState<{ people: Person[]; progress: DayCount[]; posts: Post[]; kudos: { post_id: string; user_id: string }[] } | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [inviting, setInviting] = useState(false)
  const [menu, setMenu] = useState(false)
  const load = useCallback(async () => {
    try { setRoom(await tg.loadRoom(c)); tg.markSeen(c.id) } catch (e) { toast((e as Error).message) }
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
  async function sendReply(e: FormEvent, parent: Post) {
    e.preventDefault()
    const body = reply.trim()
    if (!body) return
    setBusy(true)
    try { await tg.say(c.id, me.id, body, parent.id); setReply(''); setReplyTo(null); await load() } catch (err) { toast((err as Error).message) }
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
    <section className={`room ${embedded ? 'embedded' : ''}`} ref={swipeRef as RefObject<HTMLElement>}>
      {embedded ? (
        <div className="grp" style={{ marginTop: 26 }}>
          <span>{c.name} · {people.length} in</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn" onClick={() => setInviting(true)}>Invite</button>
            <button className="iconbtn" aria-label="More" onClick={() => setMenu(true)}><IMore /></button>
          </span>
        </div>
      ) : (
        <div className="roomhdr">
          <button className="iconbtn" aria-label="Back to challenges" onClick={onBack}><IChevL /></button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 21 }}>{c.name}</h2>
            <p className="note" style={{ margin: 0 }}>
              {(() => { const what = c.kind === 'cards' ? 'Card a Day' : `${c.target} ${tg.noun(c)} ${tg.per(c.period)}`; return what.toLowerCase() === c.name.toLowerCase() ? '' : `${what} · ` })()}{fmt(c.starts_on)} to {fmt(c.ends_on)}
            </p>
          </div>
          <button className="btn" onClick={() => setInviting(true)}>Invite</button>
          <button className="iconbtn" aria-label="More" onClick={() => setMenu(true)}><IMore /></button>
        </div>
      )}

      {!embedded && !chatOnly && c.kind === 'custom' && room && <Mine me={me} c={c} progress={room.progress} renderLog={renderLog} />}

      {people.length > 1 && <div className="crew">
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
      </div>}

      {room && people.length <= 1 && !embedded ? (
        <p className="note" style={{ textAlign: 'center', padding: '8px 12px' }}>Just you for now. <button className="link" onClick={() => setInviting(true)}>Invite people</button> and you'll cheer each other on here.</p>
      ) : (
        <>
      <form className="composer" onSubmit={send}>
        <input aria-label="Message" placeholder="Say something encouraging…" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>

      <div className="feed">
        {room === null && <p className="muted">Loading…</p>}
        {room && room.posts.length === 0 && <p className="note" style={{ textAlign: 'center', padding: 20 }}>Nothing yet. When anyone logs something for this challenge, it shows up here on its own.</p>}
        {room && (() => {
          // Replies sit under the post they answer, oldest first.
          const ids = new Set(room.posts.map((p) => p.id))
          const top = room.posts.filter((p) => !p.reply_to || !ids.has(p.reply_to))
          const under = new Map<string, Post[]>()
          for (const p of [...room.posts].reverse()) if (p.reply_to && ids.has(p.reply_to)) under.set(p.reply_to, [...(under.get(p.reply_to) ?? []), p])
          const kudoBtn = (p: Post, small = false) => {
            const ks = room.kudos.filter((k) => k.post_id === p.id)
            const mine = ks.some((k) => k.user_id === me.id)
            return (
              <button className={`kudo ${mine ? 'on' : ''} ${small ? 'sm' : ''}`} disabled={p.user_id === me.id} aria-pressed={mine}
                onClick={() => toggleKudo(p, !mine)}>👏 {small ? '' : 'Kudos'}{ks.length ? `${small ? '' : ' · '}${ks.length}` : ''}</button>
            )
          }
          return top.map((p) => {
            const name = names.get(p.user_id) ?? 'Someone'
            const s = p.auto_day ? tg.streak(c, room.progress, p.user_id) : 0
            const kids = under.get(p.id) ?? []
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
                  <div className="pacts">
                    {kudoBtn(p)}
                    <button className={`kudo ${replyTo === p.id ? 'on' : ''}`} onClick={() => { setReplyTo(replyTo === p.id ? null : p.id); setReply('') }}>💬 Reply</button>
                  </div>
                  {kids.length > 0 && (
                    <div className="replies">
                      {kids.map((r) => {
                        const rn = names.get(r.user_id) ?? 'Someone'
                        return (
                          <div key={r.id} className="reply">
                            <Avatar id={r.user_id} name={rn} size={28} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="ph"><b>{r.user_id === me.id ? 'You' : firstName(rn)}</b><span className="note"> · {ago(r.created_at)}</span>
                                {r.user_id === me.id && <button className="link pdel" onClick={() => remove(r)}>Remove</button>}
                              </div>
                              <div className="pbody">{r.body}</div>
                              {kudoBtn(r, true)}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {replyTo === p.id && (
                    <form className="composer replybox" onSubmit={(e) => sendReply(e, p)}>
                      <input autoFocus aria-label={`Reply to ${name}`} placeholder={`Reply to ${p.user_id === me.id ? 'your post' : firstName(name)}…`} value={reply} maxLength={500} onChange={(e) => setReply(e.target.value)} />
                      <button className="btn primary" disabled={busy || !reply.trim()}>Send</button>
                    </form>
                  )}
                </div>
              </div>
            )
          })
        })()}
      </div>
        </>
      )}

      {inviting && <InviteSheet c={c} me={me} members={(room?.people ?? []).map((p) => p.user_id)} onClose={() => setInviting(false)} />}
      {menu && (
        <Sheet label="Challenge options" onClose={() => setMenu(false)}>
          <h3>{c.name}</h3>
          <div className="menu" style={{ marginTop: 8 }}>
            {onPin && !pinned && c.ends_on >= t && <button onClick={() => { setMenu(false); onPin() }}>Pin to the top of Challenges</button>}
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
  const msg = `Join my "${c.name}" challenge on Rock Solid: ${link}\n\nAlready have the app? Open Challenges, tap Join, and enter code ${c.code}.`
  const [people, setPeople] = useState<Person[] | null>(null)
  const [sent, setSent] = useState<string[]>([])
  const [q, setQ] = useState('')
  useEffect(() => {
    Promise.all([tg.brokeragePeople(), tg.invited(c.id)]).then(([p, inv]) => { setPeople(p); setSent(inv) }, () => setPeople([]))
  }, [c.id])
  const shown = (people ?? []).filter((p) => !members.includes(p.user_id) && p.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
  async function ask(p: Person) {
    try { await tg.invite(c.id, p.user_id, me.id); setSent([...sent, p.user_id]); toast(`${firstName(p.name)} is invited. It's waiting on their Challenges tab.`) } catch (e) { toast((e as Error).message) }
  }
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> }
    if (nav.share) { try { await nav.share({ title: c.name, text: `Join my "${c.name}" challenge on Rock Solid. Already have the app? Open Challenges, tap Join, and enter code ${c.code}.`, url: link }) } catch { /* closed */ } }
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
          <p className="note" style={{ marginTop: -6 }}>It shows up on their Challenges tab. One tap to join.</p>
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
