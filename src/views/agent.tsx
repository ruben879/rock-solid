import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react'
import * as api from '../lib/data'
import { addDays, daysBetween, fmt, monthStart, parse, today, weekStart, ymd } from '../lib/dates'
import type { BdayEntry, BirthdayPlan, Occasion, Brokerage, Card, Contact, Heat, Profile, Tier, Touch, TouchKind } from '../lib/model'
import {
  HEAT_NAME, KIND_LABEL, TIERS, TIER_NAMES, cardCoverage, cardWithin12Months, rotation, shuffled, dailyFromPeople, dailyForPeople, fullName, heat, score, signal, suggestKind, telOf, tierDays, touchCounts,
  planNumbers, birthdaysToday, entryStillValid, planOf, yearsOn, OCCASION_META, OCCASION_LIST, hasYear, NO_YEAR,
} from '../lib/model'
import { formatPhone, planImport, readContacts } from '../lib/importer'
import { Celebrate, HeatTag, Rock, Sheet, Signal, store, SwipeRow, useSwipeBack, useToast } from '../ui'
import { GettingStarted } from './start'
import { GoalWizardHost, openGoalWizard } from './goals'
import { Together, type CadInfo } from './together'
import { MiniStool, StoolPage } from './stool'
import { IBell, ICard, ICards, ICheck, IChevL, IChevR, IDoor, IFace, IFlame, IList, IMore, IPeople, IPhone, IPlus, ISearch, IText } from '../icons'

export type AgentTab = 'week' | 'cards' | 'activity' | 'db' | 'stool'

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
  // The daily goal follows the people you actually have (unless you've set your own number).
  const auto = props.agent.plan?.auto_goals !== 0
  const fromPeople = data ? dailyFromPeople(data.contacts, props.agent) : 0
  const own = !props.readOnly && props.agent.id === props.me.id
  useEffect(() => {
    // Keep the saved goal in step, so Team views and the morning nudge use the same number.
    if (own && auto && fromPeople && props.agent.daily_goal !== fromPeople)
      api.updateMyProfile(props.me, { daily_goal: fromPeople, weekly_goal: fromPeople * 5 }).catch(() => {})
  }, [own, auto, fromPeople, props.agent.daily_goal, props.me])
  // Cards logged as a plain touch before they went through Card a Day: turn them into Card a Day entries, once.
  useEffect(() => {
    if (!own || !data || store.get<boolean>(`rs-cardfix1-${props.me.id}`, false)) return
    store.set(`rs-cardfix1-${props.me.id}`, true)
    api.repairPlainCards(props.me, data.touches, data.cards, data.contacts).then((n) => { if (n) reload() }).catch(() => store.set(`rs-cardfix1-${props.me.id}`, false))
  }, [own, data, props.me, reload])
  // A follow-up is done once you've touched that person on or after its date.
  useEffect(() => {
    if (!own || !data) return
    const t = ymd(today())
    for (const c of data.contacts) {
      if (!c.follow_up_on || c.follow_up_on > t) continue
      if (data.touches.some((x) => x.contact_id === c.id && !x.is_group && x.occurred_on >= c.follow_up_on!)) api.clearFollowUp(c).then(() => reload()).catch(() => {})
    }
  }, [own, data, reload])
  if (error) return <p className="error" style={{ marginTop: 24 }}>Couldn't load your list: {error}. Pull down to refresh.</p>
  if (!data) return <p className="muted" style={{ marginTop: 24 }}>Loading…</p>
  const agent = auto && fromPeople ? { ...props.agent, daily_goal: fromPeople, weekly_goal: fromPeople * 5 } : props.agent
  const ctx: Ctx = { ...props, agent, data, reload, goal: props.brokerage?.settings?.touch_goal ?? 36 }
  return (
    <>
      {props.tab === 'week' && <Today ctx={ctx} onGo={props.onGo} />}
      {props.tab === 'cards' && (props.readOnly
        ? <CardADay ctx={ctx} onProfileChange={props.onProfileChange} />
        : <Together me={props.me} cad={cadInfo(data.cards)}
            renderCad={(back, feed) => <CardADay ctx={ctx} onProfileChange={props.onProfileChange} onBack={back} extra={feed} />}
            renderLog={(kinds, close) => <ChallengeLog ctx={ctx} kinds={kinds} onClose={close} />} />)}
      {props.tab === 'activity' && <Progress ctx={ctx} onProfileChange={props.onProfileChange} />}
      {props.tab === 'db' && <People ctx={ctx} onProfileChange={props.onProfileChange} />}
      {props.tab === 'stool' && <StoolPage agent={agent} data={data} onBack={() => props.onGo?.('week')} />}
      {own && <GoalWizardHost me={props.me} agent={props.agent} contacts={data.contacts} onSaved={props.onProfileChange} />}
    </>
  )
}

function useAgentData1(id: string) {
  const ids = useMemo(() => [id], [id])
  return api.useAgentData(ids)
}

/** Older tiers that now behave like the three we use. */
const LEGACY: Partial<Record<Tier, Tier[]>> = { B: ['C', 'D'] }
const withLegacy = (ts: Tier[]) => [...new Set(ts.flatMap((t) => [t, ...(LEGACY[t] ?? [])]))]
const DID_LABEL: Record<string, string> = { call: 'I called', text: 'I texted', card: 'I sent a card', popby: 'I popped by', facetoface: 'Face to face' }
const KIND_ICON: Record<string, ReactNode> = { call: <IPhone />, text: <IText />, card: <ICard />, popby: <IDoor />, facetoface: <IFace /> }

// ======================================================================
// Today: a list the size of your daily goal
// ======================================================================
/**
 * Today's list holds as many people as your daily goal.
 * Anyone you didn't get to yesterday carries over, and the list is topped back up to the daily goal (never more),
 * so a missed day never snowballs. Finish the whole list and the next set loads.
 */
function useBatch(ctx: Ctx) {
  const { data, agent, readOnly } = ctx
  const full = Math.min(30, Math.max(1, agent.daily_goal || 5))
  const day = ymd(today())
  const ws = ymd(weekStart())
  const key = `rs-day3-${agent.id}-${day}`
  const lastKey = `rs-day3-${agent.id}-last`
  const touchedThisWeek = useMemo(
    () => new Set(data.touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on >= ws).map((t) => t.contact_id as string)),
    [data.touches, ws],
  )
  const [saved, setSaved] = useState<{ ids: string[]; round: number; stopped?: boolean }>(() => store.get(key, { ids: [], round: 0 }))
  const [justCleared, setJustCleared] = useState(false)

  // Follow-ups due today (or earlier) join the top of today's list and stay there for the day.
  const fuKey = `rs-fu-${agent.id}-${day}`
  const fuIds = useMemo(() => {
    const seen = store.get<string[]>(fuKey, [])
    const due = data.contacts.filter((c) => c.follow_up_on && c.follow_up_on <= day && !(c.skip_until && c.skip_until > day)).map((c) => c.id)
    const have = new Set(data.contacts.map((c) => c.id))
    return [...new Set([...seen, ...due])].filter((id) => have.has(id))
  }, [data.contacts, day, fuKey])
  useEffect(() => { if (!readOnly) store.set(fuKey, fuIds) }, [fuIds, fuKey, readOnly])

  // Birthdays go first. They take at most half of today's spots, so they never crowd out everyone else;
  // any extra birthdays show as a short line instead. Kept for the day, so a done one stays checked off.
  const bdKey = `rs-bd-${agent.id}-${day}`
  const bdAll = useMemo(() => {
    // Keep today's entries (so a done one stays checked off), but drop any whose date or choice changed.
    const byId = new Map(data.contacts.map((c) => [c.id, c]))
    const seen = store.get<BdayEntry[]>(bdKey, []).filter((e) => byId.has(e.id) && entryStillValid(byId.get(e.id)!, e))
    const now = birthdaysToday(data.contacts, data.touches).filter((e) => !seen.some((x) => x.id === e.id))
    return [...seen, ...now]
  }, [data.contacts, data.touches, bdKey])
  useEffect(() => { if (!readOnly) store.set(bdKey, bdAll) }, [bdAll, bdKey, readOnly])
  const bdCap = Math.max(1, Math.floor(full / 2))
  const bdays = bdAll.slice(0, bdCap)
  const bdMore = bdAll.slice(bdCap)
  const bdIds = bdays.map((e) => e.id)
  const size = Math.max(0, full - bdIds.length)
  const fuShown = fuIds.filter((id) => !bdIds.includes(id))

  const result = useMemo(() => {
    const byId = new Map(data.contacts.map((c) => [c.id, c]))
    const top = [...bdIds, ...fuShown]
    let ids = saved.ids.filter((id) => byId.has(id) && !top.includes(id))
    let round = saved.round
    let cleared = false
    // If the daily goal went down, trim today's list to fit (people already reached stay).
    if (ids.length > size && round <= 1) {
      const reached = ids.filter((id) => touchedThisWeek.has(id))
      const open = ids.filter((id) => !touchedThisWeek.has(id))
      const keep = new Set([...reached, ...open].slice(0, Math.max(size, reached.length)))
      ids = ids.filter((id) => keep.has(id))
    }
    const poolExcluding = (ex: string[], want = size) => rotation(data.contacts, agent, data.touches, touchedThisWeek, new Set([...ex, ...top]), want, agent.id)
    if (ids.length === 0) {
      // New day: bring forward whoever wasn't reached on the last list, then fill up to the daily goal.
      const last = store.get<{ day: string; ids: string[] } | null>(lastKey, null)
      let carry: string[] = []
      if (last && last.day < day) {
        const reached = new Set(data.touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on >= last.day).map((t) => t.contact_id as string))
        carry = last.ids.filter((id) => {
          const c = byId.get(id)
          return c && !reached.has(id) && (!c.skip_until || c.skip_until <= day)
        }).filter((id) => !top.includes(id)).slice(0, size)
      }
      // People already reached today count toward today's list, so the stones show today's real progress.
      const doneToday = [...new Set(data.touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on === day && byId.has(t.contact_id)).map((t) => t.contact_id as string))].filter((id) => !top.includes(id)).slice(0, size)
      carry = carry.filter((id) => !doneToday.includes(id)).slice(0, size - doneToday.length)
      const start = [...doneToday, ...carry]
      // Mixed order (not alphabetical), the same all day.
      ids = shuffled([...start, ...poolExcluding(start, size - start.length).map((c) => c.id)], `${agent.id}|${day}`)
      round = ids.length ? 1 : 0
    }
    // A birthday came off the list (date changed or removed): fill its spot so the day stays full.
    if (ids.length > 0 && ids.length < size && round <= 1) ids = [...ids, ...poolExcluding(ids, size - ids.length).map((c) => c.id)]
    const allDone = ids.length > 0 && ids.every((id) => touchedThisWeek.has(id))
    const waiting = poolExcluding(ids, 1).length
    return { ids, round, cleared, waiting, size: full, allDone, stopped: !!saved.stopped }
  }, [saved, data.contacts, data.touches, agent, touchedThisWeek, size, full, day, lastKey, fuShown.join(), bdIds.join()]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Finished the list: load another round for today (asked, never automatic). */
  const loadMore = () => {
    const next = rotation(data.contacts, agent, data.touches, touchedThisWeek, new Set([...result.ids, ...bdIds, ...fuShown]), full, agent.id).map((c) => c.id)
    if (!next.length) return
    const v = { ids: next, round: result.round + 1 }
    if (!readOnly) {
      store.set(key, v)
      store.set(lastKey, { day, ids: next })
    }
    setSaved(v)
  }
  const stopForToday = () => {
    const v = { ids: result.ids, round: result.round, stopped: true }
    if (!readOnly) store.set(key, v)
    setSaved(v)
  }

  useEffect(() => {
    if (result.ids.join() !== saved.ids.join() || result.round !== saved.round) {
      const v = { ids: result.ids, round: result.round }
      if (!readOnly) {
        store.set(key, v)
        store.set(lastKey, { day, ids: result.ids })
      }
      setSaved(v)
      if (result.cleared) setJustCleared(true)
    }
  }, [result, saved, key, lastKey, day, readOnly])

  const replace = (id: string) => {
    const pool = rotation(data.contacts, agent, data.touches, touchedThisWeek, new Set([...result.ids, id, ...bdIds, ...fuShown]), 1, agent.id)
    const ids = result.ids.filter((x) => x !== id)
    if (pool[0]) ids.push(pool[0].id)
    const v = { ids, round: result.round }
    if (!readOnly) {
      store.set(key, v)
      store.set(lastKey, { day, ids })
    }
    setSaved(v)
    return pool[0]
  }
  return { ...result, fuIds: fuShown, bdays, bdMore, touchedThisWeek, justCleared, setJustCleared, replace, loadMore, stopForToday }
}

function goalState(ctx: Ctx) {
  const t = ymd(today())
  const ws = ymd(weekStart())
  const ind = ctx.data.touches.filter((x) => !x.is_group)
  return {
    today: ind.filter((x) => x.occurred_on === t).length,
    week: ind.filter((x) => x.occurred_on >= ws).length,
    card: cardCoverage(ctx.data.cards).has(t),
  }
}

/** "Group email" for email blasts, "Group mailout" for mailed newsletters, otherwise the plain type. */
function touchLabel(t: { kind: TouchKind; is_group?: boolean }) {
  if (!t.is_group) return KIND_LABEL[t.kind]
  if (t.kind === 'email') return 'Group email'
  if (t.kind === 'newsletter') return 'Group mailout'
  return `Group ${KIND_LABEL[t.kind].toLowerCase()}`
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

/** Is this person on today's list? Read from what Today saved on this phone. */
function onTodaysList(agentId: string, contactId: string) {
  const day = ymd(today())
  const ids = store.get<{ ids: string[] }>(`rs-day3-${agentId}-${day}`, { ids: [] }).ids
  const fu = store.get<string[]>(`rs-fu-${agentId}-${day}`, [])
  const bd = store.get<{ id: string }[]>(`rs-bd-${agentId}-${day}`, []).map((e) => e.id)
  return [...ids, ...fu, ...bd].includes(contactId)
}
/** Rocks only stack for people on today's list, so say so kindly when someone logs a touch with anyone else. */
const offListNote = (c: Contact) => `Great job recording a touch with ${c.first_name || fullName(c)}! Reach someone on today's list to stack your rocks.`

const longDay = (d: string) => parse(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

/** One short, plain line about why this person is on the list. */
function whyLine(c: Contact, last: { kind: TouchKind; occurred_on: string; is_group?: boolean } | undefined) {
  if (c.birthday) {
    const b = parse(c.birthday)
    const next = new Date(today().getFullYear(), b.getMonth(), b.getDate(), 12)
    const d = daysBetween(today(), next)
    if (d >= 0 && d <= 10) return d === 0 ? 'Birthday is today!' : `Birthday ${fmt(next)}`
  }
  if (!last && !c.last_touch_on) return 'First touch'
  if (last) return `Last: ${touchLabel(last).toLowerCase()}, ${fmt(last.occurred_on)}`
  return `Last: ${fmt(c.last_touch_on as string)}`
}

/** Why some rocks are dotted: the gap between the people you have and the people your plan needs. */
function GapSheet({ have, need, today: now, atPlan, onClose, onAdd, onGoals }: { have: number; need: number; today: number; atPlan: number; onClose: () => void; onAdd: () => void; onGoals: () => void }) {
  const gap = Math.max(0, need - have)
  const extra = Math.max(0, atPlan - now)
  return (
    <Sheet label="Why some rocks are dotted" onClose={onClose}>
      <h3>Why some rocks are dotted</h3>
      <div className="stones" style={{ margin: '6px 0 4px' }} aria-hidden>
        {Array.from({ length: Math.min(30, now) }, (_, i) => <Rock key={i} i={i} on={false} />)}
        {Array.from({ length: Math.min(30 - Math.min(30, now), extra) }, (_, i) => <Rock key={`g${i}`} i={now + i} on={false} ghost />)}
      </div>
      <p><b>Solid rocks</b> are the people to reach today, from the {have} {have === 1 ? 'person' : 'people'} you have now.</p>
      <p><b>Dotted rocks</b> are the gap. Your plan for the year calls for {need} people, which works out to about {atPlan} a day. As you add people, dotted rocks turn solid.</p>
      <div className="gapbar" role="img" aria-label={`${have} of ${need} people`}>
        <i style={{ width: `${Math.min(100, (have / Math.max(1, need)) * 100)}%` }} />
      </div>
      <div className="gaplabels"><span><b>{have}</b> you have</span><span><b>{gap}</b> to go</span><span><b>{need}</b> your plan</span></div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn primary" style={{ flex: 1 }} onClick={onAdd}>Add people</button>
        <button className="btn" style={{ flex: 1 }} onClick={onGoals}>Change my goals</button>
      </div>
    </Sheet>
  )
}

function Today({ ctx, onGo }: { ctx: Ctx; onGo?: (t: AgentTab) => void }) {
  const { data, agent, readOnly } = ctx
  const toast = useToast()
  const b = useBatch(ctx)
  const [logFor, setLogFor] = useState<Contact | null>(null)
  const [moreFor, setMoreFor] = useState<Contact | null>(null)
  const [doneFor, setDoneFor] = useState<Contact | null>(null)
  const [editFor, setEditFor] = useState<Contact | null>(null)
  const [viewFor, setViewFor] = useState<Contact | null>(null)
  const [recording, setRecording] = useState(false)
  const [cardFor, setCardFor] = useState<Contact | null>(null)
  const [reach, setReach] = useState<{ c: Contact; kind: 'call' | 'text' } | null>(null)
  const [noteFor, setNoteFor] = useState<{ t: Touch; c: Contact } | null>(null)
  // List or one-at-a-time cards. Each person picks; the phone remembers.
  const [view, setViewMode] = useState<'list' | 'cards'>(() => (store.get<string>('rs-view', 'cards') === 'list' ? 'list' : 'cards'))
  const pickView = (v: 'list' | 'cards') => { setViewMode(v); store.set('rs-view', v) }
  // Stack: which card is showing, plus the live drag so the card follows your finger.
  const [pos, setPos] = useState(0)
  const [enter, setEnter] = useState<'next' | 'prev'>('next')
  const [drag, setDrag] = useState(0)
  // Show "Swipe left or right" until someone has swiped a few times.
  const [swipes, setSwipes] = useState(() => store.get<number>('rs-swipes', 0))
  const touch = useRef<{ x: number; y: number; dir: 'h' | 'v' | null } | null>(null)
  const [cele, setCele] = useState<{ eyebrow: string; title: string; sub: string } | null>(null)
  const pendingCheck = useRef<boolean[] | null>(null)
  // After you log something, glide back to the top so you see your rocks and the next person.
  const logged = useRef(data.touches.length)
  useEffect(() => {
    if (data.touches.length > logged.current && !readOnly) window.scrollTo({ top: 0, behavior: 'smooth' })
    logged.current = data.touches.length
  }, [data.touches.length, readOnly])

  const byId = new Map(data.contacts.map((c) => [c.id, c]))
  // Follow-ups first. They count as done once you've touched them today.
  const tk = ymd(today())
  const touchedToday = new Set(data.touches.filter((t) => !t.is_group && t.occurred_on === tk && t.contact_id).map((t) => t.contact_id as string))
  const isFu = (c: Contact) => b.fuIds.includes(c.id)
  // Birthdays come first: a text on the day, or a card a few days early.
  const bdOf = (c: Contact) => b.bdays.find((e) => e.id === c.id)
  const cardSent = (c: Contact, on: string) => {
    const since = ymd(addDays(parse(on), -10))
    return data.touches.some((t) => t.contact_id === c.id && !t.is_group && t.kind === 'card' && t.occurred_on >= since)
  }
  const isDone = (c: Contact) => {
    const bd = bdOf(c)
    if (bd) return bd.kind === 'card' ? cardSent(c, bd.on) : touchedToday.has(c.id)
    return isFu(c) ? touchedToday.has(c.id) : b.touchedThisWeek.has(c.id)
  }
  const rows = [...b.bdays.map((e) => e.id), ...b.fuIds, ...b.ids].map((id) => byId.get(id)).filter(Boolean) as Contact[]
  // Birthday or anniversary wording for each entry.
  const occWord = (bd: BdayEntry) => {
    const o = bd.occ ?? 'birthday'
    return o === 'birthday' ? 'birthday' : o === 'home' ? 'home anniversary' : 'anniversary'
  }
  const remindOnDay = async (c: Contact, bd: BdayEntry) => {
    const o = bd.occ ?? 'birthday'
    try {
      await api.setFollowUp(c, bd.on, o === 'birthday' ? 'Wish them a happy birthday' : o === 'home' ? 'Happy home anniversary' : 'Happy anniversary')
      await ctx.reload()
      toast(`${c.first_name || fullName(c)} will be back on Today on their ${occWord(bd)}.`)
    } catch (e) { toast((e as Error).message) }
  }
  const bdBadge = (c: Contact, bd: BdayEntry, long = false) => {
    const m = OCCASION_META[bd.occ ?? 'birthday']
    const yrs = m.years ? yearsOn(c, bd.occ!, bd.on) : 0
    const label = bd.kind === 'day' ? `${m.name} today` : `${m.name} ${fmt(bd.on)}${long ? ': mail a card' : ''}`
    return <span className={`fubadge bdbadge occ-${bd.occ ?? 'birthday'}`}>{m.icon} {label}{yrs > 0 ? ` · ${yrs} ${yrs === 1 ? 'year' : 'years'}` : ''}</span>
  }
  const bdWhy = (c: Contact, bd: BdayEntry) => {
    const name = c.first_name || fullName(c)
    const o = bd.occ ?? 'birthday'
    if (bd.kind === 'card') {
      const yrs = o === 'birthday' ? 0 : yearsOn(c, o, bd.on)
      if (o === 'home' && yrs > 0) return `${yrs} ${yrs === 1 ? 'year' : 'years'} in their home on ${longDay(bd.on)}. Mail a card today so it lands in time.`
      if (o === 'wedding' && yrs > 0) return `${yrs} years married on ${longDay(bd.on)}. Mail a card today so it lands in time.`
      return `Mail it today so it lands by ${longDay(bd.on)}.`
    }
    if (cardSent(c, ymd(addDays(parse(bd.on), 1)))) return `You sent ${name} a card. A quick text today shows you remembered the day.`
    if (o === 'birthday') return `Send ${name} a happy birthday text.`
    const yrs = yearsOn(c, o, bd.on)
    if (o === 'home') return yrs > 0 ? `${yrs} ${yrs === 1 ? 'year' : 'years'} in their home today. Send ${name} a happy home anniversary text.` : `Send ${name} a happy home anniversary text.`
    const wy = yearsOn(c, 'wedding', bd.on)
    return wy > 0 ? `${wy} years married today. Send ${name} a happy anniversary text.` : `Send ${name} a happy anniversary text.`
  }
  const bdRemind = (c: Contact, bd: BdayEntry) => bd.kind === 'card' && !readOnly && planOf(c, bd.occ ?? 'birthday') !== 'both' && (
    c.follow_up_on === bd.on
      ? <p className="bdagain on"><ICheck size={14} /> They'll be back on Today on their {occWord(bd)}</p>
      : <button className="bdagain" onClick={() => remindOnDay(c, bd)}>🔔 Remind me again on their {occWord(bd)}</button>
  )
  const todo = rows.filter((c) => !isDone(c))
  const doneRows = rows.filter((c) => isDone(c))
  const done = doneRows.length
  // Position in the list decides ties, so each day's list mixes calls, texts and cards.
  const sug = (c: Contact): 'call' | 'text' | 'card' => {
    const bd = bdOf(c)
    if (bd) return bd.kind === 'card' ? 'card' : c.phone ? 'text' : 'call'
    return suggestKind(c, data.touches, Math.max(0, b.ids.indexOf(c.id)) + b.round * 3)
  }
  // Bars cool off from the last one-on-one touch; group emails and mailouts don't warm them back up.
  const personalBy = useMemo(() => touchCounts(data.touches.filter((t) => !t.is_group)), [data.touches])
  const lastOf = (c: Contact) => data.touches.filter((t) => t.contact_id === c.id).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on)).at(-1)
  const g = goalState(ctx)

  // Which goals are met right now: all caught up, weekly, daily, Card a Day.
  const flags = () => [rows.length > 0 && done === rows.length && b.waiting === 0, g.week >= agent.weekly_goal, g.today >= agent.daily_goal, g.card]
  const snapshot = () => { pendingCheck.current = flags() }

  // Celebrate only a goal that THIS log just completed, once per day/week.
  useEffect(() => {
    const before = pendingCheck.current
    if (!before || readOnly || noteFor) return // Wait until the note question is answered.
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
    if (kind === 'card') { setCardFor(c); return } // Cards go through Card a Day.
    try {
      const before = flags()
      const t = await api.logTouch(ctx.me, c.id, kind, note)
      pendingCheck.current = before
      await ctx.reload()
      const off = !rows.some((r) => r.id === c.id) && todo.some((r) => r.id !== c.id)
      toast(off ? offListNote(c) : `${KIND_LABEL[kind]} recorded for ${c.first_name}.`, { label: 'Undo', run: () => { setNoteFor(null); undo(t) } })
      if (!note) setNoteFor({ t, c })
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

  // A bubble with how many people are still open today: on the app icon (when the phone allows it) and on the Today tab.
  const open = readOnly ? -1 : todo.length
  useEffect(() => {
    if (open < 0) return
    window.dispatchEvent(new CustomEvent('rs-open', { detail: open }))
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    if (open > 0) nav.setAppBadge?.(open).catch(() => {})
    else nav.clearAppBadge?.().catch(() => {})
  }, [open])

  // Dotted rocks: the extra daily touches your plan needs once your database reaches its size.
  const plan = planNumbers(agent.plan)
  const [gapInfo, setGapInfo] = useState(false)
  const ghosts = !readOnly && agent.plan?.auto_goals !== 0 && data.contacts.length > 0 && data.contacts.length < plan.dbNeeded && b.round <= 1
    ? Math.max(0, Math.min(30, dailyForPeople(plan.dbNeeded, data.contacts, agent)) - Math.max(b.size, rows.length)) : 0

  const first = (agent.full_name || agent.email).split(' ')[0]
  const caughtUp = rows.length === 0 || (todo.length === 0 && b.waiting === 0)
  return (
    <section>
      <p className="date">{today().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h2 className="hello">{readOnly ? `${first}'s list` : `${greeting()}, ${first}`}</h2>
      {!readOnly && <GettingStarted contacts={data.contacts} agent={agent} onGo={onGo} />}
      {rows.length > 0 && (
        <div className="stones" role="img" aria-label={`${done} of ${rows.length} done${ghosts ? `, ${ghosts} more as you add people` : ''}`}>
          {rows.map((c, i) => <Rock key={c.id} i={i} on={i < done} />)}
          {Array.from({ length: ghosts }, (_, i) => <Rock key={`g${i}`} i={rows.length + i} on={false} ghost />)}
        </div>
      )}
      {ghosts > 0 && (
        <button className="ghostnote" onClick={() => setGapInfo(true)}>
          Dotted rocks are your gap: {plan.dbNeeded - data.contacts.length} more people to reach your plan of {plan.dbNeeded}. <u>Why?</u>
        </button>
      )}
      {gapInfo && <GapSheet have={data.contacts.length} need={plan.dbNeeded} today={rows.length} atPlan={Math.min(30, dailyForPeople(plan.dbNeeded, data.contacts, agent))}
        onClose={() => setGapInfo(false)} onAdd={() => { setGapInfo(false); onGo?.('db') }} onGoals={() => { setGapInfo(false); openGoalWizard() }} />}
      {b.bdMore.length > 0 && (
        <p className="bdmore">🎉 Also celebrating:{' '}
          {b.bdMore.map((e, i) => { const c = byId.get(e.id); return c ? <span key={e.id}>{i ? ', ' : ''}<button className="link" onClick={() => setViewFor(c)}>{fullName(c)}</button>{e.occ && e.occ !== 'birthday' ? ` ${OCCASION_META[e.occ].icon}` : ''}{e.kind === 'card' ? ` (card, ${fmt(e.on)})` : ''}</span> : null })}
        </p>
      )}
      <div className="todayrow">
        {rows.length > 0 ? <p className="stones-l"><b>{done} of {rows.length}</b> done{b.round > 1 ? ` (set ${b.round})` : ''}</p> : <span />}
        {!readOnly && <button className="recpill" onClick={() => setRecording(true)}><IPlus size={18} /> Record a touch</button>}
      </div>

      {b.allDone && b.waiting > 0 && !readOnly && (
        b.stopped ? (
          <div className="banner" style={{ marginTop: 16 }}>
            <p><b>Done for today.</b> Nice work. Your next ones will be here tomorrow.</p>
            <button className="btn ghost" onClick={b.loadMore}>Load {Math.min(b.size, b.waiting)} more</button>
          </div>
        ) : (
          <div className="banner" style={{ marginTop: 16, flexDirection: 'column', alignItems: 'stretch' }}>
            <p><b>You finished all {rows.length}!</b> Want to load another round of {Math.min(b.size, b.waiting)} for today?</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" style={{ flex: 1 }} onClick={b.loadMore}>Yes, load {Math.min(b.size, b.waiting)} more</button>
              <button className="btn" style={{ flex: 1 }} onClick={b.stopForToday}>I'm done for today</button>
            </div>
          </div>
        )
      )}

      {caughtUp ? (
        <div className="card empty" style={{ marginTop: 20 }}>
          <h3 style={{ color: 'var(--ink)', marginBottom: 6 }}>{data.contacts.length ? "You're all caught up" : 'Your list is empty'}</h3>
          <p>{data.contacts.length ? 'Nobody else is due this week. Enjoy it.' : 'Add the people you know and they will show up here, a few each day.'}</p>
          {!data.contacts.length && !readOnly && <button className="btn primary" style={{ marginTop: 14 }} onClick={() => onGo?.('db')}>Add people</button>}
        </div>
      ) : (
        <>
        <div className={`viewtog ${view === 'cards' ? 'over' : ''}`} role="group" aria-label="How to show your people">
          <button aria-pressed={view === 'cards'} aria-label="One at a time" onClick={() => pickView('cards')}><ICards size={18} /></button>
          <button aria-pressed={view === 'list'} aria-label="List" onClick={() => pickView('list')}><IList size={18} /></button>
        </div>
        {view === 'cards' ? (() => {
          // Swipe left for the next person, right to go back. When someone is done they drop out and the next slides in.
          const n = todo.length
          const i = Math.min(pos, n - 1)
          const c = todo[i]
          if (!c) return null
          const k = sug(c)
          const name = c.first_name || fullName(c)
          const go = (d: 1 | -1) => {
            const j = i + d
            if (j < 0 || j >= n) return
            setEnter(d > 0 ? 'next' : 'prev')
            setPos(j)
          }
          // Past the first or last card, the card only gives a little.
          const shown = (i === 0 && drag > 0) || (i === n - 1 && drag < 0) ? drag / 4 : drag
          return (
            <div className="deck">
              <div className="togo">
                <button className="iconbtn" aria-label="Previous person" disabled={i === 0} onClick={() => go(-1)}><IChevL /></button>
                <span>{i + 1} of {n}{swipes < 3 && n > 1 && <small className="swipehint">Swipe left or right</small>}</span>
                <button className="iconbtn" aria-label="Next person" disabled={i === n - 1} onClick={() => go(1)}><IChevR /></button>
              </div>
              <div className={`pile backs-${Math.min(2, n - i - 1)}`}>
              {Math.min(2, n - i - 1) >= 2 && <div className="pback b2" aria-hidden="true" />}
              {Math.min(2, n - i - 1) >= 1 && <div className="pback b1" aria-hidden="true" />}
              <article key={c.id} className={`pcard in-${enter} ${drag ? 'dragging' : ''} ${bdOf(c) ? 'bd' : isFu(c) ? 'fu' : ''}`}
                style={shown ? { transform: `translateX(${shown}px) rotate(${shown / 40}deg)` } : undefined}
                onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dir: null } }}
                onTouchMove={(e) => {
                  const t = touch.current
                  if (!t) return
                  const dx = e.touches[0].clientX - t.x
                  const dy = e.touches[0].clientY - t.y
                  if (!t.dir && Math.abs(dx) + Math.abs(dy) > 8) t.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
                  if (t.dir === 'h') setDrag(dx)
                }}
                onTouchEnd={() => {
                  const d = drag
                  touch.current = null
                  setDrag(0)
                  if (Math.abs(d) > 60) { const k = swipes + 1; setSwipes(k); store.set('rs-swipes', k) }
                  if (d < -60) go(1)
                  else if (d > 60) go(-1)
                }}>
                <div className="pc-top">
                  <div className="pc-row">
                    <span className={`ttag ${c.tier === 'U' ? 'q' : ''}`} style={{ marginLeft: 0 }}>{c.tier === 'U' ? '?' : c.tier === 'A' ? 'A' : 'B'}</span>
                    <span style={{ flex: 1 }} />
                    <Signal bars={signal(c, personalBy, agent.tier_days)} plain />
                    {!readOnly && <button className="iconbtn" aria-label={`More for ${name}`} onClick={() => setMoreFor(c)}><IMore /></button>}
                  </div>
                  {bdOf(c) ? bdBadge(c, bdOf(c)!) : isFu(c) && <span className="fubadge"><IBell size={14} /> Follow-up</span>}
                  <h3 className="pc-name"><button className="namebtn" onClick={() => setViewFor(c)} aria-label={`See ${fullName(c)}'s details and history`}>{fullName(c)}</button></h3>
                  {bdOf(c) ? <p className="why funote">{bdWhy(c, bdOf(c)!)}</p> : isFu(c) && c.follow_up_note ? <p className="why funote">{c.follow_up_note}</p> : <p className="why">{whyLine(c, lastOf(c))}</p>}
                </div>
                <div className="pc-bot">
                  {readOnly ? (
                    <p className={`kind k-${k}`}>{KIND_ICON[k]} {KIND_LABEL[k]} suggested</p>
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
                    </div>
                  )}
                  {bdOf(c) && bdRemind(c, bdOf(c)!)}
                </div>
              </article>
              </div>
              {!readOnly && (
                <div className="pc-foot">
                  <button className="btn primary lg" onClick={() => setLogFor(c)}><ICheck size={18} /> Already did it</button>
                </div>
              )}
              {n > 1 && n <= 20 && (
                <div className="dots" aria-hidden="true">{todo.map((p, j) => <span key={p.id} className={j === i ? 'on' : ''} />)}</div>
              )}
            </div>
          )
        })() : (
        <div className="people">
          {todo.map((c) => {
            const k = sug(c)
            const name = c.first_name || fullName(c)
            return (
              <article key={c.id} className={`person ${bdOf(c) ? 'bd' : isFu(c) ? 'fu' : ''}`}>
                {bdOf(c) ? bdBadge(c, bdOf(c)!, true) : isFu(c) && <span className="fubadge"><IBell size={14} /> Follow-up{c.follow_up_note ? `: ${c.follow_up_note}` : ''}</span>}
                <div className="head">
                  <div style={{ minWidth: 0 }}>
                    <h3><button className="namebtn" onClick={() => setViewFor(c)} aria-label={`See ${fullName(c)}'s details and history`}>{fullName(c)}</button> <span className={`ttag ${c.tier === 'U' ? 'q' : ''}`} title={TIER_NAMES[c.tier]}>{c.tier === 'U' ? '?' : c.tier === 'A' ? 'A' : 'B'}</span></h3>
                    <p className="why">{bdOf(c) ? bdWhy(c, bdOf(c)!) : whyLine(c, lastOf(c))}</p>
                  </div>
                  <div className="sig">
                    <Signal bars={signal(c, personalBy, agent.tier_days)} plain />
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
                {bdOf(c) && bdRemind(c, bdOf(c)!)}
              </article>
            )
          })}
        </div>
        )}
        </>
      )}

      {doneRows.length > 0 && (
        <details className="donelist">
          <summary>Done this week ({doneRows.length})</summary>
          <div className="card" style={{ padding: '4px 16px' }}>
            {doneRows.map((c) => {
              const l = lastOf(c)
              return (
                <button key={c.id} className="donerow" disabled={readOnly} onClick={() => setDoneFor(c)}>
                  <span className="tick"><ICheck size={16} /></span>
                  <span style={{ flex: 1 }}>{fullName(c)}</span>
                  {l && <span className="note">{touchLabel(l)}</span>}
                </button>
              )
            })}
          </div>
        </details>
      )}

      {/* Preview for the broker only: the three-legged stool. */}
      {!readOnly && ctx.me.role === 'broker' && agent.id === ctx.me.id && <MiniStool agent={agent} data={data} onOpen={() => onGo?.('stool')} />}
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
      {recording && <RecordSheet ctx={ctx} onClose={() => setRecording(false)} onLog={(c, k, n) => { setRecording(false); log(c, k, n) }} />}
      {viewFor && <PersonSheet ctx={ctx} c={viewFor} onClose={() => setViewFor(null)} onEdit={() => { const c = viewFor; setViewFor(null); setEditFor(c) }} />}
      {doneFor && <DoneSheet ctx={ctx} c={doneFor} onClose={() => setDoneFor(null)} onEdit={() => { const c = doneFor; setDoneFor(null); setEditFor(c) }} />}
      {cardFor && <CardSheet ctx={ctx} c={cardFor} occasion={bdOf(cardFor) ? OCCASION_META[bdOf(cardFor)!.occ ?? 'birthday'].card : undefined} onBefore={snapshot} onClose={() => setCardFor(null)} />}
      {reach && (
        <div className="reach" role="status">
          <p>Did you {reach.kind} {reach.c.first_name}?</p>
          <div>
            <button className="btn gold lg" onClick={() => { const r = reach; setReach(null); log(r.c, r.kind, '') }}>Yes, mark done</button>
            <button className="btn lg" onClick={() => setReach(null)}>Not yet</button>
          </div>
        </div>
      )}
      {noteFor && <NoteSheet ctx={ctx} t={noteFor.t} c={noteFor.c} onClose={() => setNoteFor(null)} onUndo={() => { const t = noteFor.t; setNoteFor(null); undo(t) }} />}
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
                <button className="btn primary" style={{ flex: 1 }} disabled={busy || (e.kind === t.kind && e.note === (t.note ?? ''))} onClick={() => run(() => api.updateTouch(ctx.me, t.id, { kind: e.kind, note: e.note || null }), 'Saved.')}>Save change</button>
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

/** Record any touch from the top of Today: pick (or add) the person, pick what you did. */
function RecordSheet({ ctx, onClose, onLog, kinds }: { ctx: Ctx; onClose: () => void; onLog: (c: Contact, kind: TouchKind, note: string) => void; kinds?: TouchKind[] }) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [who, setWho] = useState<Contact | null>(null)
  const [adding, setAdding] = useState(false)
  const busy = false
  const term = q.trim().toLowerCase()
  const matches = term
    ? ctx.data.contacts.filter((c) => fullName(c).toLowerCase().includes(term) || (c.phone ?? '').replace(/\D/g, '').includes(term.replace(/\D/g, '') || '~')).slice(0, 6)
    : []
  const exact = ctx.data.contacts.some((c) => fullName(c).toLowerCase() === term)

  function pick(kind: TouchKind) {
    if (who) onLog(who, kind, '')
  }

  // New person: fill in everything you know first (same form as People), then pick what you did.
  if (adding && !who)
    return (
      <EditSheet ctx={ctx} c={null} prefill={{ name: q }} saveLabel="Save and continue" onClose={() => setAdding(false)}
        onSaved={(c) => { setAdding(false); toast(`${c.first_name} added to your people.`); if (kinds?.length === 1) onLog(c, kinds[0], ''); else setWho(c) }} />
    )
  const ready = !!who
  return (
    <Sheet label="Record a touch" onClose={onClose}>
      <h3>{kinds?.length === 1 ? `Log a ${KIND_LABEL[kinds[0]].toLowerCase()}` : 'Record a touch'}</h3>
      {!ready ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="search"><ISearch size={20} /><input autoFocus aria-label="Who did you talk to?" placeholder="Who did you talk to?" value={q} onChange={(e) => { setQ(e.target.value); setAdding(false) }} /></div>
          {matches.length > 0 && (
            <div className="sugs" style={{ marginTop: -4 }}>
              {matches.map((c) => (
                <button key={c.id} onClick={() => (kinds?.length === 1 ? onLog(c, kinds[0], '') : setWho(c))}>{fullName(c)}{c.phone ? <span className="note"> · {c.phone}</span> : null}</button>
              ))}
            </div>
          )}
          {term && !exact && (
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}><IPlus size={18} /> Add "{q.trim()}" as a new person</button>
          )}
          {!term && <p className="note">Start typing a name. If they're not in your people yet, you can add them right here.</p>}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="pick">
            <span><b style={{ fontWeight: 600 }}>{who ? fullName(who) : ''}</b></span>
            <button className="link" onClick={() => { setWho(null); setAdding(false) }}>Change</button>
          </div>
          <p className="q" style={{ margin: '16px 0 0', fontSize: 18 }}>What did you do?</p>
          <div className="opts">
            {(['call', 'text', 'facetoface', 'popby', 'card'] as TouchKind[]).filter((k) => !kinds || kinds.includes(k)).map((k) => (
              <button key={k} className={`opt k-${k}`} disabled={busy} onClick={() => pick(k)}>{KIND_ICON[k]}{DID_LABEL[k]}</button>
            ))}
          </div>
          <p className="note" style={{ marginTop: 8 }}>This counts toward their 36 and resets when they come up next.</p>
        </div>
      )}
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

function LogSheet({ c, suggested, goal, onClose, onLog }: { c: Contact; suggested: TouchKind; goal: number; onClose: () => void; onLog: (k: TouchKind, note: string) => void }) {
  return (
    <Sheet label="Log a touch" onClose={onClose}>
      <h3>What did you already do for {c.first_name || fullName(c)}?</h3>
      <p className="note">This just records it. Anything you pick counts toward their {goal} touches this year.</p>
      <div className="opts">
        {([suggested, ...(['call', 'text', 'card', 'popby', 'facetoface'] as TouchKind[]).filter((x) => x !== suggested)]).map((k) => (
          <button key={k} className={`opt k-${k}`} onClick={() => onLog(k, '')}>
            {KIND_ICON[k]}{DID_LABEL[k] ?? KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

/** Right after a touch is logged (or from someone's history): add or change the note on it. */
function NoteSheet({ ctx, t, c, onClose, onUndo }: { ctx: Ctx; t: Touch; c: Contact; onClose: () => void; onUndo?: () => void }) {
  const toast = useToast()
  const [note, setNote] = useState(t.note ?? '')
  const [busy, setBusy] = useState(false)
  const editing = !!t.note
  async function save() {
    setBusy(true)
    try {
      await api.updateTouch(ctx.me, t.id, { note: note.trim() || null })
      await ctx.reload()
      toast(note.trim() ? 'Note saved.' : 'Note removed.')
      onClose()
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
      setBusy(false)
    }
  }
  return (
    <Sheet label="Add a note" onClose={onClose}>
      <h3>{editing ? 'Edit note' : `Any notes about ${c.first_name || fullName(c)}?`}</h3>
      <p className="note">
        {onUndo ? <>{KIND_LABEL[t.kind]} recorded. <button className="link" onClick={onUndo}>Undo</button></> : `${touchLabel(t)}, ${longDate(t.occurred_on)}`}
      </p>
      <textarea autoFocus aria-label="Note" placeholder="What did you talk about? Anything to remember next time?" value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn primary" style={{ flex: 1 }} disabled={busy || note.trim() === (t.note ?? '').trim()} onClick={save}>Save note</button>
        <button className="btn" style={{ flex: 1 }} onClick={onClose}>{editing ? 'Cancel' : 'Skip'}</button>
      </div>
    </Sheet>
  )
}

// ======================================================================
// One person: details at a glance, plus every touch logged
// ======================================================================
const longDate = (d: string) => parse(d).toLocaleDateString('en-US', hasYear(d) ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'long', day: 'numeric' })
const monthDay = (d: string) => parse(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

/** How it's going with one person: same status as the Progress page, when you last reached them, when they're due, and the mix. */
function PersonGauge({ ctx, c }: { ctx: Ctx; c: Contact }) {
  const mine = ctx.data.touches.filter((t) => t.contact_id === c.id && !t.is_group)
  const personal = useMemo(() => touchCounts(mine), [mine])
  const bars = signal(c, personal, ctx.agent.tier_days)
  const status = bars >= 3 ? ['on', 'On schedule'] : bars === 2 ? ['slip', 'Slipping'] : bars === 1 ? ['over', 'Overdue'] : ['none', 'Not reached yet']
  const last = mine.map((t) => t.occurred_on).sort().at(-1)
  const every = tierDays(ctx.agent, c.tier)
  const due = last ? addDays(parse(last), every) : null
  const ago = last ? daysBetween(parse(last), today()) : 0
  const since = ymd(addDays(today(), -365))
  const kinds: TouchKind[] = ['call', 'text', 'card', 'facetoface', 'popby']
  const year = mine.filter((t) => t.occurred_on >= since)
  // Toward the yearly goal, group sends count too (same as before).
  const all12 = ctx.data.touches.filter((t) => t.contact_id === c.id && t.occurred_on >= since).length
  const mix = kinds.map((k) => [k, year.filter((t) => t.kind === k).length] as const).filter(([, n]) => n > 0)
  return (
    <div className="pgauge">
      <div className="pg-top">
        <span className={`spill s-${status[0]}`}>{status[1]}</span>
        <Signal bars={bars} tone />
      </div>
      <p className="pg-line">
        {last ? <>Last touch <b>{ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`}</b> · {due && due < today() ? <>was due <b>{fmt(due)}</b></> : <>next due <b>{due ? fmt(due) : ''}</b></>}</> : <>No touch yet. They come up every {every} days.</>}
      </p>
      <div className="pg36">
        <span><b>{all12}</b> of {ctx.goal} touches in the last 12 months</span>
        <div className="m36"><i style={{ width: `${Math.min(100, (all12 / ctx.goal) * 100)}%` }} /></div>
      </div>
      {year.length > 0 && (
        <>
          <div className="mix" style={{ height: 10, marginTop: 10 }}>{mix.map(([k, n]) => <i key={k} className={`k-${k}`} style={{ flex: n }} />)}</div>
          <div className="legend" style={{ marginTop: 6, fontSize: 13 }}>
            {mix.map(([k, n]) => <span key={k}><i className={`k-${k}`} /> <b>{n}</b> {k === 'facetoface' ? 'face to face' : `${KIND_LABEL[k].toLowerCase()}${n === 1 ? '' : 's'}`}</span>)}
          </div>
        </>
      )}
    </div>
  )
}

/** Pick a day (and what it's about). That person shows up at the top of Today that day. */
function FollowUpSheet({ ctx, c, onClose }: { ctx: Ctx; c: Contact; onClose: () => void }) {
  const toast = useToast()
  const t = today()
  const opts: [string, Date][] = [['Tomorrow', addDays(t, 1)], ['In 3 days', addDays(t, 3)], ['Next week', addDays(t, 7)], ['In 2 weeks', addDays(t, 14)], ['In a month', addDays(t, 30)]]
  const [on, setOn] = useState(c.follow_up_on ?? ymd(addDays(t, 7)))
  const [note, setNote] = useState(c.follow_up_note ?? '')
  const [busy, setBusy] = useState(false)
  // A different example each time, so it's clear this can be anything.
  const [hint] = useState(() => ['Ask how the move went.', 'Follow up on their credit repair progress.', 'Check in on their preapproval status.'][Math.floor(Math.random() * 3)])
  async function save() {
    setBusy(true)
    try {
      await api.setFollowUp(c, on, note.trim() || null)
      await ctx.reload()
      toast(`${c.first_name || 'They'} will be at the top of Today on ${fmt(on)}.`)
      onClose()
    } catch (e) { toast((e as Error).message); setBusy(false) }
  }
  return (
    <Sheet label="Set a follow-up" onClose={onClose}>
      <h3>Follow up with {c.first_name || fullName(c)}</h3>
      <p className="note">They'll show up at the top of Today that day, marked as a follow-up, with your note.</p>
      <div className="chips" style={{ marginTop: 12 }}>
        {opts.map(([l, d]) => <button key={l} type="button" aria-pressed={on === ymd(d)} onClick={() => setOn(ymd(d))}>{l}</button>)}
      </div>
      <label className="field" style={{ marginTop: 12 }}><span>Or pick a day</span>
        <input type="date" value={on} min={ymd(t)} onChange={(e) => e.target.value && setOn(e.target.value)} />
      </label>
      <label className="field" style={{ marginTop: 12 }}><span>What's it about?</span>
        <textarea rows={3} placeholder={hint} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button className="btn gold lg block" style={{ marginTop: 14 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : `Follow up ${fmt(on)}`}</button>
      <button className="btn ghost block" style={{ marginTop: 6 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

/** The four ways to celebrate a birthday or anniversary on Today. */
const occPlans = (o: Occasion): [BirthdayPlan, string, string][] => {
  const day = o === 'birthday' ? 'birthday' : o === 'home' ? 'home anniversary' : 'anniversary'
  return [
    ['text', 'Text on the day', `They show up first on Today on their ${day}.`],
    ['card', 'Mail a card', 'A card prompt shows up 3 to 5 days early, so it lands in time.'],
    ['both', 'Card and a text', 'The card a few days early, then a text on the day.'],
    ['none', "Don't remind me", `Their ${day} stays off Today.`],
  ]
}
const PLAN_SHORT: Record<BirthdayPlan, string> = { text: 'Text on the day', card: 'Mail a card', both: 'Card and a text', none: 'Off' }

function PersonSheet({ ctx, c, onClose, onEdit }: { ctx: Ctx; c: Contact; onClose: () => void; onEdit: () => void }) {
  const live = ctx.data.contacts.find((x) => x.id === c.id) ?? c
  const toast = useToast()
  const [noteOn, setNoteOn] = useState<{ t: Touch; fresh?: boolean } | null>(null)
  const [info, setInfo] = useState<Touch | null>(null)
  const [fu, setFu] = useState(false)
  const [bdPick, setBdPick] = useState<Occasion | null>(null)
  // The phone keeps about a year. Older touches with this person load from the server when you open them.
  const [older, setOlder] = useState<{ touches: Touch[]; cards: Card[] }>({ touches: [], cards: [] })
  useEffect(() => {
    if (!navigator.onLine) return
    api.loadContactHistory(live.id).then(setOlder, () => {})
  }, [live.id])
  const recent = ctx.data.touches.filter((t) => t.contact_id === live.id)
  const ids = new Set(recent.map((t) => t.id))
  const history = [...recent, ...older.touches.filter((t) => !ids.has(t.id))]
    .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const allCards = [...ctx.data.cards, ...older.cards]
  const cardFor = (t: Touch) => t.kind === 'card' && t.note?.startsWith('Card a Day: ')
    ? allCards.find((k) => k.sent_on === t.occurred_on && k.recipient_name === t.note!.slice('Card a Day: '.length))
    : undefined
  const [carding, setCarding] = useState(false)
  const [reachP, setReachP] = useState<'call' | 'text' | null>(null)
  const topRef = useRef<HTMLDivElement>(null)
  async function quick(kind: TouchKind) {
    if (kind === 'card') { setCarding(true); return }
    try {
      const t = await api.logTouch(ctx.me, live.id, kind, '')
      await ctx.reload()
      setNoteOn({ t, fresh: true })
      if (!onTodaysList(ctx.agent.id, live.id)) toast(offListNote(live))
      // Back to the top so the new touch and their bars are right there.
      topRef.current?.closest('.in')?.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) { toast(`That didn't save: ${(e as Error).message}`) }
  }
  async function removeTouch(t: Touch) {
    try {
      await api.deleteTouch(t, [...ctx.data.touches, ...older.touches], [...ctx.data.cards, ...older.cards])
      setOlder((o) => ({ ...o, touches: o.touches.filter((x) => x.id !== t.id) }))
      await ctx.reload()
      toast(`${touchLabel(t)} on ${longDate(t.occurred_on)} removed.`)
    } catch (e) { toast(`Couldn't remove: ${(e as Error).message}`) }
  }
  async function undo(t: Touch) {
    setNoteOn(null)
    try { await api.deleteTouch(t, ctx.data.touches, ctx.data.cards); await ctx.reload(); toast('Undone.') } catch (e) { toast(`Couldn't undo: ${(e as Error).message}`) }
  }
  const where = live.address || live.city ? [live.address, [live.city, live.state].filter(Boolean).join(', '), live.zip].filter(Boolean).join(' ') : ''
  const dates: [string, string | null | undefined, Occasion][] = OCCASION_LIST.map((o) => [OCCASION_META[o].name, live[OCCASION_META[o].field], o])
  const shown = dates.filter(([, v]) => v)
  return (
    <Sheet label={fullName(live)} onClose={onClose}>
      <div ref={topRef} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 22 }}>{fullName(live)}</h3>
        <span className={`ttag ${live.tier === 'U' ? 'q' : ''}`} style={{ marginLeft: 0 }}>{live.tier === 'U' ? '?' : live.tier === 'A' ? 'A' : 'B'}</span>
      </div>
      {!ctx.readOnly && live.phone && (reachP ? (
        <div className="preach" role="status">
          <p>Did you {reachP} {live.first_name || fullName(live)}?</p>
          <div>
            <button className="btn gold" onClick={() => { const k = reachP; setReachP(null); quick(k) }}>Yes, record it</button>
            <button className="btn" onClick={() => setReachP(null)}>Not yet</button>
          </div>
        </div>
      ) : (
        <div className="pcall">
          <a className="go k-call" href={`tel:${telOf(live.phone)}`} onClick={() => setReachP('call')}><IPhone size={20} /> Call</a>
          <a className="go k-text" href={`sms:${telOf(live.phone)}`} onClick={() => setReachP('text')}><IText size={20} /> Text</a>
        </div>
      ))}
      {!ctx.readOnly && <div className="qlabel">{live.phone ? 'Already reached out? Record it:' : 'Record a touch:'}</div>}
      {!ctx.readOnly && (
        <div className="qlog" role="group" aria-label="Log a touch">
          {(['call', 'text', 'card', 'popby', 'facetoface'] as TouchKind[]).map((k) => (
            <button key={k} className={`k-${k}`} onClick={() => quick(k)}>{KIND_ICON[k]}<span>{k === 'facetoface' ? 'Face to face' : KIND_LABEL[k]}</span></button>
          ))}
        </div>
      )}
      <PersonGauge ctx={ctx} c={live} />
      {live.follow_up_on ? (
        <div className="furow">
          <span className="fubadge" style={{ margin: 0 }}><IBell size={14} /> Follow up {parse(live.follow_up_on) <= today() ? 'today' : fmt(live.follow_up_on)}</span>
          {live.follow_up_note && <p>{live.follow_up_note}</p>}
          {!ctx.readOnly && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => setFu(true)}>Change</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={async () => { try { await api.setFollowUp(live, null, null); await ctx.reload(); toast('Follow-up cleared.') } catch (e) { toast((e as Error).message) } }}>Clear</button>
            </div>
          )}
        </div>
      ) : !ctx.readOnly && (
        <button className="btn block fuset" onClick={() => setFu(true)}><IBell size={18} /> Set a follow-up</button>
      )}

      <div className="facts">
        {live.phone && (
          <div><span>Phone</span><b>{ctx.readOnly ? live.phone : <a href={`tel:${telOf(live.phone)}`}>{live.phone}</a>}</b></div>
        )}
        {live.email && <div><span>Email</span><b>{ctx.readOnly ? live.email : <a href={`mailto:${live.email}`}>{live.email}</a>}</b></div>}
        {where && <div><span>Address</span><b><a href={`https://maps.apple.com/?q=${encodeURIComponent(where)}`} target="_blank" rel="noreferrer">{where}</a></b></div>}
        {shown.map(([l, v, o]) => (
          <div key={l}><span>{l}</span>
            <b>{o === 'birthday' ? monthDay(v as string) : longDate(v as string)}
              {!ctx.readOnly && <button className={`bdplan occ-${o}`} onClick={() => setBdPick(o)}>{OCCASION_META[o].icon} {PLAN_SHORT[planOf(live, o)]} ›</button>}
            </b>
          </div>
        ))}
        {live.notes && <div><span>Notes</span><b style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{live.notes}</b></div>}
        {!live.phone && !live.email && !where && !shown.length && !live.notes && <p className="note">No contact details yet. Tap Edit details to add them.</p>}
      </div>

      <div className="grp" style={{ marginTop: 18 }}>History <span className="note" style={{ fontWeight: 400 }}>{history.length} {history.length === 1 ? 'touch' : 'touches'}</span></div>
      {history.length === 0 ? (
        <p className="note">Nothing logged yet. Your first touch will show up here.</p>
      ) : (
        <div className="hist">
          {history.map((t) => {
            const canNote = !ctx.readOnly && !t.is_group && !(t.kind === 'card' && t.note?.startsWith('Card a Day: '))
            const k = cardFor(t)
            const sub = k ? [k.occasion, k.note].filter(Boolean).join(' · ') : t.note && t.note !== 'Group touch' ? t.note : ''
            return (
<SwipeRow key={t.id} label={touchLabel(t)} onDelete={ctx.readOnly ? undefined : () => removeTouch(t)}>
                              <button className="hrow tap" onClick={() => (canNote ? setNoteOn({ t }) : setInfo(t))}>
                <span className={`hic k-${t.kind}`}>{KIND_ICON[t.kind] ?? <ICheck />}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{touchLabel(t)}</b>
                  {sub ? <small className="clip">{sub}</small> : canNote ? <small className="addnote">+ Add a note</small> : null}
                </span>
                <span className="note" style={{ whiteSpace: 'nowrap' }}>{longDate(t.occurred_on)}</span>
              </button>
              </SwipeRow>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {!ctx.readOnly && <button className="btn primary" style={{ flex: 1 }} onClick={onEdit}>Edit details</button>}
        <button className="btn" style={{ flex: 1 }} onClick={onClose}>Close</button>
      </div>
      {noteOn && <NoteSheet ctx={ctx} t={noteOn.t} c={live} onClose={() => setNoteOn(null)} onUndo={noteOn.fresh ? () => undo(noteOn.t) : undefined} />}
      {fu && <FollowUpSheet ctx={ctx} c={live} onClose={() => setFu(false)} />}
      {carding && <CardSheet ctx={ctx} c={live} onClose={() => setCarding(false)} />}
      {bdPick && (
        <Sheet label={OCCASION_META[bdPick].name} onClose={() => setBdPick(null)}>
          <h3>{live.first_name || fullName(live)}'s {OCCASION_META[bdPick].name.toLowerCase()}</h3>
          <p className="note">How should Rock Solid bring it up on Today?</p>
          <div className="gwiz-opts" style={{ marginTop: 10 }}>
            {occPlans(bdPick).map(([k, label, sub]) => (
              <button key={k} className={`gwiz-opt${planOf(live, bdPick) === k ? ' on' : ''}`}
                onClick={async () => { try { await api.setOccasionPlan(live, bdPick, k); await ctx.reload(); setBdPick(null) } catch (e) { toast((e as Error).message) } }}>
                <span className="gwiz-dot" /><span><b>{label}</b><small>{sub}</small></span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {info && (
        <Sheet label="Touch details" onClose={() => setInfo(null)}>
          <h3>{touchLabel(info)}</h3>
          <p className="note">{longDate(info.occurred_on)}</p>
          {(() => {
            const k = cardFor(info)
            if (k) return (
              <div className="facts" style={{ marginTop: 8 }}>
                <div><span>Card a Day</span><b>{k.occasion || 'Card'}{k.relationship ? ` · ${k.relationship}` : ''}</b></div>
                <div><span>Notes</span><b style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{k.note || 'No notes on this card.'}</b></div>
              </div>
            )
            return <p style={{ whiteSpace: 'pre-wrap' }}>{info.is_group ? 'Sent to a group, so there are no notes for just this person.' : info.note || 'No notes on this one.'}</p>
          })()}
          <button className="btn block" style={{ marginTop: 12 }} onClick={() => setInfo(null)}>Close</button>
        </Sheet>
      )}
    </Sheet>
  )
}

// ======================================================================
// Edit / add a person
// ======================================================================
// ----- Pull someone's info from the phone's contacts (Android Chrome; iPhone uses AutoFill Contact instead) -----
type PickedContact = { name?: string[]; tel?: string[]; email?: string[]; address?: { addressLine?: string[]; city?: string; region?: string; postalCode?: string }[] }
const canPickContact = () => typeof navigator !== 'undefined' && 'contacts' in navigator && typeof window !== 'undefined' && 'ContactsManager' in window
async function pickPhoneContact(): Promise<PickedContact | null> {
  try {
    const mgr = (navigator as unknown as { contacts: { select: (p: string[], o: { multiple: boolean }) => Promise<PickedContact[]>; getProperties?: () => Promise<string[]> } }).contacts
    const have = (await mgr.getProperties?.()) ?? ['name', 'tel', 'email']
    const want = ['name', 'tel', 'email', 'address'].filter((p) => have.includes(p))
    const [p] = await mgr.select(want, { multiple: false })
    return p ?? null
  } catch {
    return null
  }
}
function mergePicked<T extends { first_name: string; last_name: string; phone: string; email: string; address: string; city: string; state: string; zip: string }>(f: T, p: PickedContact): T {
  const [first, ...rest] = (p.name?.[0] ?? '').trim().split(/\s+/)
  const a = p.address?.[0]
  // Only fill what's still empty, so nothing already typed gets replaced.
  const keep = (cur: string, v?: string) => cur.trim() || (v ?? '').trim()
  return {
    ...f,
    first_name: keep(f.first_name, first), last_name: keep(f.last_name, rest.join(' ')),
    phone: keep(f.phone, p.tel?.[0] ? formatPhone(p.tel[0]) ?? p.tel[0] : ''), email: keep(f.email, p.email?.[0]),
    address: keep(f.address, a?.addressLine?.join(' ')), city: keep(f.city, a?.city),
    state: a?.region && (!f.state.trim() || f.state === 'TX') ? a.region : f.state, zip: keep(f.zip, a?.postalCode),
  }
}

function EditSheet({ ctx, c, onClose, prefill, onSaved, saveLabel }: {
  ctx: Ctx; c: Contact | null; onClose: () => void
  /** For a new person: name and phone typed elsewhere. */ prefill?: { name?: string; phone?: string }
  /** Called with the saved person instead of closing (used by Record a touch). */ onSaved?: (c: Contact) => void
  saveLabel?: string
}) {
  const pre = (prefill?.name ?? '').trim().split(/\s+/)
  const toast = useToast()
  const [f, setF] = useState({
    first_name: c?.first_name ?? pre[0] ?? '', last_name: c?.last_name ?? pre.slice(1).join(' '), phone: c?.phone ?? prefill?.phone ?? '', email: c?.email ?? '',
    address: c?.address ?? '', city: c?.city ?? '', state: c?.state ?? 'TX', zip: c?.zip ?? '',
    tier: (c?.tier === 'C' || c?.tier === 'D' ? 'B' : c?.tier ?? 'U') as Tier, birthday: c?.birthday ?? '', home_anniversary: c?.home_anniversary ?? '', wedding_anniversary: c?.wedding_anniversary ?? '', notes: c?.notes ?? '',
  })
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [plans, setPlans] = useState<Record<Occasion, BirthdayPlan>>(() => ({ birthday: c ? planOf(c, 'birthday') : 'text', home: c ? planOf(c, 'home') : 'text', wedding: c ? planOf(c, 'wedding') : 'text' }))
  // New people: let the phone offer to fill in from its contacts (iPhone AutoFill Contact). Existing people: no autofill.
  const ac = (v: string) => (c ? 'off' : v)
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
      // Only send the wedding date when there is one (or there was one), so saving works before that column exists.
      if (f.wedding_anniversary || c?.wedding_anniversary) input.wedding_anniversary = f.wedding_anniversary || null
      else delete input.wedding_anniversary
      const id = await api.saveContact(ctx.me, input, c?.id)
      // Birthday and anniversary choices save on their own, so the rest saves even before that SQL is run.
      for (const o of OCCASION_LIST) {
        const was = c ? planOf(c, o) : 'text'
        if (plans[o] !== was) await api.setOccasionPlan({ ...(c ?? {}), id } as Contact, o, plans[o]).catch((e) => toast((e as Error).message))
      }
      await ctx.reload()
      if (onSaved) {
        onSaved({ ...(c ?? {}), ...input, id, agent_id: ctx.me.id } as Contact)
        return
      }
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
      await api.deleteContact(ctx.me, c.id)
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
        {!c && !ro && canPickContact() && (
          <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={async () => { const p = await pickPhoneContact(); if (p) { setF((cur) => mergePicked(cur, p)) } }}>
            <IPeople size={18} /> Fill in from my phone's contacts
          </button>
        )}
        <div className="ed">
          <label className="field"><span>First name</span><input required disabled={ro} value={f.first_name} onChange={set('first_name')} autoComplete={ac('given-name')} /></label>
          <label className="field"><span>Last name</span><input disabled={ro} value={f.last_name} onChange={set('last_name')} autoComplete={ac('family-name')} /></label>
          <label className="field full"><span>Phone</span><input inputMode="tel" disabled={ro} value={f.phone} onChange={set('phone')} autoComplete={ac('tel')} /></label>
        </div>
        <div className="field">
          <span>How close are you? {f.tier === 'U' ? `Not tagged yet. Pick A or B. Until then they come up every ${tierDays(ctx.agent, 'U')} days.` : `${TIER_NAMES[f.tier]}: every ${tierDays(ctx.agent, f.tier)} days.`}</span>
          <div className="tiersel" role="group" aria-label="Tier">
            {TIERS.map((t) => (
              <button type="button" key={t} disabled={ro} aria-pressed={f.tier === t} onClick={() => setF({ ...f, tier: t })}>{t}</button>
            ))}
          </div>
        </div>
        <label className="field"><span>Notes</span><textarea disabled={ro} value={f.notes} onChange={set('notes')} placeholder="Kids, pets, what they care about" /></label>
        <div className="grp" style={{ marginTop: 6 }}>Email, address and special dates</div>
        <div className="ed">
          <label className="field full"><span>Email</span><input type="email" disabled={ro} value={f.email} onChange={set('email')} autoComplete={ac('email')} /></label>
          <label className="field full"><span>Address</span><input disabled={ro} value={f.address} onChange={set('address')} autoComplete={ac('street-address')} /></label>
          <label className="field full"><span>City</span><input disabled={ro} value={f.city} onChange={set('city')} autoComplete={ac('address-level2')} /></label>
          <label className="field"><span>State</span><input disabled={ro} value={f.state} onChange={set('state')} autoCapitalize="characters" maxLength={20} autoComplete={ac('address-level1')} /></label>
          <label className="field"><span>Zip</span><input disabled={ro} inputMode="numeric" value={f.zip} onChange={set('zip')} autoComplete={ac('postal-code')} /></label>
          {OCCASION_LIST.map((o) => {
            const m = OCCASION_META[o]
            const v = f[m.field]
            return (
              <div key={o} className="field full occfield">
                {o === 'home'
                  ? <DateField label={m.name} ro={ro} value={v} onChange={(d) => setF({ ...f, [m.field]: d })} />
                  : <MonthDayField label={m.name} ro={ro} value={v} onChange={(d) => setF({ ...f, [m.field]: d })} />}
                {v && !ro && (
                  <div className="occplan">
                    <span>{m.icon} How should it show up on Today?</span>
                    <div className="seg4" role="group" aria-label={`How to bring up their ${m.name.toLowerCase()}`}>
                      {(['text', 'card', 'both', 'none'] as BirthdayPlan[]).map((k) => (
                        <button type="button" key={k} aria-pressed={plans[o] === k} onClick={() => setPlans({ ...plans, [o]: k })}>
                          {k === 'text' ? 'Text' : k === 'card' ? 'Card' : k === 'both' ? 'Both' : 'Off'}
                        </button>
                      ))}
                    </div>
                    <small>{plans[o] === 'text' ? 'A text on the day.' : plans[o] === 'card' ? 'A card prompt 3 to 5 days early.' : plans[o] === 'both' ? 'A card a few days early, then a text on the day.' : 'Stays off Today.'}</small>
                  </div>
                )}
              </div>
            )
          })}
        </div>
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
            <button className="btn primary lg block" disabled={busy}>{busy ? 'Saving…' : saveLabel ?? (c ? 'Save' : 'Add person')}</button>
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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** Month and day, with the year optional (birthdays and wedding anniversaries). No year saves as 1904-MM-DD. */
function MonthDayField({ label, value, onChange, ro }: { label: string; value: string; onChange: (v: string) => void; ro: boolean }) {
  const [y0, m0, d0] = value ? value.split('-') : ['', '', '']
  const [year, setYear] = useState(value && hasYear(value) ? y0 : '')
  const [mon, setMon] = useState(value ? String(Number(m0)) : '')
  const [day, setDay] = useState(value ? String(Number(d0)) : '')
  const max = mon ? new Date(2004, Number(mon), 0).getDate() : 31
  const emit = (mo: string, da: string, yr: string) => {
    if (!mo || !da) { onChange(''); return }
    const y = /^\d{4}$/.test(yr) ? yr : NO_YEAR
    const dd = Math.min(Number(da), new Date(Number(y), Number(mo), 0).getDate())
    onChange(`${y}-${mo.padStart(2, '0')}-${String(dd).padStart(2, '0')}`)
  }
  return (
    <div className="field full"><span>{label}</span>
      <div className="mdrow">
        <select aria-label={`${label} month`} disabled={ro} value={mon} onChange={(e) => { setMon(e.target.value); emit(e.target.value, day, year) }}>
          <option value="">Month</option>
          {MONTHS.map((n, i) => <option key={n} value={String(i + 1)}>{n}</option>)}
        </select>
        <select aria-label={`${label} day`} disabled={ro} value={day} onChange={(e) => { setDay(e.target.value); emit(mon, e.target.value, year) }}>
          <option value="">Day</option>
          {Array.from({ length: max }, (_, i) => <option key={i} value={String(i + 1)}>{i + 1}</option>)}
        </select>
        <input aria-label={`${label} year (optional)`} disabled={ro} inputMode="numeric" placeholder="Year" maxLength={4} value={year}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); setYear(v); if (v.length === 4 || v === '') emit(mon, day, v) }} />
        {value && !ro && <button type="button" className="btn" onClick={() => { setMon(''); setDay(''); setYear(''); onChange('') }}>Clear</button>}
      </div>
      <small className="note">Year is optional.</small>
    </div>
  )
}

function DateField({ label, value, onChange, ro }: { label: string; value: string; onChange: (v: string) => void; ro: boolean }) {
  const [asking, setAsking] = useState(false)
  return (
    // Not a <label>: tapping Clear inside a label would open the date picker instead of clearing.
    <div className="field full"><span>{label}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="date" aria-label={label} disabled={ro} value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        {value && !ro && !asking && <button type="button" className="btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAsking(true) }}>Clear</button>}
      </div>
      {asking && (
        <div className="warn" style={{ marginTop: 6 }}>
          Remove this {label.toLowerCase()}?
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" onClick={() => { onChange(''); setAsking(false) }}>Yes, remove it</button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>Keep it</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ======================================================================
// Card a Day: one question at a time, like the Shortcut
// ======================================================================
const RELS = ['Friend', 'Family', 'Client', 'Agent/Colleague', 'Vendor', 'Other']
const OCCASIONS = ['Thank You', 'Birthday', 'Anniversary', 'Just Because', 'Congratulations', 'Encouragement', 'Follow-Up', 'Other']

function CardSteps({ ctx, preset, occasion, onBefore, onLogged }: { ctx: Ctx; preset?: string; occasion?: string; onBefore?: () => void; onLogged?: (r: { counts: boolean; firstToday: boolean }) => void }) {
  const { data, agent } = ctx
  const toast = useToast()
  const start = preset ? 1 : 0
  const [step, setStep] = useState(start)
  const [name, setName] = useState(preset ?? '')
  const [rel, setRel] = useState('')
  const [occ, setOcc] = useState(occasion ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const dup = name.trim() ? cardWithin12Months(data.cards, name) : undefined
  const q = name.trim().toLowerCase()
  const known = data.contacts.some((c) => fullName(c).toLowerCase() === q)
  const matches = q ? data.contacts.filter((c) => fullName(c).toLowerCase().includes(q) && fullName(c).toLowerCase() !== q).slice(0, 5) : []
  const who = name.trim().split(' ')[0] || 'them'
  const total = 4 - start
  // Last card to someone, so you can check before you write.
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim()
  const lastCard = (n: string) => data.cards.filter((c) => norm(c.recipient_name) === norm(n)).sort((a, b) => b.sent_on.localeCompare(a.sent_on))[0]
  const prior = q ? lastCard(name) : undefined
  // Check anyone typed with a first and last name, in your people or not.
  const fullTyped = name.trim().split(/\s+/).length >= 2
  const check = known || prior || fullTyped ? (
    prior ? (
      <div className={dup && agent.card_rule ? 'warn' : 'okcheck'} style={{ marginTop: 10 }}>
        Last card to {who}: <b>{fmt(prior.sent_on)}</b>{prior.occasion ? ` (${prior.occasion})` : ''}.
        {dup && agent.card_rule ? ` A new one counts as a touch, and toward Card a Day again after ${fmt(addDays(parse(dup.sent_on), 365))}.` : ''}
      </div>
    ) : (
      <div className="okcheck" style={{ marginTop: 10 }}><ICheck size={16} /><span style={{ flex: 1 }}>No card to {who} in the last year. Good to go.</span></div>
    )
  ) : null

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
            <div className="sugs">{matches.map((c) => {
              const lc = lastCard(fullName(c))
              return <button type="button" key={c.id} onClick={() => setName(fullName(c))}>{fullName(c)}<span className="note" style={{ marginLeft: 8 }}>{lc ? `card ${fmt(lc.sent_on)}` : 'no card yet'}</span></button>
            })}</div>
          )}
          {check}
          {q && !known && (
            <>
              <p className="note" style={{ marginTop: 10 }}>Not in your people? No problem. Tap Next and the card logs by name.</p>
              <button type="button" className="btn" style={{ marginTop: 6 }} onClick={() => setAdding(true)}><IPlus size={18} /> Or add "{name.trim()}" to my people</button>
            </>
          )}
          <button className="btn primary lg block" style={{ marginTop: 14 }} disabled={!name.trim()}>Next</button>
        </form>
      )}
      {step === 1 && (
        <>
          {start === 1 && check}
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
      {adding && (
        <EditSheet ctx={ctx} c={null} prefill={{ name }} saveLabel="Save and continue" onClose={() => setAdding(false)}
          onSaved={(c) => { setAdding(false); setName(fullName(c)); setStep(1); toast(`${c.first_name} added to your people.`) }} />
      )}
    </div>
  )
}

/** Card a Day at a glance for the Challenges tab. */
function cadInfo(cards: Card[]): CadInfo {
  const cov = cardCoverage(cards)
  const tk = ymd(today())
  let streak = 0
  for (let d = today(); ; d = addDays(d, -1)) {
    if (cov.has(ymd(d))) streak++
    else if (ymd(d) === tk) continue
    else break
  }
  const sun = addDays(today(), -today().getDay())
  const week = Array.from({ length: 7 }, (_, i) => {
    const k = ymd(addDays(sun, i))
    return cov.written.has(k) ? 'on' : cov.covered.has(k) ? 'cov' : ''
  }) as CadInfo['week']
  return {
    streak, week, todayIdx: today().getDay(),
    banked: [...cov.covered.keys()].filter((k) => k > tk).length,
    done: cov.has(tk), covered: !cov.written.has(tk) && cov.covered.has(tk),
  }
}

/** Logging a card for someone always goes through Card a Day, so it counts there too. */
function CardSheet({ ctx, c, occasion, onBefore, onClose }: { ctx: Ctx; c: Contact; occasion?: string; onBefore?: () => void; onClose: () => void }) {
  const toast = useToast()
  const logged = (r: { counts: boolean }) => {
    if (r.counts && !ctx.readOnly && !onTodaysList(ctx.agent.id, c.id)) toast(`Card logged for ${c.first_name || fullName(c)}! Reach someone on today's list to stack your rocks.`)
    onClose()
  }
  return (
    <Sheet label={`Card for ${c.first_name || fullName(c)}`} onClose={onClose}>
      <CardSteps ctx={ctx} preset={fullName(c)} occasion={occasion} onBefore={onBefore} onLogged={logged} />
    </Sheet>
  )
}

/** Log a touch from inside a challenge: the same person picker as Record a touch, showing only what counts. */
function ChallengeLog({ ctx, kinds, onClose }: { ctx: Ctx; kinds: string[]; onClose: () => void }) {
  const toast = useToast()
  const [card, setCard] = useState<Contact | null>(null)
  async function log(c: Contact, kind: TouchKind) {
    if (kind === 'card') { setCard(c); return }
    onClose()
    try {
      const t = await api.logTouch(ctx.me, c.id, kind, '')
      await ctx.reload()
      toast(`${KIND_LABEL[kind]} recorded for ${c.first_name}.`, {
        label: 'Undo',
        run: async () => { try { await api.deleteTouch(t, ctx.data.touches, ctx.data.cards); await ctx.reload(); toast('Undone.') } catch (e) { toast(`Couldn't undo: ${(e as Error).message}`) } },
      })
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
    }
  }
  if (card) return <CardSheet ctx={ctx} c={card} onClose={onClose} />
  return <RecordSheet ctx={ctx} kinds={kinds as TouchKind[]} onClose={onClose} onLog={(c, k) => log(c, k)} />
}

function CardADay({ ctx, onProfileChange, onBack, extra }: { ctx: Ctx; onProfileChange?: () => void; onBack?: () => void; extra?: ReactNode }) {
  const { data, agent, readOnly } = ctx
  const swipeRef = useSwipeBack(onBack)
  const [cele, setCele] = useState(false)
  const counting = data.cards.filter((c) => c.counts_for_challenge)
  const cov = cardCoverage(data.cards)
  const tk = ymd(today())
  const doneToday = cov.has(tk)
  const coveredToday = !cov.written.has(tk) && cov.covered.has(tk)
  let streak = 0
  for (let d = today(); ; d = addDays(d, -1)) {
    if (cov.has(ymd(d))) streak++
    else if (ymd(d) === tk) continue
    else break
  }
  const ms = ymd(monthStart())
  let monthDays = 0
  for (let d = monthStart(); ymd(d) <= tk; d = addDays(d, 1)) if (cov.has(ymd(d))) monthDays++
  const bankedAhead = [...cov.covered.keys()].filter((k) => k > tk).length
  const [dayOpen, setDayOpen] = useState<string | null>(null)
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
  const pad = first.getDay() // Sunday first
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return (
    <section ref={swipeRef as RefObject<HTMLElement>}>
      {onBack ? (
        <div className="roomhdr">
          <button className="iconbtn" aria-label="Back to challenges" onClick={onBack}><IChevL /></button>
          <h2 style={{ margin: 0, fontSize: 21, flex: 1 }}>Card a Day</h2>
        </div>
      ) : <h2 style={{ marginTop: 14 }}>Card a Day Challenge</h2>}
      <div className="streak" style={{ margin: '10px 0 4px' }}>
        <b>{streak}</b><span>day streak</span>
      </div>
      <p className="muted" style={{ marginBottom: 18 }}>{coveredToday ? 'Today is covered by an extra card you already wrote. Nice planning.' : doneToday ? "Today's card is done. Nice work." : 'One handwritten card today keeps it going.'}{bankedAhead > 0 ? ` You're ${bankedAhead} ${bankedAhead === 1 ? 'day' : 'days'} ahead.` : ''}</p>

      {!readOnly && (
        <div className="card">
          <CardSteps ctx={ctx} onLogged={logged} />
        </div>
      )}

      <div className="grp">{today().toLocaleDateString('en-US', { month: 'long' })}: {monthDays} of {today().getDate()} days</div>
      <div className="card">
        <div className="cal">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x, i) => <div key={i} className="h">{x}</div>)}
          {Array.from({ length: pad }, (_, i) => <div key={`p${i}`} />)}
          {Array.from({ length: dim }, (_, i) => {
            const d = new Date(first.getFullYear(), first.getMonth(), i + 1, 12)
            const k = ymd(d)
            const who = counting.filter((c) => c.sent_on === k).map((c) => c.recipient_name).join(', ')
            const from = cov.covered.get(k)
            const cls = cov.written.has(k) ? 'on' : from ? 'cov' : ''
            const tip = who || (from ? `Covered by an extra card written ${fmt(from)}` : '')
            return <button key={k} type="button" title={tip} aria-label={`${fmt(d)}${tip ? `: ${tip}` : ''}`} onClick={() => setDayOpen(k)} className={`d ${cls} ${k === tk ? 'today' : ''} ${d > today() && !from ? 'fut' : ''}`}>{i + 1}</button>
          })}
        </div>
        <div className="callegend" aria-hidden>
          <span><i className="on" /> Written that day</span>
          <span><i className="cov" /> Covered by an extra card</span>
        </div>
        <p className="note" style={{ marginTop: 8, textAlign: 'center' }}>{yearCount} cards so far this year. Write extras on a busy day and they fill in the days around it.</p>
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
      {extra}
      {dayOpen && <CardDaySheet day={dayOpen} cov={cov} onClose={() => setDayOpen(null)} />}
      {cele && <Celebrate eyebrow="Card a Day" title="Card a Day: done!" sub="Today's card is written and logged." onClose={() => setCele(false)} />}
    </section>
  )
}

/** What happened on one day of the Card a Day calendar. */
function CardDaySheet({ day, cov, onClose }: { day: string; cov: ReturnType<typeof cardCoverage>; onClose: () => void }) {
  const written = cov.byDay.get(day) ?? []
  // The first card written that day counts for the day itself; any others covered nearby days.
  const extras = written.slice(1)
  const covering = cov.coveredBy.get(day)
  const nice = parse(day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const extraHome = (c: Card) => [...cov.coveredBy.entries()].find(([, x]) => x.id === c.id)?.[0]
  const CardRow = ({ c, sub }: { c: Card; sub?: string }) => (
    <div className="hrow" style={{ alignItems: 'flex-start' }}>
      <span className="hic k-card"><ICard /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{c.recipient_name}</b>
        <small>{[c.occasion, c.relationship].filter(Boolean).join(' · ')}</small>
        {c.note && <small style={{ color: 'var(--ink)', marginTop: 2 }}>{c.note}</small>}
        {sub && <small style={{ marginTop: 2 }}>{sub}</small>}
      </span>
    </div>
  )
  return (
    <Sheet label={`Cards for ${nice}`} onClose={onClose}>
      <h3>{nice}</h3>
      {written.length > 0 ? (
        <>
          <p className="note" style={{ marginBottom: 6 }}>{written.length === 1 ? '1 card written this day' : `${written.length} cards written this day`}</p>
          <div className="hist">
            {written.map((c) => {
              const home = extras.includes(c) ? extraHome(c) : undefined
              return <CardRow key={c.id} c={c} sub={home ? `Extra card, covers ${fmt(home)}` : undefined} />
            })}
          </div>
        </>
      ) : covering ? (
        <>
          <p className="note" style={{ marginBottom: 6 }}>Covered by an extra card written {fmt(covering.sent_on)}</p>
          <div className="hist"><CardRow c={covering} /></div>
        </>
      ) : (
        <p className="note" style={{ marginTop: 8 }}>No card this day.</p>
      )}
      <button className="btn block" style={{ marginTop: 14 }} onClick={onClose}>Close</button>
    </Sheet>
  )
}

// ======================================================================
// Progress
// ======================================================================
/** Emails only reach people with an email; mailed newsletters only reach people with an address. */
function reachable(c: Contact, kind?: TouchKind) {
  if (kind === 'email') return !!c.email?.trim()
  if (kind === 'newsletter') return !!c.address?.trim()
  return true
}

/** Monthly lead-gen extras. "reach" ones can also credit a touch to people in the database. */
const EXTRAS: { k: string; l: string; reach?: TouchKind; week?: boolean }[] = [
  { k: 'social', l: 'Social post', week: true },
  { k: 'video', l: 'Video', week: true },
  { k: 'openhouse', l: 'Open house', week: true },
  { k: 'giveaway', l: 'Monthly giveaway' },
  { k: 'email', l: 'Email newsletter', reach: 'email' },
  { k: 'newsletter', l: 'Mailed newsletter', reach: 'newsletter' },
  { k: 'event', l: 'Client event' },
]

function Extras({ ctx }: { ctx: Ctx }) {
  const { data, readOnly } = ctx
  const toast = useToast()
  const [open, setOpen] = useState<(typeof EXTRAS)[number] | null>(null)
  const ms = ymd(monthStart())
  const ws = ymd(weekStart())
  const isWeek = (k: string) => !!EXTRAS.find((x) => x.k === k)?.week
  const val = (k: string) => (isWeek(k) ? data.tallies.find((x) => x.kind === api.weekKind(k) && x.month === ws) : data.tallies.find((x) => x.kind === k && x.month === ms))?.count ?? 0
  async function bump(k: string, l: string, d: 1 | -1) {
    const before = val(k)
    if (before + d < 0) return
    const set = (n: number) => (isWeek(k) ? api.setWeekly(ctx.me, ctx.data.tallies, k, n) : api.setTally(ctx.me, k, n))
    try {
      await set(before + d)
      await ctx.reload()
      toast(d > 0 ? `${l} added.` : `Took one ${l.toLowerCase()} off.`, { label: 'Undo', run: async () => { await set(before); await ctx.reload() } })
    } catch (e) {
      toast(`That didn't save: ${(e as Error).message}`)
    }
  }
  const [span, setSpan] = useState<'week' | 'month'>('week')
  return (
    <>
      <div className="xcard">
        <div className="seg" role="group" aria-label="This week or this month" style={{ margin: 0 }}>
          <button aria-pressed={span === 'week'} onClick={() => setSpan('week')}>This week</button>
          <button aria-pressed={span === 'month'} onClick={() => setSpan('month')}>This month</button>
        </div>
        <div className="xlist">
          {EXTRAS.filter((x) => (span === 'week') === !!x.week).map((x) => {
            const n = val(x.k)
            return (
              <div key={x.k} className="xrow">
                <button className="xname" disabled={readOnly} onClick={() => setOpen(x)} aria-label={`${x.l}: ${n}. Tap to change.`}>{x.l}</button>
                {!readOnly && n > 0 && <button className="xplus xminus" aria-label={`Take one ${x.l} off`} onClick={() => (x.reach ? setOpen(x) : bump(x.k, x.l, -1))}>−</button>}
                <b className={n ? 'did' : ''}>{n}</b>
                {!readOnly && <button className="xplus" aria-label={`Add ${x.l}`} onClick={() => (x.reach ? setOpen(x) : bump(x.k, x.l, 1))}><IPlus size={18} /></button>}
              </div>
            )
          })}
        </div>
        <p className="note" style={{ textAlign: 'center', fontSize: 13 }}>Each one is a drawing entry</p>
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
  const picked = ctx.data.contacts.filter((c) => tiers.includes(c.tier))
  const who = picked.filter((c) => reachable(c, x.reach))
  const skipped = picked.length - who.length
  const all = [...TIERS, 'U' as Tier].every((t) => tiers.includes(t))
  // This month's sends of this kind, so a mistaken one can be undone.
  const ms = ymd(monthStart())
  const sends = x.reach ? [...ctx.data.touches.filter((t) => t.is_group && t.kind === x.reach && t.occurred_on >= ms)
    .reduce((m, t) => { const k = `${t.occurred_on}|${t.note ?? ''}`; m.set(k, { day: t.occurred_on, note: t.note, n: (m.get(k)?.n ?? 0) + 1 }); return m }, new Map<string, { day: string; note: string | null; n: number }>())
    .values()].sort((a, b) => b.day.localeCompare(a.day)) : []
  const [undoing, setUndoing] = useState<{ day: string; note: string | null; n: number } | null>(null)
  async function run(fn: () => Promise<void>, msg: string) {
    setBusy(true)
    try { await fn(); await ctx.reload(); toast(msg); onClose() } catch (e) { toast(`That didn't save: ${(e as Error).message}`); setBusy(false) }
  }
  return (
    <Sheet label={x.l} onClose={onClose}>
      <h3>{x.l}</h3>
      <p className="note">{current} so far this {x.week ? 'week' : 'month'}.</p>
      {x.reach && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="field"><span>Who got it? Each person gets credit toward their {ctx.goal}.</span>
            <div className="chips">
              <button aria-pressed={all} onClick={() => setTiers(all ? [] : ['A', 'B', 'C', 'D', 'U'])}>Everyone</button>
              {[...TIERS, 'U' as Tier].map((t) => (
                <button key={t} aria-pressed={!all && tiers.includes(t)} onClick={() => setTiers(all ? withLegacy([t]) : tiers.includes(t) ? tiers.filter((y) => y !== t && !(LEGACY[t] ?? []).includes(y)) : withLegacy([...tiers, t]))}>{t === 'U' ? 'Not tagged' : `${t}s`}</button>
              ))}
            </div>
          </div>
          <button className="btn gold lg block" disabled={busy || !who.length} onClick={() => run(async () => { await api.groupTouch(ctx.me, who, x.reach as TouchKind, x.l); await api.setTally(ctx.me, x.k, current + 1) }, `${x.l} logged for ${who.length} people.`)}>
            {who.length ? `Log it for ${who.length} people` : picked.length ? `No one picked has ${x.reach === 'email' ? 'an email' : 'an address'}` : 'Pick who got it'}
          </button>
          {skipped > 0 && <p className="note" style={{ margin: 0 }}>Only people with {x.reach === 'email' ? 'an email' : 'a mailing address'} get credit. {skipped} without one {skipped === 1 ? 'is' : 'are'} skipped.</p>}
        </div>
      )}
      {sends.length > 0 && (
        <div className="field" style={{ marginTop: 20 }}>
          <span>Sent this month. Logged one by mistake? Undo it.</span>
          {sends.map((s) => (
            <div key={`${s.day}${s.note}`} className="sendrow">
              <span style={{ flex: 1 }}><b>{fmt(s.day)}</b> <span className="note">· {s.n} {s.n === 1 ? 'person' : 'people'}</span></span>
              <button className="btn" disabled={busy} onClick={() => setUndoing(s)}>Undo</button>
            </div>
          ))}
          {undoing && (
            <div className="warn" style={{ marginTop: 8 }}>
              Undo the {fmt(undoing.day)} {x.l.toLowerCase()}? {undoing.n} {undoing.n === 1 ? 'person loses' : 'people lose'} that credit, and this month's count goes down by one.
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn" disabled={busy} onClick={() => run(async () => { await api.undoGroupSend(ctx.me, x.reach as TouchKind, undoing.day, undoing.note); await api.setTally(ctx.me, x.k, Math.max(0, current - 1)) }, `${x.l} from ${fmt(undoing.day)} undone.`)}>Yes, undo it</button>
                <button className="btn ghost" onClick={() => setUndoing(null)}>Keep it</button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="field" style={{ marginTop: 20 }}>
        <span>{x.reach ? 'Or just set the count for this month' : `How many this ${x.week ? 'week' : 'month'}?`}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <NumInput label={`${x.l} this month`} value={total} onChange={setTotal} style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || total === current} onClick={() => run(() => (x.week ? api.setWeekly(ctx.me, ctx.data.tallies, x.k, total) : api.setTally(ctx.me, x.k, total)), 'Saved.')}>Save</button>
        </div>
      </div>
      <button className="btn ghost block" style={{ marginTop: 10 }} onClick={onClose}>Cancel</button>
    </Sheet>
  )
}

function Progress({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly } = ctx
  const ms = ymd(monthStart())
  const g = goalState(ctx)
  const m = momentum(ctx)

  // This week: the one number to beat.
  const wk = Math.min(1, g.week / Math.max(1, agent.weekly_goal))
  const R = 42
  const C = 2 * Math.PI * R

  // Your people: how many there are vs. the plan, and how well they're being kept up with.
  const personal = useMemo(() => touchCounts(data.touches.filter((t) => !t.is_group)), [data.touches])
  const plan = planNumbers(agent.plan)
  const have = data.contacts.length
  const buckets = { on: 0, slip: 0, over: 0, none: 0 }
  for (const c of data.contacts) {
    const s = signal(c, personal, agent.tier_days)
    if (s >= 3) buckets.on++
    else if (s === 2) buckets.slip++
    else if (s === 1) buckets.over++
    else buckets.none++
  }
  const pct = (n: number) => (have ? `${(n / have) * 100}%` : '0%')

  // This month: every one-on-one touch, by kind, plus the extras.
  const month = data.touches.filter((t) => !t.is_group && t.occurred_on >= ms)
  const kinds: TouchKind[] = ['call', 'text', 'card', 'facetoface', 'popby']
  const byKind = kinds.map((k) => [k, month.filter((t) => t.kind === k).length] as const)
  const extras = EXTRAS.map((x) => [x.l, data.tallies.find((t) => t.kind === x.k && t.month === ms)?.count ?? 0] as const)
  const entries = month.length + extras.reduce((s, [, n]) => s + n, 0)

  return (
    <section>
      <h2 style={{ marginTop: 14 }}>Progress</h2>

      <div className="card pweek">
        <svg viewBox="0 0 100 100" className="pring" aria-hidden>
          <circle cx="50" cy="50" r={R} className="pr-track" />
          <circle cx="50" cy="50" r={R} className="pr-fill" style={{ strokeDasharray: `${C * Math.max(0.02, wk)} ${C}` }} />
        </svg>
        <div className="pw-text">
          <span className="eyebrow">This week</span>
          <b className="big">{g.week} <span>of {agent.weekly_goal}</span></b>
          <span className="pw-sub">{g.today} of {agent.daily_goal} today{m.streak >= 2 ? <> · <IFlame size={14} /> {m.streak}-day streak</> : ''}</span>
        </div>
      </div>

      <div className="card psec">
        <div className="psec-h"><span className="eyebrow">Your people</span><b>{have}{plan.dbNeeded > have ? <span className="note"> of {plan.dbNeeded} for your plan</span> : ''}</b></div>
        {plan.dbNeeded > have && <div className="pbar"><i style={{ width: `${Math.min(100, (have / plan.dbNeeded) * 100)}%` }} /></div>}
        <div className="health" role="img" aria-label={`${buckets.on} on schedule, ${buckets.slip} slipping, ${buckets.over} overdue, ${buckets.none} not reached yet`}>
          <i className="h-on" style={{ width: pct(buckets.on) }} />
          <i className="h-slip" style={{ width: pct(buckets.slip) }} />
          <i className="h-over" style={{ width: pct(buckets.over) }} />
          <i className="h-none" style={{ width: pct(buckets.none) }} />
        </div>
        <div className="legend">
          <span><i className="h-on" /> <b>{buckets.on}</b> on schedule</span>
          <span><i className="h-slip" /> <b>{buckets.slip}</b> slipping</span>
          <span><i className="h-over" /> <b>{buckets.over}</b> overdue</span>
          <span><i className="h-none" /> <b>{buckets.none}</b> not reached yet</span>
        </div>
      </div>

      <div className="card psec">
        <div className="psec-h"><span className="eyebrow">{today().toLocaleDateString('en-US', { month: 'long' })}</span><b>{month.length} <span className="note">one-on-one touches</span></b></div>
        <div className="mix" role="img" aria-label={byKind.map(([k, n]) => `${n} ${KIND_LABEL[k]}`).join(', ')}>
          {byKind.map(([k, n]) => n > 0 && <i key={k} className={`k-${k}`} style={{ flex: n }} />)}
          {month.length === 0 && <i style={{ flex: 1, background: 'var(--line)' }} />}
        </div>
        <div className="legend">
          {byKind.map(([k, n]) => <span key={k}><i className={`k-${k}`} /> <b>{n}</b> {k === 'facetoface' ? 'face to face' : `${KIND_LABEL[k].toLowerCase()}${n === 1 ? '' : 's'}`}</span>)}
        </div>
        <div className="xgrid">
          {extras.map(([l, n]) => <span key={l} className={n ? 'did' : ''}><b>{n}</b> {l}</span>)}
        </div>
        <p className="note" style={{ margin: '10px 0 0' }}><b>{entries}</b> drawing entries so far this month.</p>
      </div>

      {!readOnly && (
        <details className="more" style={{ marginTop: 6 }}>
          <summary>My daily and weekly goals</summary>
          <MyGoals ctx={ctx} onProfileChange={onProfileChange} />
        </details>
      )}
      <details className="more" style={{ marginTop: 0 }}>
        <summary>My plan for the year</summary>
        {!ctx.readOnly && <button className="btn" style={{ width: '100%', marginBottom: 10 }} onClick={openGoalWizard}>Walk me through my goals</button>}
        <MyPlan key={JSON.stringify(ctx.agent.plan ?? {})} ctx={ctx} onProfileChange={onProfileChange} />
      </details>
    </section>
  )
}

/** One-on-one touches per person per year: the personal part of the 36 (6 calls, 6 texts, 2 cards, 2 pop-bys). */
const PERSONAL_TOUCHES = 16

/** Daily and weekly goals that keep the plan's people on pace. Weekly is always 5 days' worth. */
export function goalsFromPlan(plan: Record<string, number> | undefined, have: number) {
  const people = planNumbers(plan).dbNeeded || have
  const daily = Math.max(1, Math.ceil((people * PERSONAL_TOUCHES) / 52 / 5))
  return { daily, weekly: daily * 5, people }
}

function MyGoals({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { agent, me, data } = ctx
  const auto = agent.plan?.auto_goals !== 0
  const g = goalsFromPlan(agent.plan, data.contacts.length)
  const have = data.contacts.length
  const need = planNumbers(agent.plan).dbNeeded
  const atPlan = dailyForPeople(need, data.contacts, agent)
  const [day, setDay] = useState(agent.daily_goal)
  const toast = useToast()
  async function save(f: Partial<Profile>) {
    try {
      await api.updateMyProfile(me, f)
      onProfileChange?.()
    } catch (e) {
      toast((e as Error).message)
    }
  }
  return (
    <div className="card stack">
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 15 }}>
        <input type="checkbox" style={{ width: 22, height: 22 }} checked={auto}
          onChange={(e) => {
            const on = e.target.checked
            const d = dailyFromPeople(data.contacts, agent) || g.daily
            save(on
              ? { plan: { ...(agent.plan ?? {}), auto_goals: 1 }, daily_goal: d, weekly_goal: d * 5 }
              : { plan: { ...(agent.plan ?? {}), auto_goals: 0 } })
            if (on) setDay(d)
          }} />
        Set my daily goal from my people
      </label>
      {auto ? (
        <>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <div className="stat"><div className="n">{agent.daily_goal}</div><div className="l">touches a day</div></div>
            <div className="stat"><div className="n">{agent.weekly_goal}</div><div className="l">touches a week</div></div>
          </div>
          <p className="note">
            {have
              ? `Based on your ${have} people: A's every ${tierDays(agent, 'A')} days, everyone else every ${tierDays(agent, 'B')}. It goes up as you add people and tag more A's.`
              : 'Add your people and this sets itself from them.'}
            {have > 0 && have < need ? ` Your plan calls for ${need} people, which would be about ${atPlan} a day. Those show as dotted rocks on Today.` : ''}
          </p>
        </>
      ) : (
        <>
          <div className="ed">
            <label className="field"><span>Touches a day</span>
              <NumInput value={day} onChange={setDay} onCommit={(n) => { const d = Math.max(1, n || 1); save({ daily_goal: d, weekly_goal: d * 5, plan: { ...(agent.plan ?? {}), auto_goals: 0 } }) }} />
            </label>
            <div className="field"><span>Touches a week</span><div style={{ fontSize: 20, fontWeight: 600, padding: '9px 2px' }}>{Math.max(1, day || 1) * 5}</div></div>
          </div>
          <p className="note">A week is 5 workdays, so your weekly goal is your daily goal times 5. Your {have} people need about {dailyFromPeople(data.contacts, agent) || g.daily} a day to stay on schedule.</p>
        </>
      )}
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
  const { gci, deals, dbNeeded } = planNumbers(p)
  const have = data.contacts.length
  async function save(next: typeof p) {
    // Keep the "set goals from my plan" choice as it is now, and refresh those goals when it's on.
    // Keep the goal choice as it is; with automatic goals, the daily number follows your people (set on its own).
    const plan = { ...next, auto_goals: agent.plan?.auto_goals ?? 1 }
    await api.updateMyProfile(ctx.me, { plan })
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
        At that size, keeping everyone on schedule is about {dailyForPeople(dbNeeded, data.contacts, agent)} one-on-one touches a workday, with emails and newsletters covering the rest of the 36.
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

type PSort = 'cold' | 'warm' | 'az' | 'new'
const PSORTS: [PSort, string, string][] = [
  ['cold', 'Coldest first', 'Fewest bars at the top. Who needs you most.'],
  ['warm', 'Warmest first', "The people you're closest with right now."],
  ['az', 'A to Z', 'By name, with letter headings.'],
  ['new', 'Recently added', 'Newest people first.'],
]
type PTier = 'all' | 'A' | 'B' | 'U'
const tierOf = (c: Contact): 'A' | 'B' | 'U' => (c.tier === 'A' ? 'A' : c.tier === 'U' ? 'U' : 'B')
const initialsOf = (c: Contact) => `${c.first_name?.[0] ?? ''}${c.last_name?.[0] ?? ''}`.toUpperCase() || '?'
const talked = (d: string | undefined) => {
  if (!d) return 'Not reached yet'
  const n = daysBetween(parse(d), today())
  return n <= 0 ? 'Talked today' : n === 1 ? 'Talked yesterday' : `Last talked ${n} days ago`
}

function People({ ctx, onProfileChange }: { ctx: Ctx; onProfileChange?: () => void }) {
  const { data, agent, readOnly } = ctx
  // Bars come from one-on-one touches only (group sends don't count toward the status).
  const personal = useMemo(() => touchCounts(data.touches.filter((t) => !t.is_group)), [data.touches])
  const byContact = useMemo(() => touchCounts(data.touches), [data.touches])
  const [q, setQ] = useState('')
  const [tier, setTier] = useState<PTier>('all')
  const [sort, setSortState] = useState<PSort>(() => store.get<PSort>('rs-psort', 'cold'))
  const setSort = (v: PSort) => { setSortState(v); store.set('rs-psort', v) }
  const [sorting, setSorting] = useState(false)
  const [tools, setTools] = useState(false)
  const [exporting, setExporting] = useState(false)
  // Select mode: tap people to pick several, then tag or delete them together.
  const [sel, setSel] = useState<Set<string> | null>(null)
  const [confirmDel, setConfirmDel] = useState<'some' | 'all' | null>(null)
  const [typed, setTyped] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const toastP = useToast()
  const toggleSel = (id: string) => setSel((cur) => { const n = new Set(cur ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n })
  async function bulkTag(t: Tier) {
    if (!sel?.size) return
    setBulkBusy(true)
    try { await api.setTiers([...sel], t); await ctx.reload(); toastP(`${sel.size} tagged ${t}.`); setSel(null) } catch (e) { toastP((e as Error).message) }
    setBulkBusy(false)
  }
  async function bulkDelete(ids: string[]) {
    setBulkBusy(true)
    try { await api.deleteContacts(ids); await ctx.reload(); toastP(`${ids.length} ${ids.length === 1 ? 'person' : 'people'} deleted.`); setSel(null); setConfirmDel(null); setTyped('') } catch (e) { toastP((e as Error).message) }
    setBulkBusy(false)
  }
  const [edit, setEdit] = useState<Contact | null | 'new'>(null)
  const [view, setView] = useState<Contact | null>(null)
  const [addName, setAddName] = useState<string | null>(null)
  const [group, setGroup] = useState(false)
  // Opened from the welcome email's upload link.
  const [importing, setImporting] = useState(() => {
    if (store.get<string | null>('rs-go', null) !== 'import') return false
    store.set('rs-go', null)
    return !ctx.readOnly
  })
  const [shown, setShown] = useState(80)

  const lastOf = (c: Contact) => (personal.get(c.id) ?? []).reduce((m, d) => (d > m ? d : m), '')
  const barsOf = new Map(data.contacts.map((c) => [c.id, signal(c, personal, agent.tier_days)]))
  const untagged = data.contacts.filter((c) => c.tier === 'U').length
  const term = q.trim().toLowerCase()
  const searching = !!term
  const byName = (a: Contact, b: Contact) => fullName(a).localeCompare(fullName(b))
  const list = data.contacts
    .filter((c) => (searching
      ? fullName(c).toLowerCase().includes(term) || (c.phone ?? '').replace(/\D/g, '').includes(term.replace(/\D/g, '') || '~')
      : tier === 'all' || tierOf(c) === tier))
    .sort((a, b) => {
      if (searching || sort === 'az') return byName(a, b)
      if (sort === 'new') return (b.added_on ?? '').localeCompare(a.added_on ?? '') || byName(a, b)
      const d = (barsOf.get(a.id) ?? 0) - (barsOf.get(b.id) ?? 0)
      const older = lastOf(a).localeCompare(lastOf(b))
      return (sort === 'cold' ? d || older : -d || -older) || byName(a, b)
    })
  const letter = (c: Contact) => (fullName(c)[0] ?? '#').toUpperCase()

  async function setDays(t: Tier, v: number) {
    await api.updateMyProfile(ctx.me, { tier_days: { ...agent.tier_days, [t]: Math.max(1, v || 1) } })
    onProfileChange?.()
  }

  return (
    <section>
      <div className="ptitle">
        <div>
          <h2>People<small>{data.contacts.length}</small></h2>
        </div>
        {!readOnly && (
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn iconly" aria-label="More tools" onClick={() => setTools(true)}><IMore /></button>
            <button className="btn primary" onClick={() => setEdit('new')}><IPlus size={18} /> Add</button>
          </span>
        )}
      </div>

      <div className="search"><ISearch size={20} /><input type="search" placeholder="Find someone" aria-label="Find someone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {sel && (
        <div className="selbar">
          <b>{sel.size} selected</b>
          <span style={{ display: 'flex', gap: 14 }}>
            <button className="link" onClick={() => setSel(list.every((c) => sel.has(c.id)) ? new Set() : new Set([...sel, ...list.map((c) => c.id)]))}>{list.length && list.every((c) => sel.has(c.id)) ? 'Unselect all' : `Select all ${list.length}`}</button>
            <button className="link" onClick={() => setSel(null)}>Done</button>
          </span>
        </div>
      )}
      {sel && sel.size > 0 && (
        <div className="selacts">
          <button className="btn" disabled={bulkBusy} onClick={() => bulkTag('A')}>Tag A</button>
          <button className="btn" disabled={bulkBusy} onClick={() => bulkTag('B')}>Tag B</button>
          <button className="btn danger" disabled={bulkBusy} onClick={() => setConfirmDel('some')}>Delete {sel.size}</button>
        </div>
      )}
      {!searching && (
        <div className="pfilter">
          <div className="seg mini" role="group" aria-label="Show">
            {([['all', 'All'], ['A', 'A'], ['B', 'B'], ...(untagged ? [['U', 'Tag']] : [])] as [PTier, string][]).map(([k, l]) => (
              <button key={k} aria-pressed={tier === k} onClick={() => setTier(k)}>{l}{k === 'U' ? <b className="cnt">{untagged}</b> : <small className="segn">{k === 'all' ? data.contacts.length : data.contacts.filter((c) => tierOf(c) === k).length}</small>}</button>
            ))}
          </div>
          <button className="sortbtn" onClick={() => setSorting(true)}><span aria-hidden>⇅</span> {PSORTS.find(([k]) => k === sort)?.[1]}</button>
        </div>
      )}
      {searching && <div style={{ height: 12 }} />}

      {data.contacts.length === 0 ? (
        <div className="card empty">
          <p>No one here yet. Tap Add, or bring in a spreadsheet with the ⋯ button.</p>
        </div>
      ) : list.length === 0 ? (
        <div className="card empty"><p>{searching ? 'No one by that name yet.' : 'No one here yet.'}</p></div>
      ) : (
        <div className="plist">
          {list.slice(0, shown).map((c, i, arr) => {
            const head = sort === 'az' && !searching && (i === 0 || letter(arr[i - 1]) !== letter(c))
            const t = tierOf(c)
            return (
              <div key={c.id}>
                {head && <div className="phead">{letter(c)}</div>}
                <button className={`prow ${sel?.has(c.id) ? 'picked' : ''}`} onClick={() => (sel ? toggleSel(c.id) : setView(c))}>
                  {sel ? <span className={`selbox ${sel.has(c.id) ? 'on' : ''}`}>{sel.has(c.id) && <ICheck size={16} />}</span>
                    : <span className={`pav t-${t}`}>{t === 'U' ? '?' : initialsOf(c)}</span>}
                  <span className="nm">
                    <b>{fullName(c)}</b>
                    <small>{t === 'U' ? 'Needs a tag' : talked(lastOf(c) || undefined)}</small>
                  </span>
                  <Signal bars={barsOf.get(c.id) ?? 0} tone />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {list.length > shown && <button className="btn block" style={{ marginTop: 12 }} onClick={() => setShown(shown + 150)}>Show more ({list.length - shown})</button>}
      {!readOnly && q.trim() && !data.contacts.some((c) => fullName(c).toLowerCase() === q.trim().toLowerCase()) && (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => setAddName(q.trim())}><IPlus size={18} /> Add "{q.trim()}" as a new person</button>
      )}

      {confirmDel && (
        <Sheet label="Delete people" onClose={() => { setConfirmDel(null); setTyped('') }}>
          {confirmDel === 'some' ? (
            <>
              <h3>Delete {sel?.size} {sel?.size === 1 ? 'person' : 'people'}?</h3>
              <p className="note">Their touch history goes with them. This can't be undone.</p>
              <button className="btn danger lg block" style={{ marginTop: 12 }} disabled={bulkBusy} onClick={() => bulkDelete([...(sel ?? [])])}>{bulkBusy ? 'Deleting…' : `Yes, delete ${sel?.size}`}</button>
            </>
          ) : (
            <>
              <h3>Delete everyone?</h3>
              <p className="note">All {data.contacts.length} people and their touch history will be deleted. Your cards and challenges stay. This can't be undone.</p>
              <label className="field" style={{ marginTop: 10 }}><span>Type DELETE to confirm</span>
                <input value={typed} autoCapitalize="characters" onChange={(e) => setTyped(e.target.value)} />
              </label>
              <button className="btn danger lg block" style={{ marginTop: 12 }} disabled={bulkBusy || typed.trim().toUpperCase() !== 'DELETE'} onClick={() => bulkDelete(data.contacts.map((c) => c.id))}>{bulkBusy ? 'Deleting…' : `Delete all ${data.contacts.length}`}</button>
            </>
          )}
          <button className="btn ghost block" style={{ marginTop: 6 }} onClick={() => { setConfirmDel(null); setTyped('') }}>Cancel</button>
        </Sheet>
      )}
      {exporting && <ExportSheet contacts={data.contacts} byContact={byContact} agent={agent} onClose={() => setExporting(false)} />}
      {sorting && (
        <Sheet label="Sort by" onClose={() => setSorting(false)}>
          <h3>Sort by</h3>
          <div className="stack" style={{ marginTop: 10, gap: 8 }}>
            {PSORTS.map(([k, l, d]) => (
              <button key={k} className={`sortopt ${sort === k ? 'on' : ''}`} onClick={() => { setSort(k); setSorting(false); window.scrollTo({ top: 0 }) }}>
                <span><b>{l}</b><small>{d}</small></span>{sort === k && <ICheck size={18} />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {tools && (
        <Sheet label="More tools" onClose={() => setTools(false)}>
          <h3>More tools</h3>
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="card stack">
              <h3>Select several people</h3>
              <p className="note">Tap people to pick them, then tag them A or B, or delete them, all at once.</p>
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => { setTools(false); setSel(new Set()) }}>Select people</button>
            </div>
            <div className="card stack">
              <h3>Download my people</h3>
              <p className="note">A CSV file of everyone, or just a group: A's, B's, people with an email, people with a mailing address, or people you pick. Opens in Excel, Google Sheets or Numbers.</p>
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => { setTools(false); setExporting(true) }}>Choose who to download</button>
            </div>
            <div className="card stack">
              <h3>Bring in a spreadsheet</h3>
              <p className="note">A CSV file, like a BoldTrail export. People already here are skipped.</p>
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => { setTools(false); setImporting(true) }}>Import CSV</button>
            </div>
            <div className="card stack">
              <h3>Start over</h3>
              <p className="note">Delete all {data.contacts.length} people and their touch history, then bring in a fresh list. Download a copy first if you might want it.</p>
              <button className="btn danger" style={{ alignSelf: 'flex-start' }} disabled={!data.contacts.length} onClick={() => { setTools(false); setConfirmDel('all') }}>Delete everyone</button>
            </div>
            <div className="card stack">
              <h3>How often each tier comes up</h3>
              {[...TIERS, 'U' as Tier].map((t) => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                  <span>{t === 'U' ? '?: Needs a tag' : `${t}: ${TIER_NAMES[t]}`} <span className="note">({data.contacts.filter((c) => c.tier === t || (LEGACY[t] ?? []).includes(c.tier)).length})</span></span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    every <TierDays value={tierDays(agent, t)} label={`Days between touches for tier ${t}`} onCommit={(n) => setDays(t, n)} /> days
                  </span>
                </label>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      {edit && <EditSheet ctx={ctx} c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {addName !== null && <EditSheet ctx={ctx} c={null} prefill={{ name: addName }} onClose={() => setAddName(null)} />}
      {view && <PersonSheet ctx={ctx} c={view} onClose={() => setView(null)} onEdit={() => { const c = view; setView(null); setEdit(c) }} />}
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
  const who = ctx.data.contacts.filter((c) => tiers.includes(c.tier) && reachable(c, kind))
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

/** Dates saved without a year export as month/day. */
const noYear = (d: string | null | undefined) => (d && !hasYear(d) ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : d)
type XWho = 'all' | 'A' | 'B' | 'U' | 'pick'
const hasMail = (c: Contact) => !!c.address?.trim() && !!(c.zip?.trim() || c.city?.trim())

/** Download everyone, or just a group: by tier, by who has an email or mailing address, or hand-picked. */
function ExportSheet({ contacts, byContact, agent, onClose }: { contacts: Contact[]; byContact: Map<string, string[]>; agent: Profile; onClose: () => void }) {
  const [who, setWho] = useState<XWho>('all')
  const [needEmail, setNeedEmail] = useState(false)
  const [needMail, setNeedMail] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const base = contacts.filter((c) => (needEmail ? !!c.email?.trim() : true) && (needMail ? hasMail(c) : true))
  const group = who === 'pick' ? base.filter((c) => picked.has(c.id)) : who === 'all' ? base : base.filter((c) => tierOf(c) === who)
  const term = q.trim().toLowerCase()
  const shown = [...base].sort((a, b) => fullName(a).localeCompare(fullName(b))).filter((c) => !term || fullName(c).toLowerCase().includes(term))
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n) }
  const allShown = shown.length > 0 && shown.every((c) => picked.has(c.id))
  const label = who === 'all' ? 'everyone' : who === 'A' ? 'A' : who === 'B' ? 'B' : who === 'U' ? 'untagged' : 'picked'
  return (
    <Sheet label="Download my people" onClose={onClose}>
      <h3>Download my people</h3>
      <div className="xsec">Who</div>
      <div className="seg4 x5" role="group" aria-label="Who to download">
        {([['all', 'All'], ['A', "A's"], ['B', "B's"], ['U', 'No tag'], ['pick', 'Pick']] as [XWho, string][]).map(([k, l]) => (
          <button type="button" key={k} aria-pressed={who === k} onClick={() => setWho(k)}>{l}</button>
        ))}
      </div>
      <div className="xsec">Only people with</div>
      <div className="xchecks">
        <label><input type="checkbox" checked={needEmail} onChange={(e) => setNeedEmail(e.target.checked)} /> An email address</label>
        <label><input type="checkbox" checked={needMail} onChange={(e) => setNeedMail(e.target.checked)} /> A mailing address</label>
      </div>
      {who === 'pick' && (
        <>
          <div className="search" style={{ marginTop: 12 }}><ISearch size={20} /><input type="search" placeholder="Find someone" aria-label="Find someone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="xpickhead">
            <span className="note">{picked.size} picked</span>
            <button type="button" className="link" onClick={() => { const n = new Set(picked); shown.forEach((c) => (allShown ? n.delete(c.id) : n.add(c.id))); setPicked(n) }}>{allShown ? 'Unpick these' : term ? 'Pick all these' : 'Pick everyone'}</button>
          </div>
          <div className="xpick">
            {shown.slice(0, 300).map((c) => (
              <label key={c.id} className="xrow">
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                <span className={`pav t-${tierOf(c)}`}>{tierOf(c) === 'U' ? '?' : initialsOf(c)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{fullName(c)}</span>
              </label>
            ))}
            {shown.length > 300 && <p className="note" style={{ padding: 8 }}>Search to find more.</p>}
          </div>
        </>
      )}
      <button className="btn primary lg block" style={{ marginTop: 14 }} disabled={!group.length}
        onClick={() => { exportCsv(group, byContact, agent, who === 'all' && !needEmail && !needMail ? '' : [label, needEmail ? 'email' : '', needMail ? 'mailing' : ''].filter(Boolean).join('-')); onClose() }}>
        Download {group.length} {group.length === 1 ? 'person' : 'people'}
      </button>
    </Sheet>
  )
}

function exportCsv(contacts: Contact[], byContact: Map<string, string[]>, agent: Profile, tag = '') {
  const q = (v: unknown) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const head = ['First Name', 'Last Name', 'Phone', 'Email', 'Address', 'City', 'State', 'Zip', 'Tier', 'Birthday', 'Home Anniversary', 'Wedding Anniversary', 'Notes', 'Touches (12 months)', 'Last Touch', 'Added On', 'Source']
  const rows = [...contacts].sort((a, b) => fullName(a).localeCompare(fullName(b))).map((c) => [
    c.first_name, c.last_name, c.phone, c.email, c.address, c.city, c.state, c.zip,
    c.tier === 'U' ? '?' : c.tier === 'A' ? 'A' : 'B', noYear(c.birthday), c.home_anniversary, noYear(c.wedding_anniversary), c.notes, score(c, byContact), c.last_touch_on, c.added_on, c.source,
  ])
  const csv = [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${(agent.full_name || 'my').replace(/\s+/g, '-')}-people${tag ? `-${tag}` : ''}-${ymd(today())}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
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
      if (plan.fresh.length) await api.importContacts(ctx.me, plan.fresh.map((r) => ({ ...r, tier: r.tier ?? 'U', source: 'CSV import' })))
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
      <p className="note" style={{ margin: '4px 0 12px' }}>A CSV file, like a BoldTrail export. It reads names, phone, email, address, birthday, closing date, wedding anniversary and tier. Anyone already here gets their info updated instead of added twice.</p>
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
