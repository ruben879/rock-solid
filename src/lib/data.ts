import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { addDays, monthStart, today, weekStart, ymd } from './dates'
import type { Brokerage, Card, Contact, Profile, Tally, Tier, Touch, TouchKind } from './model'
import { cardWithin12Months, fullName } from './model'

const PROFILE_COLS = 'id, brokerage_id, full_name, email, role, coach_id, tier_days, daily_goal, weekly_goal, card_rule, plan'

/** Supabase returns at most 1000 rows per request; page through larger results. */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

export async function loadMe(userId: string) {
  const { data: profile } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', userId).maybeSingle()
  if (!profile) return { profile: null, brokerage: null }
  const { data: brokerage } = await supabase.from('brokerages').select('id, name, settings').eq('id', profile.brokerage_id).maybeSingle()
  return { profile: profile as Profile, brokerage: brokerage as Brokerage | null }
}

export async function loadTeam(brokerageId: string) {
  const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('brokerage_id', brokerageId).order('full_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Profile[]
}

export interface AgentData {
  contacts: Contact[]
  touches: Touch[]
  cards: Card[]
  tallies: Tally[]
}

export async function loadAgentData(agentIds: string[]): Promise<AgentData> {
  const since = ymd(addDays(today(), -400))
  const [contacts, touches, cards, tallies] = await Promise.all([
    fetchAll<Contact>((a, b) => supabase.from('contacts').select('*').in('agent_id', agentIds).order('last_name').range(a, b)),
    fetchAll<Touch>((a, b) =>
      supabase.from('touches').select('id, agent_id, contact_id, kind, is_group, note, occurred_on, created_at').in('agent_id', agentIds).gte('occurred_on', since).order('occurred_on').range(a, b),
    ),
    fetchAll<Card>((a, b) => supabase.from('cards').select('*').in('agent_id', agentIds).gte('sent_on', since).order('sent_on').range(a, b)),
    fetchAll<Tally>((a, b) => supabase.from('tallies').select('agent_id, month, kind, count').in('agent_id', agentIds).eq('month', ymd(monthStart())).range(a, b)),
  ])
  return { contacts, touches, cards, tallies }
}

export function useAgentData(agentIds: string[]) {
  const key = agentIds.join(',')
  const [data, setData] = useState<AgentData | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    if (!key) {
      setData({ contacts: [], touches: [], cards: [], tallies: [] })
      return
    }
    try {
      setData(await loadAgentData(key.split(',')))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [key])
  useEffect(() => {
    reload()
  }, [reload])
  return { data, error, reload }
}

// ---------- Mutations (agent acting on their own data) ----------
function check<T>(r: { data: T; error: { message: string } | null }) {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

export async function logTouch(me: Profile, contactId: string | null, kind: TouchKind, note?: string) {
  return check(
    await supabase.from('touches').insert({ agent_id: me.id, brokerage_id: me.brokerage_id, contact_id: contactId, kind, note: note || null, occurred_on: ymd(today()) }).select('id, agent_id, contact_id, kind, is_group, note, occurred_on').single(),
  ) as Touch
}

/** Undo a logged touch. Also removes its Card a Day entry and resets the contact's last touch date. */
export async function deleteTouch(t: Touch, all: Touch[], cards: Card[]) {
  check(await supabase.from('touches').delete().eq('id', t.id))
  if (t.kind === 'card' && t.note?.startsWith('Card a Day: ')) {
    const name = t.note.slice('Card a Day: '.length)
    const card = cards.find((c) => c.sent_on === t.occurred_on && c.recipient_name === name)
    if (card) check(await supabase.from('cards').delete().eq('id', card.id))
  }
  if (t.contact_id) {
    const rest = all.filter((x) => x.contact_id === t.contact_id && x.id !== t.id).map((x) => x.occurred_on).sort().at(-1) ?? null
    check(await supabase.from('contacts').update({ last_touch_on: rest }).eq('id', t.contact_id))
  }
}

export async function updateTouch(id: string, fields: { kind?: TouchKind; note?: string | null }) {
  check(await supabase.from('touches').update(fields).eq('id', id))
}

export async function groupTouch(me: Profile, contacts: Contact[], kind: TouchKind, note = 'Group touch') {
  const rows = contacts.map((c) => ({ agent_id: me.id, brokerage_id: me.brokerage_id, contact_id: c.id, kind, is_group: true, note, occurred_on: ymd(today()) }))
  for (let i = 0; i < rows.length; i += 500) check(await supabase.from('touches').insert(rows.slice(i, i + 500)))
}

export async function skipToNextWeek(c: Contact) {
  check(await supabase.from('contacts').update({ skip_until: ymd(addDays(weekStart(), 7)) }).eq('id', c.id))
}

export type ContactInput = Partial<Omit<Contact, 'id' | 'agent_id' | 'brokerage_id'>> & { first_name: string }

export async function saveContact(me: Profile, input: ContactInput, id?: string) {
  if (id) check(await supabase.from('contacts').update({ ...input, updated_at: new Date().toISOString() }).eq('id', id))
  else check(await supabase.from('contacts').insert({ added_on: ymd(today()), ...input, agent_id: me.id, brokerage_id: me.brokerage_id }))
}

export async function deleteContact(id: string) {
  check(await supabase.from('contacts').delete().eq('id', id))
}

export async function importContacts(me: Profile, rows: ContactInput[]) {
  const t = ymd(today())
  const payload = rows.map((r) => ({ ...r, tier: (r.tier ?? 'U') as Tier, agent_id: me.id, brokerage_id: me.brokerage_id, added_on: t }))
  for (let i = 0; i < payload.length; i += 500) check(await supabase.from('contacts').insert(payload.slice(i, i + 500)))
}

export async function logCard(me: Profile, cards: Card[], contacts: Contact[], input: { name: string; relationship: string; occasion: string; note: string }) {
  const repeat = me.card_rule && !!cardWithin12Months(cards, input.name)
  const n = input.name.toLowerCase().replace(/\s+/g, ' ').trim()
  const match = contacts.find((c) => fullName(c).toLowerCase().replace(/\s+/g, ' ') === n)
  check(
    await supabase.from('cards').insert({
      agent_id: me.id,
      brokerage_id: me.brokerage_id,
      contact_id: match?.id ?? null,
      recipient_name: input.name.trim(),
      relationship: input.relationship,
      occasion: input.occasion,
      note: input.note || null,
      counts_for_challenge: !repeat,
      sent_on: ymd(today()),
    }),
  )
  await logTouch(me, match?.id ?? null, 'card', `Card a Day: ${input.name.trim()}`)
  return { repeat, match }
}

export async function bumpTally(me: Profile, tallies: Tally[], kind: string, delta: number) {
  const month = ymd(monthStart())
  const cur = tallies.find((t) => t.kind === kind)?.count ?? 0
  check(
    await supabase
      .from('tallies')
      .upsert({ agent_id: me.id, brokerage_id: me.brokerage_id, month, kind, count: Math.max(0, cur + delta) }, { onConflict: 'agent_id,month,kind' }),
  )
}

export async function setTally(me: Profile, kind: string, count: number) {
  check(await supabase.from('tallies').upsert({ agent_id: me.id, brokerage_id: me.brokerage_id, month: ymd(monthStart()), kind, count: Math.max(0, count) }, { onConflict: 'agent_id,month,kind' }))
}

export async function updateMyProfile(me: Profile, fields: Partial<Pick<Profile, 'daily_goal' | 'weekly_goal' | 'card_rule' | 'tier_days' | 'plan' | 'full_name'>>) {
  check(await supabase.from('profiles').update(fields).eq('id', me.id))
}

// ---------- Broker actions ----------
export interface Invite {
  email: string
  full_name: string | null
  role: 'agent' | 'coach' | 'broker'
  coach_email: string | null
}

export async function loadInvites() {
  const { data, error } = await supabase.from('invites').select('email, full_name, role, coach_email').order('full_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Invite[]
}

export async function addInvite(me: Profile, inv: Invite) {
  check(
    await supabase.from('invites').upsert({
      ...inv,
      email: inv.email.trim().toLowerCase(),
      coach_email: inv.coach_email ? inv.coach_email.trim().toLowerCase() : null,
      brokerage_id: me.brokerage_id,
    }),
  )
}

export async function removeInvite(email: string) {
  check(await supabase.from('invites').delete().eq('email', email))
}

export async function setCoach(agentId: string, coachId: string | null) {
  check(await supabase.from('profiles').update({ coach_id: coachId }).eq('id', agentId))
}

export async function setRole(agentId: string, role: 'agent' | 'coach' | 'broker') {
  check(await supabase.from('profiles').update({ role }).eq('id', agentId))
}

/** Drawing entries: one per individual touch logged this month, plus one per extra (social post, giveaway, newsletter, etc.). */
export async function loadDrawingEntries(month: string) {
  const [{ data, error }, extras] = await Promise.all([
    supabase.from('drawing_entries').select('agent_id, entries').eq('month', month),
    fetchAll<Tally>((a, b) => supabase.from('tallies').select('agent_id, month, kind, count').eq('month', month).range(a, b)),
  ])
  if (error) throw new Error(error.message)
  const by = new Map<string, number>()
  for (const r of (data ?? []) as { agent_id: string; entries: number }[]) by.set(r.agent_id, (by.get(r.agent_id) ?? 0) + Number(r.entries))
  for (const t of extras) by.set(t.agent_id, (by.get(t.agent_id) ?? 0) + t.count)
  return [...by].map(([agent_id, entries]) => ({ agent_id, entries }))
}

export interface Drawing {
  id: string
  month: string
  prize_dollars: number
  winner_id: string | null
  winner_entries: number | null
  total_entries: number | null
}

export async function loadDrawings(month: string) {
  const { data, error } = await supabase.from('drawings').select('id, month, prize_dollars, winner_id, winner_entries, total_entries').eq('month', month).order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as Drawing[]
}

export async function saveDrawing(me: Profile, d: Omit<Drawing, 'id'>) {
  check(await supabase.from('drawings').insert({ ...d, brokerage_id: me.brokerage_id, created_by: me.id }))
}

export async function clearDrawings(month: string) {
  check(await supabase.from('drawings').delete().eq('month', month))
}
