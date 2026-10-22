import { addDays, daysBetween, parse, today, weekStart, ymd } from './dates'

export type Role = 'agent' | 'coach' | 'broker'
export type Tier = 'A' | 'B' | 'C' | 'D' | 'U'
export type TouchKind = 'call' | 'text' | 'card' | 'popby' | 'facetoface' | 'email' | 'newsletter' | 'event'

export interface Brokerage {
  id: string
  name: string
  settings: {
    prizes?: number[]
    touch_goal?: number
    touch_mix?: Record<string, number>
    monthly_goals?: { call?: number; text?: number; card?: number }
    morning_note?: { id: string; text: string; from: string; starts: string; ends: string } | null
  }
}

export interface Profile {
  id: string
  brokerage_id: string
  full_name: string | null
  email: string
  role: Role
  coach_id: string | null
  tier_days: Record<Tier, number>
  daily_goal: number
  weekly_goal: number
  card_rule: boolean
  plan: Record<string, number>
}

export interface Contact {
  id: string
  agent_id: string
  brokerage_id: string
  first_name: string
  last_name: string
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  tier: Tier
  notes: string | null
  birthday: string | null
  home_anniversary: string | null
  wedding_anniversary?: string | null
  prior_touches: number
  added_on: string
  last_touch_on: string | null
  skip_until: string | null
  /** A follow-up the agent set: this person shows up on Today on this date, with the note. */
  follow_up_on?: string | null
  follow_up_note?: string | null
  /** How to celebrate their birthday: text on the day (default), a card a few days early, both, or none. */
  birthday_plan?: BirthdayPlan | null
  home_plan?: BirthdayPlan | null
  wedding_plan?: BirthdayPlan | null
  source: string | null
}

export type BirthdayPlan = 'text' | 'card' | 'both' | 'none'


export interface Touch {
  id: string
  agent_id: string
  contact_id: string | null
  kind: TouchKind
  is_group: boolean
  note: string | null
  occurred_on: string
  created_at?: string
}

export interface Card {
  id: string
  agent_id: string
  contact_id: string | null
  recipient_name: string
  relationship: string | null
  occasion: string | null
  note: string | null
  sent_on: string
  counts_for_challenge: boolean
}

export interface Tally {
  agent_id: string
  month: string
  kind: string
  count: number
}

export const TIER_NAMES: Record<Tier, string> = {
  A: 'VIP',
  B: 'Advocates',
  C: 'Advocates',
  D: 'Advocates',
  U: 'Needs a tag',
}
/** The tiers agents pick from (plus ? for not tagged yet). C and D only exist in older data and behave like B. */
export const TIERS: Tier[] = ['A', 'B']
export const DEFAULT_TIER_DAYS: Record<Tier, number> = { A: 14, B: 30, C: 30, D: 30, U: 30 }

export const KIND_LABEL: Record<TouchKind, string> = {
  call: 'Call',
  text: 'Text',
  card: 'Card',
  popby: 'Pop-by',
  facetoface: 'Face to face',
  email: 'Email',
  newsletter: 'Newsletter',
  event: 'Event',
}

export const fullName = (c: Pick<Contact, 'first_name' | 'last_name'>) => `${c.first_name} ${c.last_name}`.trim()
export const telOf = (p: string) => p.replace(/[^0-9+]/g, '')

// ---------- Rotation ----------
export function tierDays(p: Profile | null, t: Tier) {
  return (p?.tier_days?.[t] ?? DEFAULT_TIER_DAYS[t]) || DEFAULT_TIER_DAYS[t]
}

/** When this contact next comes up. Never-touched contacts are due now. */
export function nextDue(c: Contact, p: Profile | null): Date {
  if (!c.last_touch_on) return parse(c.added_on)
  return addDays(parse(c.last_touch_on), tierDays(p, c.tier))
}

const TIER_ORDER: Record<Tier, number> = { A: 0, B: 1, U: 1, C: 2, D: 2 }

/** A repeatable random number source: the same seed gives the same list all day, a new day gives a new mix. */
export function seeded(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}
export function shuffled<T>(xs: T[], seed: string) {
  const r = seeded(seed)
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Each person's last one-on-one touch. Group emails and mailouts don't count: they're not "touching base". */
export function lastPersonal(touches: Touch[]) {
  const m = new Map<string, string>()
  for (const t of touches) if (!t.is_group && t.contact_id && (m.get(t.contact_id) ?? '') < t.occurred_on) m.set(t.contact_id, t.occurred_on)
  return m
}

/**
 * How "cold" someone is: time since their last one-on-one touch compared with how often their tier should hear from you.
 * 1 = right on time, 2 = twice as long as it should be. Never touched counts as 1.5.
 */
export function coolness(c: Contact, p: Profile | null, last: Map<string, string>, plusDays = 0) {
  const d = last.get(c.id)
  if (!d) return 1.5
  return (daysBetween(parse(d), today()) + plusDays) / tierDays(p, c.tier)
}

/**
 * Who comes up next on Today. Only one-on-one touches move someone's next turn: a group email or
 * mailed newsletter counts toward their 36, but they still get their personal call, text or card on schedule.
 * Everyone due by the end of this week is in the running, A's and B's alike. The colder someone is, the more
 * likely they come up, but the picks and the order are shuffled each day so the list stays fresh.
 * If fewer than `want` are due, it fills with whoever is closest to due.
 */
export function rotation(contacts: Contact[], p: Profile | null, touches: Touch[], touchedThisWeek: Set<string>, exclude: Set<string>, want: number, seed = '') {
  const last = lastPersonal(touches)
  const t = ymd(today())
  const left = Math.max(0, daysBetween(today(), addDays(weekStart(), 6)))
  const open = contacts.filter((c) => !exclude.has(c.id) && !touchedThisWeek.has(c.id) && (!c.skip_until || c.skip_until <= t))
  const scored = open.map((c) => ({ c, s: coolness(c, p, last), due: coolness(c, p, last, left) >= 1 }))
  const r = seeded(`${seed}|${t}|${exclude.size}`)
  // Weighted shuffle: colder people get bigger weights, so they tend to come first without it being predictable.
  const due = scored
    .filter((x) => x.due)
    .map((x) => ({ ...x, key: Math.pow(r(), 1 / Math.pow(Math.min(x.s, 4) + 0.25, 2)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.c)
  if (due.length >= want) return due.slice(0, want)
  const ahead = scored.filter((x) => !x.due).sort((a, b) => b.s - a.s).map((x) => x.c)
  return [...due, ...ahead].slice(0, want)
}

export function duePool(contacts: Contact[], p: Profile | null, touchedThisWeek: Set<string>, exclude: Set<string>) {
  const end = addDays(weekStart(), 6)
  const t = ymd(today())
  return contacts
    .filter((c) => !exclude.has(c.id) && !touchedThisWeek.has(c.id))
    .filter((c) => !c.skip_until || c.skip_until <= t)
    .filter((c) => nextDue(c, p) <= end)
    .sort(
      (a, b) =>
        nextDue(a, p).getTime() - nextDue(b, p).getTime() ||
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
        fullName(a).localeCompare(fullName(b)),
    )
}

/** Repeating mix so each day's list blends calls and texts with a card or two (roughly the 6 / 6 / 2 personal-touch split). */
const MIX: Array<'call' | 'text' | 'card'> = ['call', 'text', 'card', 'text', 'call', 'text', 'call']

/**
 * Suggest the touch type this person is shortest on over the last 12 months, relative to the 6 calls / 6 texts / 2 cards mix.
 * When several types are equally short (for example, someone with no touches yet), the list position decides,
 * so a day's list comes out mixed instead of all calls. Any logged touch counts toward the 36 regardless of the suggestion.
 */
export function suggestKind(c: Contact, touches: Touch[], slot = 0): 'call' | 'text' | 'card' {
  const since = ymd(addDays(today(), -365))
  const n = { call: 0, text: 0, card: 0 }
  for (const t of touches) if (t.contact_id === c.id && t.occurred_on >= since && t.kind in n) n[t.kind as 'call']++
  const want = { call: 6, text: 6, card: 2 }
  const ratio = (k: keyof typeof n) => n[k] / want[k]
  const best = Math.min(ratio('call'), ratio('text'), ratio('card'))
  const tied = (['call', 'text', 'card'] as const).filter((k) => ratio(k) - best < 1e-9)
  if (tied.length === 1) return tied[0]
  for (let i = 0; i < MIX.length; i++) {
    const k = MIX[(slot + i) % MIX.length]
    if (tied.includes(k)) return k
  }
  return tied[0]
}

// ---------- Daily goal from the people you actually have ----------
/** One-on-one touches a year your people need: A's every 14 days, B's every 30 (or whatever your tier days are). */
export function yearlyTouches(contacts: Contact[], p: Profile | null) {
  return contacts.reduce((s, c) => s + 365 / tierDays(p, c.tier), 0)
}
/** Touches a workday (260 a year) to keep everyone in your database on schedule. */
export function dailyFromPeople(contacts: Contact[], p: Profile | null) {
  return contacts.length ? Math.min(30, Math.max(1, Math.ceil(yearlyTouches(contacts, p) / 260))) : 0
}
/** The daily goal a bigger database would need: the same mix of A's and B's, scaled to `people`. */
export function dailyForPeople(people: number, contacts: Contact[], p: Profile | null) {
  const avg = contacts.length ? yearlyTouches(contacts, p) / contacts.length : 365 / tierDays(p, 'B')
  return Math.min(30, Math.max(1, Math.ceil((people * avg) / 260)))
}

// ---------- Rolling 12-month thermometer ----------
export type Heat = 'hot' | 'warm' | 'cold' | 'new'
export const HEAT_NAME: Record<Heat, string> = { hot: 'On pace', warm: 'Behind', cold: 'Urgent', new: 'New' }
export const HEAT_ICON: Record<Heat, string> = { hot: '✓', warm: '–', cold: '!', new: '•' }

export function windowDays(c: Contact) {
  return Math.min(365, Math.max(0, daysBetween(parse(c.added_on), today())))
}

export function touchCounts(touches: Touch[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const t of touches) {
    if (!t.contact_id) continue
    const arr = m.get(t.contact_id)
    if (arr) arr.push(t.occurred_on)
    else m.set(t.contact_id, [t.occurred_on])
  }
  return m
}

export function score(c: Contact, byContact: Map<string, string[]>) {
  const start = ymd(addDays(today(), -windowDays(c)))
  const dates = byContact.get(c.id) ?? []
  return (c.prior_touches || 0) + dates.filter((d) => d >= start).length
}

export function target(c: Contact, goal: number) {
  return (goal * Math.max(30, windowDays(c))) / 365
}

/**
 * Status is about timing, not the yearly total:
 *  - On pace: touched recently enough for their tier.
 *  - Behind: due now, or past due by less than one more cycle.
 *    Also anyone with 6+ months of history who is under half their 36-touch pace.
 *  - Urgent: more than two full cycles since the last touch.
 *  - New: added in the last 30 days and not touched yet.
 */
export function heat(c: Contact, byContact: Map<string, string[]>, goal: number, days: Record<Tier, number> = DEFAULT_TIER_DAYS): Heat {
  const n = score(c, byContact)
  const age = daysBetween(parse(c.added_on), today())
  if (age < 30 && n === 0) return 'new'
  const every = days[c.tier] || DEFAULT_TIER_DAYS[c.tier]
  const lastSeen = (byContact.get(c.id) ?? []).reduce((m, d) => (d > m ? d : m), c.last_touch_on ?? '')
  const since = daysBetween(parse(lastSeen || c.added_on), today())
  if (since > every * 2) return 'cold'
  if (since > every) return 'warm'
  if (age >= 182 && n / target(c, goal) < 0.5) return 'warm'
  return 'hot'
}

/**
 * Signal strength, 0 to 5, like phone bars: how long since your last one-on-one touch compared with their tier.
 * Pass each person's personal (non-group) touch dates, so a newsletter doesn't make everyone look freshly contacted.
 * Bars drop steadily as time passes: 5 right after a touch, 3 when they're due, 1 when it's been twice as long.
 * 0 = no personal touch yet.
 */
export function signal(c: Contact, byContact: Map<string, string[]>, days: Record<Tier, number> = DEFAULT_TIER_DAYS): number {
  const lastSeen = (byContact.get(c.id) ?? []).reduce((m, d) => (d > m ? d : m), '')
  if (!lastSeen) return 0
  const every = days[c.tier] || DEFAULT_TIER_DAYS[c.tier]
  const r = daysBetween(parse(lastSeen), today()) / every
  return r <= 0.35 ? 5 : r <= 0.7 ? 4 : r <= 1 ? 3 : r <= 1.5 ? 2 : 1
}

// ---------- Goals ----------
export function countBetween(touches: Touch[], cards: Card[], from: string, to: string) {
  const t = touches.filter((x) => !x.is_group && x.occurred_on >= from && x.occurred_on <= to).length
  return t
}

export function cardWithin12Months(cards: Card[], name: string, before?: string) {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim()
  const from = ymd(addDays(today(), -365))
  return [...cards]
    .filter((c) => c.recipient_name.toLowerCase().replace(/\s+/g, ' ').trim() === n && c.sent_on >= from && (!before || c.sent_on < before))
    .sort((a, b) => b.sent_on.localeCompare(a.sent_on))[0]
}

// ---------- Card a Day coverage ----------
/**
 * Days covered by Card a Day. A day with a card written on it is "written".
 * Extra cards written on the same day cover nearby empty days: first catching up on missed days
 * in the 6 days before (never before their first card), then banking ahead on the next open days.
 */
export function cardCoverage(cards: Card[]) {
  const counting = cards.filter((c) => c.counts_for_challenge)
  const byDay = new Map<string, Card[]>()
  for (const c of counting) {
    if (!byDay.has(c.sent_on)) byDay.set(c.sent_on, [])
    byDay.get(c.sent_on)!.push(c)
  }
  const written = new Set(byDay.keys())
  // Nothing before someone's very first card can be "caught up": they hadn't started yet.
  const firstDay = [...written].sort()[0] ?? ''
  const covered = new Map<string, string>() // covered day -> day the card was actually written
  const coveredBy = new Map<string, Card>() // covered day -> the extra card that covers it
  for (const day of [...byDay.keys()].sort()) {
    const extras = byDay.get(day)!.slice(1) // the first card counts for its own day
    const base = parse(day)
    const tryDay = (n: number) => {
      const k = ymd(addDays(base, n))
      if (extras.length && k >= firstDay && !written.has(k) && !covered.has(k)) { covered.set(k, day); coveredBy.set(k, extras.shift() as Card) }
    }
    for (let n = -1; n >= -6 && extras.length; n--) tryDay(n)
    // Banked cards always sit on the next open days. Write a card on a banked day and the bank slides forward.
    for (let n = 1; n <= 60 && extras.length; n++) tryDay(n)
  }
  const has = (k: string) => written.has(k) || covered.has(k)
  return { written, covered, coveredBy, byDay, has }
}

// ---------- The yearly plan ----------
/** Take-home goal to closings to people needed. */
export function planNumbers(plan: Record<string, number> | undefined) {
  const p = { income: 80000, cap: 0, price: 275000, rate: 2.7, conversion: 12, ...(plan ?? {}) }
  const gci = p.income + p.cap
  const perDeal = p.price * (p.rate / 100)
  const deals = perDeal > 0 ? Math.ceil(gci / perDeal) : 0
  const dbNeeded = p.conversion > 0 ? Math.ceil(deals / (p.conversion / 100)) : 0
  return { gci, perDeal, deals, dbNeeded }
}

// ---------- Birthdays and anniversaries on Today ----------
/** Birthdays and wedding anniversaries can be saved without a year. They're stored with this placeholder year (a leap year, so Feb 29 works). */
export const NO_YEAR = '1904'
export const hasYear = (d: string | null | undefined) => !!d && !d.startsWith(NO_YEAR)
export type Occasion = 'birthday' | 'home' | 'wedding'
export const OCCASION_META: Record<Occasion, { field: 'birthday' | 'home_anniversary' | 'wedding_anniversary'; plan: 'birthday_plan' | 'home_plan' | 'wedding_plan'; name: string; icon: string; card: string; years: boolean }> = {
  birthday: { field: 'birthday', plan: 'birthday_plan', name: 'Birthday', icon: '🎂', card: 'Birthday', years: false },
  home: { field: 'home_anniversary', plan: 'home_plan', name: 'Home anniversary', icon: '🏡', card: 'Anniversary', years: true },
  wedding: { field: 'wedding_anniversary', plan: 'wedding_plan', name: 'Wedding anniversary', icon: '💍', card: 'Anniversary', years: true },
}
export const OCCASION_LIST: Occasion[] = ['birthday', 'home', 'wedding']
/** Card prompts show this many days before the day, until a card is logged. */
export const CARD_EARLY = { from: 5, to: 3 }
export const planOf = (c: Contact, o: Occasion): BirthdayPlan => (c[OCCASION_META[o].plan] as BirthdayPlan | null | undefined) ?? 'text'
export const birthdayPlanOf = (c: Contact) => planOf(c, 'birthday')

/** This year's date (or next year's if it already passed more than a week ago), at noon. */
export function nextOccasion(date: string | null | undefined, from = today()): Date | null {
  if (!date) return null
  const b = parse(date)
  let d = new Date(from.getFullYear(), b.getMonth(), b.getDate(), 12)
  if (daysBetween(from, d) < -7) d = new Date(from.getFullYear() + 1, b.getMonth(), b.getDate(), 12)
  return d
}
export const nextBirthday = (c: Contact, from = today()) => nextOccasion(c.birthday, from)
/** Years since the original date, on this year's date (home and wedding anniversaries). */
export function yearsOn(c: Contact, o: Occasion, on: string) {
  const v = c[OCCASION_META[o].field]
  if (!v || !hasYear(v)) return 0
  return parse(on).getFullYear() - parse(v).getFullYear()
}

export type BdayEntry = { id: string; kind: 'day' | 'card'; on: string; occ?: Occasion; also?: Occasion[] }

/** Is a birthday or anniversary entry still right for this person? (The date or the choice may have changed since.) */
export function entryStillValid(c: Contact, e: BdayEntry) {
  const occ = e.occ ?? 'birthday'
  const d = nextOccasion(c[OCCASION_META[occ].field])
  if (!d || ymd(d) !== e.on) return false
  if (c.skip_until && c.skip_until > ymd(today())) return false
  const plan = planOf(c, occ)
  return e.kind === 'card' ? plan === 'card' || plan === 'both' : plan === 'text' || plan === 'both' || c.follow_up_on === e.on
}
/**
 * Who has a birthday or anniversary to celebrate today: day-of texts (plan text or both, or a "remind me on the day"
 * follow-up), and card prompts 5 to 3 days before (plan card or both) until a card is logged.
 */
export function birthdaysToday(contacts: Contact[], touches: Touch[]): BdayEntry[] {
  const now = today()
  const t = ymd(now)
  const out: BdayEntry[] = []
  for (const c of contacts) {
    if (c.skip_until && c.skip_until > t) continue
    const mine: BdayEntry[] = []
    for (const occ of OCCASION_LIST) {
      const d = nextOccasion(c[OCCASION_META[occ].field], now)
      if (!d) continue
      const on = ymd(d)
      const left = daysBetween(now, d)
      const plan = planOf(c, occ)
      let e: BdayEntry | null = null
      if (left === 0 && (plan === 'text' || plan === 'both' || c.follow_up_on === on)) e = { id: c.id, kind: 'day', on, occ }
      else if (left <= CARD_EARLY.from && left >= CARD_EARLY.to && (plan === 'card' || plan === 'both')) {
        const since = ymd(addDays(d, -10))
        const sent = touches.some((x) => x.contact_id === c.id && !x.is_group && x.kind === 'card' && x.occurred_on >= since)
        if (!sent) e = { id: c.id, kind: 'card', on, occ }
      }
      if (e) mine.push(e)
    }
    // One spot per person. If several land together (birthday and anniversary the same day), they share it.
    if (mine.length) {
      const first = mine.find((x) => x.kind === 'day') ?? mine[0]
      const also = mine.filter((x) => x !== first && x.kind === first.kind && x.on === first.on).map((x) => x.occ!)
      out.push(also.length ? { ...first, also } : first)
    }
  }
  // Today's first, then the nearest cards.
  return out.sort((a, b) => (a.kind === b.kind ? a.on.localeCompare(b.on) : a.kind === 'day' ? -1 : 1))
}
