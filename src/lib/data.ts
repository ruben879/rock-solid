import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { addDays, monthStart, today, weekStart, ymd } from './dates'
import type { Brokerage, Card, Contact, Profile, Tally, Tier, Touch, TouchKind } from './model'
import { cardWithin12Months, fullName } from './model'
import { exec, flush, getCached, isNetworkError, isOnline, pendingCount, setCached, subscribe, uuid, type AgentData } from './offline'
export type { AgentData } from './offline'

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

function stash<T>(k: string, v?: T): T | null {
  try {
    if (v !== undefined) { localStorage.setItem(k, JSON.stringify(v)); return v }
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** Your profile and brokerage. Falls back to the copy saved on the phone when offline. */
export async function loadMe(userId: string): Promise<{ profile: Profile | null; brokerage: Brokerage | null }> {
  const k = `rs-me-${userId}`
  try {
    const { data: profile, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', userId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!profile) return { profile: null, brokerage: null }
    const { data: brokerage } = await supabase.from('brokerages').select('id, name, settings').eq('id', profile.brokerage_id).maybeSingle()
    return stash(k, { profile: profile as Profile, brokerage: brokerage as Brokerage | null }) as { profile: Profile; brokerage: Brokerage | null }
  } catch (e) {
    const saved = stash<{ profile: Profile; brokerage: Brokerage | null }>(k)
    if (saved && isNetworkError(e)) return saved
    throw e
  }
}

export async function loadTeam(brokerageId: string) {
  const k = `rs-team-${brokerageId}`
  try {
    const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('brokerage_id', brokerageId).order('full_name')
    if (error) throw new Error(error.message)
    return stash(k, (data ?? []) as Profile[]) as Profile[]
  } catch (e) {
    const saved = stash<Profile[]>(k)
    if (saved && isNetworkError(e)) return saved
    throw e
  }
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

/**
 * Loads an agent's data. Shows the copy saved on the phone right away, sends any changes made offline,
 * then refreshes from the server. Offline, it keeps working from the saved copy.
 */
export function useAgentData(agentIds: string[]) {
  const key = agentIds.join(',')
  const [data, setData] = useState<AgentData | null>(() => (key ? getCached(key) : null))
  const [error, setError] = useState('')
  useEffect(() => {
    if (!key) return
    const c = getCached(key)
    if (c) setData(c)
    return subscribe(key, setData)
  }, [key])
  const reload = useCallback(async () => {
    if (!key) {
      setData({ contacts: [], touches: [], cards: [], tallies: [] })
      return
    }
    if (!isOnline()) {
      const c = getCached(key)
      if (c) { setData(c); setError(''); return }
    }
    try {
      if (pendingCount()) await flush()
      if (pendingCount() && !isOnline()) return
      const fresh = await loadAgentData(key.split(','))
      // Don't overwrite changes that are still waiting to be sent.
      if (!pendingCount()) setCached(key, fresh)
      else setData(getCached(key) ?? fresh)
      setError('')
    } catch (e) {
      const c = getCached(key)
      if (c && isNetworkError(e)) { setData(c); setError(''); return }
      setError((e as Error).message)
    }
  }, [key])
  useEffect(() => {
    reload()
    const again = () => { reload() }
    window.addEventListener('rs-synced', again)
    return () => window.removeEventListener('rs-synced', again)
  }, [reload])
  return { data, error, reload }
}

function needOnline() {
  if (!isOnline()) throw new Error("You're offline. This one needs a connection, so try again when you're back online")
}

// ---------- Mutations (agent acting on their own data) ----------
function check<T>(r: { data: T; error: { message: string } | null }) {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

export async function logTouch(me: Profile, contactId: string | null, kind: TouchKind, note?: string) {
  const row: Touch = { id: uuid(), agent_id: me.id, contact_id: contactId, kind, is_group: false, note: note || null, occurred_on: ymd(today()) }
  await exec(me.id, [{ t: 'insert', table: 'touches', rows: [{ ...row, brokerage_id: me.brokerage_id }] }])
  return row
}

/** Undo a logged touch. Also removes its Card a Day entry and resets the contact's last touch date. */
export async function deleteTouch(t: Touch, all: Touch[], cards: Card[]) {
  const key = t.agent_id
  const ops: Parameters<typeof exec>[1] = [{ t: 'delete', table: 'touches', id: t.id }]
  if (t.kind === 'card' && t.note?.startsWith('Card a Day: ')) {
    const name = t.note.slice('Card a Day: '.length)
    const card = cards.find((c) => c.sent_on === t.occurred_on && c.recipient_name === name)
    if (card) ops.push({ t: 'delete', table: 'cards', id: card.id })
  }
  if (t.contact_id) {
    const rest = all.filter((x) => x.contact_id === t.contact_id && x.id !== t.id).map((x) => x.occurred_on).sort().at(-1) ?? null
    ops.push({ t: 'update', table: 'contacts', id: t.contact_id, fields: { last_touch_on: rest } })
  }
  await exec(key, ops)
}

export async function updateTouch(me: Profile, id: string, fields: { kind?: TouchKind; note?: string | null }) {
  await exec(me.id, [{ t: 'update', table: 'touches', id, fields }])
}

export async function groupTouch(me: Profile, contacts: Contact[], kind: TouchKind, note = 'Group touch') {
  const rows = contacts.map((c) => ({ id: uuid(), agent_id: me.id, brokerage_id: me.brokerage_id, contact_id: c.id, kind, is_group: true, note, occurred_on: ymd(today()) }))
  const ops: Parameters<typeof exec>[1] = []
  for (let i = 0; i < rows.length; i += 500) ops.push({ t: 'insert', table: 'touches', rows: rows.slice(i, i + 500) })
  await exec(me.id, ops)
}

export async function skipToNextWeek(c: Contact) {
  await exec(c.agent_id, [{ t: 'update', table: 'contacts', id: c.id, fields: { skip_until: ymd(addDays(weekStart(), 7)) } }])
}

export type ContactInput = Partial<Omit<Contact, 'id' | 'agent_id' | 'brokerage_id'>> & { first_name: string }

/** Saves a person. Returns their id (new people get one right away, so they work offline too). */
export async function saveContact(me: Profile, input: ContactInput, id?: string) {
  if (id) {
    await exec(me.id, [{ t: 'update', table: 'contacts', id, fields: { ...input, updated_at: new Date().toISOString() } }])
    return id
  }
  const newId = uuid()
  await exec(me.id, [{
    t: 'insert', table: 'contacts',
    rows: [{ id: newId, added_on: ymd(today()), tier: 'U', prior_touches: 0, last_touch_on: null, skip_until: null, ...input, agent_id: me.id, brokerage_id: me.brokerage_id }],
  }])
  return newId
}

export async function deleteContact(me: Profile, id: string) {
  await exec(me.id, [{ t: 'delete', table: 'contacts', id }])
}

export async function importContacts(me: Profile, rows: ContactInput[]) {
  needOnline()
  const t = ymd(today())
  const payload = rows.map((r) => ({ ...r, tier: (r.tier ?? 'U') as Tier, agent_id: me.id, brokerage_id: me.brokerage_id, added_on: t }))
  for (let i = 0; i < payload.length; i += 500) check(await supabase.from('contacts').insert(payload.slice(i, i + 500)))
}

export async function updateContacts(list: { id: string; fields: Partial<Contact> }[]) {
  needOnline()
  const stamp = new Date().toISOString()
  for (let i = 0; i < list.length; i += 10) {
    const res = await Promise.all(list.slice(i, i + 10).map((u) => supabase.from('contacts').update({ ...u.fields, updated_at: stamp }).eq('id', u.id)))
    for (const r of res) check(r)
  }
}

export async function logCard(me: Profile, cards: Card[], contacts: Contact[], input: { name: string; relationship: string; occasion: string; note: string }) {
  const repeat = me.card_rule && !!cardWithin12Months(cards, input.name)
  const n = input.name.toLowerCase().replace(/\s+/g, ' ').trim()
  const match = contacts.find((c) => fullName(c).toLowerCase().replace(/\s+/g, ' ') === n)
  const card = {
    id: uuid(), agent_id: me.id, brokerage_id: me.brokerage_id, contact_id: match?.id ?? null,
    recipient_name: input.name.trim(), relationship: input.relationship, occasion: input.occasion,
    note: input.note || null, counts_for_challenge: !repeat, sent_on: ymd(today()),
  }
  const touch = { id: uuid(), agent_id: me.id, brokerage_id: me.brokerage_id, contact_id: match?.id ?? null, kind: 'card', is_group: false, note: `Card a Day: ${input.name.trim()}`, occurred_on: ymd(today()) }
  await exec(me.id, [{ t: 'insert', table: 'cards', rows: [card] }, { t: 'insert', table: 'touches', rows: [touch] }])
  return { repeat, match }
}

export async function bumpTally(me: Profile, tallies: Tally[], kind: string, delta: number) {
  const cur = tallies.find((t) => t.kind === kind)?.count ?? 0
  await setTally(me, kind, cur + delta)
}

export async function setTally(me: Profile, kind: string, count: number) {
  const row = { agent_id: me.id, brokerage_id: me.brokerage_id, month: ymd(monthStart()), kind, count: Math.max(0, count) }
  await exec(me.id, [{ t: 'upsert', table: 'tallies', row, onConflict: 'agent_id,month,kind' }])
}

export async function updateMyProfile(me: Profile, fields: Partial<Pick<Profile, 'daily_goal' | 'weekly_goal' | 'card_rule' | 'tier_days' | 'plan' | 'full_name'>>) {
  needOnline()
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

/** Email an invited person their sign-in code and link. Doesn't touch the sender's own sign-in. */
export async function sendInviteEmail(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: window.location.origin } })
  if (error) throw new Error(error.message.toLowerCase().includes('rate') ? 'Too many emails just went out. Wait a minute and try again.' : error.message)
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
