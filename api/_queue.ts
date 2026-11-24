import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays, today, ymd } from '../src/lib/dates.js'
import { freshQueue } from '../src/lib/todayQueue.js'
import type { Contact, Profile, Touch } from '../src/lib/model.js'

// Same profile fields and the same 400 days of touches the app loads, so the list comes out the same.
const PROFILE_COLS = 'id, brokerage_id, full_name, email, role, coach_id, tier_days, daily_goal, weekly_goal, card_rule, plan'
async function all<T>(page: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let a = 0; ; a += 1000) {
    const { data, error } = await page(a, a + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < 1000) return out
  }
}

/**
 * The people waiting on this person's Today list right now, in Today order. If their phone already shared today's
 * list, that's it. If not (most mornings, before the app is opened), it's worked out with the same rules the phone
 * uses on its first open of the day, starting from the last list the phone shared.
 * Needs process.env.TZ = 'America/Chicago' (set by the caller) so "today" is the Lubbock day.
 */
export async function queueFor(db: SupabaseClient, uid: string, day: string): Promise<Contact[]> {
  const shared = await db.from('today_queues').select('day, ids, queue').eq('agent_id', uid).maybeSingle()
  const row = shared.error ? null : (shared.data as { day: string; ids: string[]; queue: string[] } | null)
  const contacts = await all<Contact>((a, b) => db.from('contacts').select('*').eq('agent_id', uid).order('last_name').range(a, b))
  const byId = new Map(contacts.map((c) => [c.id, c]))
  if (row && row.day === day) return row.queue.map((id) => byId.get(id)).filter((c): c is Contact => !!c)
  const since = ymd(addDays(today(), -400))
  const [touches, profile] = await Promise.all([
    all<Touch>((a, b) => db.from('touches').select('id, agent_id, contact_id, kind, is_group, note, occurred_on, created_at').eq('agent_id', uid).gte('occurred_on', since).order('occurred_on').range(a, b)),
    db.from('profiles').select(PROFILE_COLS).eq('id', uid).single(),
  ])
  if (profile.error) throw new Error(profile.error.message)
  const ids = freshQueue(contacts, touches, profile.data as Profile, row ? { day: row.day, ids: row.ids } : null)
  return ids.map((id) => byId.get(id)!).filter(Boolean)
}
