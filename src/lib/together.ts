// Together: challenges, their feed, kudos and progress. Online only.
import { supabase } from '../supabase'
import { addDays, parse, today, weekStart, ymd } from './dates'
import { cardCoverage, type Card } from './model'

export type Period = 'day' | 'week' | 'month'
export interface Challenge {
  id: string
  created_by: string
  name: string
  kind: 'cards' | 'custom'
  counts: string[]
  target: number
  period: Period
  starts_on: string
  ends_on: string
  code: string
}
export interface Post { id: string; challenge_id: string; user_id: string; body: string | null; auto_day: string | null; auto_n: number; created_at: string }
export interface Person { user_id: string; name: string }
export interface DayCount { user_id: string; day: string; n: number }

/** What a custom challenge can count. All of these are already logged in the app. */
export const COUNTABLE: [string, string, string][] = [
  // key, chip label, plural noun for posts
  ['any', 'Any touch', 'touches'],
  ['call', 'Calls', 'calls'],
  ['text', 'Texts', 'texts'],
  ['card', 'Cards', 'cards'],
  ['popby', 'Pop-bys', 'pop-bys'],
  ['facetoface', 'Face to face', 'face to face visits'],
  ['social', 'Social posts', 'social posts'],
  ['video', 'Videos', 'videos'],
  ['openhouse', 'Open houses', 'open houses'],
]

const friendly = (m: string) =>
  /challenge|relation|function/i.test(m) && /does not exist|not find|could not/i.test(m)
    ? 'Together needs the challenges SQL (0009) run in Supabase first.'
    : m
function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(friendly(r.error.message))
  return r.data
}

export const joinLink = (c: Pick<Challenge, 'code'>) => `${location.origin}/j/${c.code}`

export async function myChallenges(userId: string): Promise<Challenge[]> {
  const ids = check(await supabase.from('challenge_members').select('challenge_id').eq('user_id', userId)) as { challenge_id: string }[]
  if (!ids.length) return []
  const list = check(await supabase.from('challenges').select('*').in('id', ids.map((x) => x.challenge_id)).order('ends_on', { ascending: false })) as Challenge[]
  return list
}

export async function startChallenge(userId: string, c: Omit<Challenge, 'id' | 'created_by' | 'code'>) {
  const row = check(await supabase.from('challenges').insert({ ...c, created_by: userId }).select('*').single()) as Challenge
  return row
}

export async function preview(code: string) {
  const rows = check(await supabase.rpc('challenge_preview', { p_code: code })) as { id: string; name: string; kind: string; starts_on: string; ends_on: string; members: number; started_by: string }[]
  return rows[0] ?? null
}
export async function join(code: string) {
  return check(await supabase.rpc('join_challenge', { p_code: code })) as string
}
export async function leave(challengeId: string, userId: string) {
  check(await supabase.from('challenge_members').delete().eq('challenge_id', challengeId).eq('user_id', userId))
}
export async function endChallenge(challengeId: string) {
  check(await supabase.from('challenges').delete().eq('id', challengeId))
}

export async function loadRoom(c: Challenge) {
  const [people, progress, posts] = await Promise.all([
    supabase.rpc('challenge_people', { cid: c.id }).then(check) as Promise<Person[]>,
    supabase.rpc('challenge_progress', { cid: c.id }).then(check) as Promise<DayCount[]>,
    supabase.from('challenge_posts').select('*').eq('challenge_id', c.id).order('created_at', { ascending: false }).limit(150).then(check) as Promise<Post[]>,
  ])
  const ids = posts.map((p) => p.id)
  const kudos = ids.length ? ((check(await supabase.from('challenge_kudos').select('post_id, user_id').in('post_id', ids)) as { post_id: string; user_id: string }[])) : []
  return { people, progress, posts, kudos }
}

// ---------- What's new: posts from others since you last opened each challenge (kept on this phone) ----------
const seenKey = (cid: string) => `rs-seen-${cid}`
function lastSeen(cid: string) {
  try {
    const v = localStorage.getItem(seenKey(cid))
    if (v) return JSON.parse(v) as string
    const now = new Date().toISOString() // First time on this phone: start fresh, not with every old post.
    localStorage.setItem(seenKey(cid), JSON.stringify(now))
    return now
  } catch { return new Date().toISOString() }
}
export function markSeen(cid: string) {
  try { localStorage.setItem(seenKey(cid), JSON.stringify(new Date().toISOString())) } catch { /* storage off */ }
  window.dispatchEvent(new Event('rs-seen'))
}
/** New posts per challenge from other people since you last looked. */
export async function unread(userId: string): Promise<Record<string, number>> {
  const ids = await supabase.from('challenge_members').select('challenge_id').eq('user_id', userId)
  if (ids.error || !ids.data.length) return {}
  const seen = Object.fromEntries((ids.data as { challenge_id: string }[]).map((x) => [x.challenge_id, lastSeen(x.challenge_id)]))
  const oldest = Object.values(seen).sort()[0]
  const r = await supabase.from('challenge_posts').select('challenge_id, created_at').in('challenge_id', Object.keys(seen)).neq('user_id', userId).gt('created_at', oldest).limit(500)
  if (r.error) return {}
  const out: Record<string, number> = {}
  for (const p of r.data as { challenge_id: string; created_at: string }[]) if (p.created_at > seen[p.challenge_id]) out[p.challenge_id] = (out[p.challenge_id] ?? 0) + 1
  return out
}

// ---------- In-app invites (people in your brokerage) ----------
export interface Invite { challenge_id: string; name: string; code: string; starts_on: string; ends_on: string; invited_by: string; members: number }
export async function myInvites(): Promise<Invite[]> {
  const r = await supabase.rpc('my_invites')
  if (r.error) return [] // Before the invites SQL is run: no invites, no error.
  return r.data as Invite[]
}
export async function brokeragePeople(): Promise<Person[]> {
  return check(await supabase.rpc('brokerage_people')) as Person[]
}
export async function invited(challengeId: string): Promise<string[]> {
  const r = await supabase.from('challenge_invites').select('user_id').eq('challenge_id', challengeId)
  return r.error ? [] : (r.data as { user_id: string }[]).map((x) => x.user_id)
}
export async function invite(challengeId: string, userId: string, me: string) {
  const r = await supabase.from('challenge_invites').insert({ challenge_id: challengeId, user_id: userId, invited_by: me })
  if (r.error && !/duplicate/i.test(r.error.message)) throw new Error(/challenge_invites/.test(r.error.message) ? 'In-app invites need the invites SQL (0010) run in Supabase first.' : r.error.message)
}
export async function declineInvite(challengeId: string, userId: string) {
  await supabase.from('challenge_invites').delete().eq('challenge_id', challengeId).eq('user_id', userId)
}

export async function say(challengeId: string, userId: string, body: string) {
  check(await supabase.from('challenge_posts').insert({ challenge_id: challengeId, user_id: userId, body }))
}
export async function removePost(id: string) {
  check(await supabase.from('challenge_posts').delete().eq('id', id))
}
export async function kudo(postId: string, userId: string, on: boolean) {
  if (on) check(await supabase.from('challenge_kudos').insert({ post_id: postId, user_id: userId }))
  else check(await supabase.from('challenge_kudos').delete().eq('post_id', postId).eq('user_id', userId))
}

// ---------- Progress and streaks (worked out on the phone from the daily counts) ----------
export function periodKey(day: string, p: Period) {
  if (p === 'day') return day
  if (p === 'week') return ymd(weekStart(parse(day)))
  return day.slice(0, 7)
}
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6

/** This period's count for someone (today, this week or this month). */
export function current(c: Challenge, rows: DayCount[], userId: string) {
  const k = periodKey(ymd(today()), c.period)
  return rows.filter((r) => r.user_id === userId && periodKey(r.day, c.period) === k).reduce((s, r) => s + r.n, 0)
}

/**
 * Streak in a row:
 *  - Card a Day: days covered by a card (extra cards bank like on the Cards tab), every day counts.
 *  - Custom: periods that hit the goal; daily goals skip weekends. The current period only counts once it's hit.
 */
export function streak(c: Challenge, rows: DayCount[], userId: string) {
  const mine = rows.filter((r) => r.user_id === userId)
  const start = c.starts_on
  const t = today()
  if (c.kind === 'cards') {
    const fake: Card[] = mine.flatMap((r) => Array.from({ length: r.n }, (_, i) => ({ id: `${r.day}-${i}`, sent_on: r.day, counts_for_challenge: true }) as unknown as Card))
    const cov = cardCoverage(fake)
    let d = cov.has(ymd(t)) ? t : addDays(t, -1)
    let n = 0
    while (ymd(d) >= start && cov.has(ymd(d))) { n++; d = addDays(d, -1) }
    return n
  }
  const sums = new Map<string, number>()
  for (const r of mine) sums.set(periodKey(r.day, c.period), (sums.get(periodKey(r.day, c.period)) ?? 0) + r.n)
  const hit = (k: string) => (sums.get(k) ?? 0) >= c.target
  const step = (d: Date) => (c.period === 'day' ? addDays(d, -1) : c.period === 'week' ? addDays(weekStart(d), -1) : new Date(d.getFullYear(), d.getMonth(), 0, 12))
  let d = t
  if (c.period === 'day') while (isWeekend(d)) d = addDays(d, -1)
  if (!hit(periodKey(ymd(d), c.period))) d = step(d)
  let n = 0
  for (let guard = 0; guard < 400; guard++) {
    if (c.period === 'day') while (isWeekend(d)) d = addDays(d, -1)
    const k = periodKey(ymd(d), c.period)
    if (ymd(d) < start && !(c.period !== 'day' && k >= periodKey(start, c.period))) break
    if (!hit(k)) break
    n++
    d = step(d)
  }
  return n
}

export const unit = (p: Period, n: number) => (p === 'day' ? (n === 1 ? 'day' : 'days') : p === 'week' ? (n === 1 ? 'week' : 'weeks') : n === 1 ? 'month' : 'months')
export const per = (p: Period) => (p === 'day' ? 'a day' : p === 'week' ? 'a week' : 'a month')

/** "pop-bys", "calls or texts", "touches" for a custom challenge. */
export function noun(c: Challenge) {
  if (c.kind === 'cards') return 'cards'
  const names = c.counts.map((k) => COUNTABLE.find((x) => x[0] === k)?.[2] ?? k)
  return names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}
