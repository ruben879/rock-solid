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
  source: string | null
}

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

/** Everyone due by the end of this week who hasn't been touched this week and isn't pushed to later. */
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
 * Signal strength, 0 to 5, like phone bars: how recently they've heard from you compared with their tier.
 * 5 = touched in the first half of their window, 1 = more than two windows with nothing, 0 = never touched.
 */
export function signal(c: Contact, byContact: Map<string, string[]>, days: Record<Tier, number> = DEFAULT_TIER_DAYS): number {
  const lastSeen = (byContact.get(c.id) ?? []).reduce((m, d) => (d > m ? d : m), c.last_touch_on ?? '')
  if (!lastSeen) return 0
  const every = days[c.tier] || DEFAULT_TIER_DAYS[c.tier]
  const r = daysBetween(parse(lastSeen), today()) / every
  return r <= 0.5 ? 5 : r <= 1 ? 4 : r <= 1.5 ? 3 : r <= 2 ? 2 : 1
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
 * in the 6 days before, then banking ahead for the 7 days after. Those days are "covered".
 */
export function cardCoverage(cards: Card[]) {
  const counting = cards.filter((c) => c.counts_for_challenge)
  const perDay = new Map<string, number>()
  for (const c of counting) perDay.set(c.sent_on, (perDay.get(c.sent_on) ?? 0) + 1)
  const written = new Set(perDay.keys())
  const covered = new Map<string, string>() // covered day -> day the card was actually written
  for (const day of [...perDay.keys()].sort()) {
    let extra = (perDay.get(day) ?? 1) - 1
    const base = parse(day)
    const tryDay = (n: number) => {
      const k = ymd(addDays(base, n))
      if (extra > 0 && !written.has(k) && !covered.has(k)) { covered.set(k, day); extra-- }
    }
    for (let n = -1; n >= -6 && extra > 0; n--) tryDay(n)
    for (let n = 1; n <= 7 && extra > 0; n++) tryDay(n)
  }
  const has = (k: string) => written.has(k) || covered.has(k)
  return { written, covered, has }
}
