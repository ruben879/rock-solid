import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { admin } from './_push.js'
import { matchRows, toEntryRow, type CheckItem, type Existing } from '../src/lib/matching.js'
import { agentName, consentLine, TOKEN_RE } from '../src/lib/entryPage.js'

// The hosted entry page's server side. Public: anyone with an agent's link can call it.
// GET  /api/enter?token=…  → what the page shows (brokerage, agent first name + last initial, label). No ids, no emails.
// POST /api/enter          → one entry. Stored in entry_submissions first, then matched with the same engine as the
//                            Entry form import, owned by the page's agent. Nothing from the request goes straight to contacts.

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown; query?: Record<string, string | string[] | undefined> }
type Res = { status: (n: number) => { json: (b: unknown) => void }; setHeader: (k: string, v: string) => void }
type Page = { agent_id: string; brokerage_id: string; label: string }
type Sub = { id: string; agent_id: string; brokerage_id: string; label: string; full_name: string; email: string | null; phone: string | null; street: string | null; city: string | null; state: string | null; zip: string | null }

const HOURLY_LIMIT = 5
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const db = admin()
    if (req.method === 'GET') {
      const page = await pageFor(db, one(req.query?.token))
      if (!page) return res.status(404).json({ inactive: true })
      const [{ data: p }, { data: b }] = await Promise.all([
        db.from('profiles').select('full_name').eq('id', page.agent_id).maybeSingle(),
        db.from('brokerages').select('name, settings').eq('id', page.brokerage_id).maybeSingle(),
      ])
      const n = agentName((p as { full_name: string | null } | null)?.full_name)
      const settings = ((b as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
      const logo = typeof settings.logo_url === 'string' && /^https:\/\//.test(settings.logo_url) ? settings.logo_url : null
      return res.status(200).json({ brokerage: (b as { name?: string } | null)?.name ?? '', logo, agent: n.shown, first: n.first, label: page.label })
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' })

    const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body ?? {}) as Record<string, unknown>
    const page = await pageFor(db, str(body.token, 80))
    if (!page) return res.status(404).json({ inactive: true })
    // Honeypot: people never see this field, so anything in it is a bot. Same thank-you, nothing stored.
    if (str(body.website)) return res.status(200).json({ ok: true })
    const f = { name: str(body.name, 120), email: str(body.email, 200), phone: str(body.phone, 40), street: str(body.street), city: str(body.city, 80), state: str(body.state, 40), zip: str(body.zip, 20) }
    if (!f.name) return res.status(400).json({ error: 'Please add your name.' })
    if (!toEntryRow(1, f)) return res.status(400).json({ error: 'Please add an email or a phone number so we can reach you.' })

    // 5 entries an hour from one connection. Past that: the same thank-you, nothing stored.
    const ipHash = hashIp(clientIp(req))
    const since = new Date(Date.now() - 3600e3).toISOString()
    const { count, error: cErr } = await db.from('entry_submissions').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('submitted_at', since)
    if (cErr) throw new Error(cErr.message)
    if ((count ?? 0) >= HOURLY_LIMIT) return res.status(200).json({ ok: true })

    const { data: p } = await db.from('profiles').select('full_name').eq('id', page.agent_id).maybeSingle()
    const ins = await db.from('entry_submissions').insert({
      id: randomUUID(), brokerage_id: page.brokerage_id, agent_id: page.agent_id, label: page.label,
      full_name: f.name, email: f.email || null, phone: f.phone || null, street: f.street || null, city: f.city || null, state: f.state || null, zip: f.zip || null,
      consent: true, consent_text: consentLine(agentName((p as { full_name: string | null } | null)?.full_name).first), ip_hash: ipHash,
    })
    if (ins.error) throw new Error(ins.error.message)
    // The entry is safe in staging. Matching problems never show to the person entering; anything left waiting
    // is picked up on the next entry to this agent's page.
    try { await processWaiting(db, page.agent_id) } catch (e) { console.error('entry processing:', (e as Error).message) }
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('enter:', (e as Error).message)
    return res.status(500).json({ error: "Something went wrong on our end. Please try again in a minute." })
  }
}

const safeJson = (s: string) => { try { return JSON.parse(s || '{}') } catch { return {} } }

async function pageFor(db: SupabaseClient, token: string): Promise<Page | null> {
  if (!TOKEN_RE.test(token)) return null
  const { data, error } = await db.from('entry_pages').select('agent_id, brokerage_id, label').eq('token', token).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Page | null) ?? null
}

function clientIp(req: Req) {
  return one(req.headers['x-forwarded-for']).split(',')[0].trim() || one(req.headers['x-real-ip']).trim() || 'unknown'
}
function hashIp(ip: string) {
  const salt = (process.env.ENTRY_IP_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex')
}
const todayCentral = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

/** Matches every waiting entry for this agent, oldest first. */
export async function processWaiting(db: SupabaseClient, agentId: string) {
  const { data, error } = await db.from('entry_submissions')
    .select('id, agent_id, brokerage_id, label, full_name, email, phone, street, city, state, zip')
    .eq('agent_id', agentId).is('processed_at', null).order('submitted_at').limit(25)
  if (error) throw new Error(error.message)
  for (const s of (data ?? []) as Sub[]) await processOne(db, s)
}

async function processOne(db: SupabaseClient, s: Sub) {
  // Claim it, so two entries arriving together never process the same one twice.
  const claimed = await db.from('entry_submissions').update({ processed_at: new Date().toISOString() }).eq('id', s.id).is('processed_at', null).select('id')
  if (claimed.error) throw new Error(claimed.error.message)
  if (!claimed.data?.length) return
  try {
    const row = toEntryRow(1, { name: s.full_name, email: s.email ?? '', phone: s.phone ?? '', street: s.street ?? '', city: s.city ?? '', state: s.state ?? '', zip: s.zip ?? '' })
    if (!row) { await db.from('entry_submissions').update({ outcome: null }).eq('id', s.id); return }
    const batch = await openBatch(db, s)
    const plan = matchRows([row], await ownerContacts(db, s.agent_id))
    let outcome: 'created' | 'updated' | 'duplicate' | 'check' = 'duplicate'
    let contactId: string | null = null
    if (plan.create.length) {
      contactId = randomUUID()
      const c = await db.from('contacts').insert({
        id: contactId, agent_id: s.agent_id, brokerage_id: s.brokerage_id, first_name: row.first_name, last_name: row.last_name,
        email: row.email, phone: row.phone, address: row.address, city: row.city, state: row.state, zip: row.zip,
        tier: 'U', sphere: 'client', source: s.label, added_on: todayCentral(), prior_touches: 0, import_batch_id: batch,
      })
      if (c.error) throw new Error(c.error.message)
      outcome = 'created'
      await bump(db, batch, 1, null, null, 0)
    }
    for (const u of plan.updates) {
      contactId = u.contactId
      // Fill only what's still blank right now (same rule as import_gap_fill).
      const { data: cur } = await db.from('contacts').select('email, phone, address, city, state, zip').eq('id', u.contactId).eq('agent_id', s.agent_id).maybeSingle()
      if (!cur) continue
      const fill: Record<string, string> = {}
      for (const [k, v] of Object.entries(u.fields)) if (!String((cur as Record<string, unknown>)[k] ?? '').trim() && v) fill[k] = v
      if (Object.keys(fill).length) {
        const up = await db.from('contacts').update({ ...fill, updated_at: new Date().toISOString() }).eq('id', u.contactId).eq('agent_id', s.agent_id)
        if (up.error) throw new Error(up.error.message)
      }
      outcome = 'updated'
    }
    if (plan.checks.length) {
      const ins = await db.from('import_checks').insert(plan.checks.map((c) => checkRow(batch, s, c)))
      if (ins.error) throw new Error(ins.error.message)
      outcome = 'check'
      contactId ??= plan.checks[0].kind === 'field' ? plan.checks[0].contactId : null
    }
    if (plan.updates.length || plan.checks.length)
      await bump(db, batch, 0, null, plan.updates[0] ? { name: plan.updates[0].name, fields: Object.keys(plan.updates[0].fields) } : null, plan.checks.length)
    if (plan.duplicates.length) await bump(db, batch, 0, plan.duplicates[0].key, null, 0)
    const done = await db.from('entry_submissions').update({ batch_id: batch, outcome, contact_id: contactId }).eq('id', s.id)
    if (done.error) throw new Error(done.error.message)
  } catch (e) {
    await db.from('entry_submissions').update({ processed_at: null }).eq('id', s.id) // try again on the next entry
    throw e
  }
}

/** The agent's open entry page batch for this label, or a new one. A different label closes the old batch first. */
async function openBatch(db: SupabaseClient, s: Sub): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.from('imports').select('id, source_label').eq('agent_id', s.agent_id).eq('via', 'entry_page').eq('closed', false).maybeSingle()
    if (error) throw new Error(error.message)
    const open = data as { id: string; source_label: string } | null
    if (open && open.source_label === s.label) return open.id
    if (open) await db.from('imports').update({ closed: true }).eq('id', open.id)
    const id = randomUUID()
    const ins = await db.from('imports').insert({
      id, brokerage_id: s.brokerage_id, agent_id: s.agent_id, imported_by: s.agent_id, source_label: s.label, via: 'entry_page',
      imported: 0, duplicates: 0, errors: 0, details: { errorRows: [], duplicates: [], updated: [], checks: 0 },
    })
    if (!ins.error) return id
    if (ins.error.code !== '23505') throw new Error(ins.error.message) // someone else just opened it: look again
  }
  throw new Error('Could not open an entry batch')
}

async function ownerContacts(db: SupabaseClient, agentId: string): Promise<Existing[]> {
  const out: Existing[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('contacts').select('id, first_name, last_name, email, phone, address, city, state, zip').eq('agent_id', agentId).order('id').range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Existing[]))
    if (!data || data.length < 1000) return out
  }
}

async function bump(db: SupabaseClient, batch: string, imported: number, duplicate: string | null, updated: unknown, checks: number) {
  const r = await db.rpc('entry_batch_add', { p_batch: batch, p_imported: imported, p_duplicate: duplicate, p_updated: updated, p_checks: checks })
  if (r.error) throw new Error(r.error.message)
}

function checkRow(importId: string, s: Sub, c: CheckItem) {
  const base = { id: randomUUID(), status: 'pending', import_id: importId, brokerage_id: s.brokerage_id, agent_id: s.agent_id, entry_snapshot: c.snapshot }
  return c.kind === 'field'
    ? { ...base, contact_id: c.contactId, field: c.field, existing_value: c.existing, entry_value: c.entry }
    : { ...base, contact_id: c.emailContactId, contact_id_2: c.phoneContactId, field: null }
}
