import { addDays, parse, today, weekStart, ymd } from './dates.js'
import { birthdaysToday, dailyFromPeople, rotation, shuffled, type BdayEntry, type Contact, type Profile, type Touch } from './model.js'

/*
  The rules that make a day's Today list, in one place so the phone (Today) and the server (the morning nudge)
  run the same code. Nothing here touches the network or the phone's storage: callers pass in what they have.
*/

// ---------- The daily goal Today works from ----------
export const STARTER_DAILY_GOAL = Math.ceil((100 * 16) / 52 / 5)
const DB_DEFAULT_DAILY = 5
/** A profile as the app reads it: a never-set goal becomes the starter goal, and the week is 5 workdays. */
export function withGoals<P extends Profile>(p: P): P {
  const untouched = p.plan?.income === undefined
  const daily = untouched && p.daily_goal === DB_DEFAULT_DAILY ? STARTER_DAILY_GOAL : p.daily_goal
  return { ...p, daily_goal: daily, weekly_goal: daily * 5 }
}
/** The agent Today works from: the daily goal follows their people unless they set their own number. */
export function todayAgent<P extends Profile>(p: P, todayContacts: Contact[]): P {
  const auto = p.plan?.auto_goals !== 0
  const fromPeople = todayContacts.length ? dailyFromPeople(todayContacts, p) : 0
  return auto && fromPeople ? { ...p, daily_goal: fromPeople, weekly_goal: fromPeople * 5 } : p
}
/** Today's people: My Sphere only, without New people still waiting from an entry import. Touches with recruits drop out too. */
export function todaySphere(contacts: Contact[], touches: Touch[]) {
  const recruits = new Set(contacts.filter((c) => c.sphere === 'recruit').map((c) => c.id))
  return {
    contacts: contacts.filter((c) => c.sphere !== 'recruit' && !c.import_batch_id),
    touches: recruits.size ? touches.filter((t) => !t.contact_id || !recruits.has(t.contact_id)) : touches,
  }
}

export const touchedSince = (touches: Touch[], since: string) =>
  new Set(touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on >= since).map((t) => t.contact_id as string))

/**
 * A new day's list of rotation people (after the birthdays and follow-ups at the top): whoever wasn't reached
 * on the last list comes forward, people already reached today count toward it, then it fills up to the goal.
 */
export function newDayIds(a: {
  contacts: Contact[]; touches: Touch[]; agent: Profile; touchedThisWeek: Set<string>
  top: string[]; size: number; day: string; last: { day: string; ids: string[] } | null
}): string[] {
  const { contacts, touches, agent, touchedThisWeek, top, size, day, last } = a
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const poolExcluding = (ex: string[], want: number) => rotation(contacts, agent, touches, touchedThisWeek, new Set([...ex, ...top]), want, agent.id)
  let carry: string[] = []
  if (last && last.day < day) {
    const reached = new Set(touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on >= last.day).map((t) => t.contact_id as string))
    carry = last.ids.filter((id) => {
      const c = byId.get(id)
      return c && !reached.has(id) && (!c.skip_until || c.skip_until <= day)
    }).filter((id) => !top.includes(id)).slice(0, size)
  }
  const doneToday = [...new Set(touches.filter((t) => !t.is_group && t.contact_id && t.occurred_on === day && byId.has(t.contact_id)).map((t) => t.contact_id as string))].filter((id) => !top.includes(id)).slice(0, size)
  carry = carry.filter((id) => !doneToday.includes(id)).slice(0, size - doneToday.length)
  const start = [...doneToday, ...carry]
  // Mixed order (not alphabetical), the same all day.
  return shuffled([...start, ...poolExcluding(start, size - start.length).map((c) => c.id)], `${agent.id}|${day}`)
}

/** Is this person on Today done? Birthdays and follow-ups need a touch today (or the card); everyone else, a touch this week. */
export function doneOnToday(c: Contact, bd: BdayEntry | undefined, isFu: boolean, touches: Touch[], day: string, touchedThisWeek: Set<string>, touchedToday: Set<string>) {
  if (bd) {
    if (bd.kind === 'card') {
      const since = ymd(addDays(parse(bd.on), -10))
      const cardSent = touches.some((t) => t.contact_id === c.id && !t.is_group && t.kind === 'card' && t.occurred_on >= since)
      const reachedSince = bd.on <= day && touches.some((t) => t.contact_id === c.id && !t.is_group && t.occurred_on >= bd.on)
      return cardSent || reachedSince
    }
    return touchedToday.has(c.id)
  }
  return isFu ? touchedToday.has(c.id) : touchedThisWeek.has(c.id)
}

/**
 * The people still waiting on Today, in Today's order, for a day the phone hasn't built yet.
 * Same steps Today takes on the first open of a day: birthdays (at most half the spots), follow-ups, then the rotation.
 */
export function freshQueue(allContacts: Contact[], allTouches: Touch[], profile: Profile, last: { day: string; ids: string[] } | null): string[] {
  const { contacts, touches } = todaySphere(allContacts, allTouches)
  const agent = todayAgent(withGoals(profile), contacts)
  const day = ymd(today())
  const full = Math.min(30, Math.max(1, agent.daily_goal || 5))
  const touchedThisWeek = touchedSince(touches, ymd(weekStart()))
  const touchedToday = new Set(touches.filter((t) => !t.is_group && t.occurred_on === day && t.contact_id).map((t) => t.contact_id as string))
  const bdays = birthdaysToday(contacts, touches).slice(0, Math.max(1, Math.floor(full / 2)))
  const bdIds = bdays.map((e) => e.id)
  const fuIds = contacts.filter((c) => c.follow_up_on && c.follow_up_on <= day && !(c.skip_until && c.skip_until > day)).map((c) => c.id).filter((id) => !bdIds.includes(id))
  const size = Math.max(0, full - bdIds.length)
  let ids = newDayIds({ contacts, touches, agent, touchedThisWeek, top: [...bdIds, ...fuIds], size, day, last })
  if (ids.length > 0 && ids.length < size)
    ids = [...ids, ...rotation(contacts, agent, touches, touchedThisWeek, new Set([...ids, ...bdIds, ...fuIds]), size - ids.length, agent.id).map((c) => c.id)]
  const byId = new Map(contacts.map((c) => [c.id, c]))
  return [...bdIds, ...fuIds, ...ids].filter((id) => {
    const c = byId.get(id)
    return c && !doneOnToday(c, bdays.find((e) => e.id === id), fuIds.includes(id), touches, day, touchedThisWeek, touchedToday)
  })
}

// ---------- The morning nudge's words ----------
const ROTATION_START = Date.UTC(2026, 0, 1)
/** The two people the nudge names on this Lubbock date: two places further along each day, wrapping around. */
export function namedPair<T>(queue: T[], day: string): T[] {
  if (queue.length <= 2) return queue.slice(0, 2)
  const [y, m, d] = day.split('-').map(Number)
  const days = Math.round((Date.UTC(y, m - 1, d) - ROTATION_START) / 86_400_000)
  const start = (((days * 2) % queue.length) + queue.length) % queue.length
  return [queue[start], queue[(start + 1) % queue.length]]
}
const nameOf = (c: Pick<Contact, 'first_name' | 'last_name'>) => [c.first_name, c.last_name].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
/** The nudge body for this queue, or null when the queue is empty (the caller keeps its usual words). */
export function queueBody(queue: Pick<Contact, 'first_name' | 'last_name'>[], day: string): string | null {
  if (!queue.length) return null
  if (queue.length === 1) return `${nameOf(queue[0])} is waiting to hear from you.`
  const [a, b] = namedPair(queue, day).map(nameOf)
  if (queue.length === 2) return `${a} and ${b} are waiting to hear from you.`
  const n = queue.length - 2
  return `${a}, ${b} and ${n} ${n === 1 ? 'other' : 'others'} are waiting to hear from you.`
}
