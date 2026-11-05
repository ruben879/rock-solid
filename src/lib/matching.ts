// The matching engine shared by both imports (My contact list, Entry form) and the hosted entry page.
// No imports on purpose: the app and the server (api/enter.ts) run this exact file.

const digits = (s: string) => s.replace(/\D/g, '')
/** Email match key: trimmed, lowercase. Phone match key: digits only, last 10. */
export const emailKey = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
export const phoneKey = (s: string | null | undefined) => digits(s ?? '').slice(-10)

export type EntryRow = {
  row: number; first_name: string; last_name: string; email: string | null; phone: string | null
  address: string | null; city: string | null; state: string | null; zip: string | null
}

// ---------- The matching engine (both import modes) ----------
export const MATCH_FIELDS = ['email', 'phone', 'address', 'city', 'state', 'zip'] as const
export type MatchField = (typeof MATCH_FIELDS)[number]
/** A contact the Owning agent already has (any sphere). */
export type Existing = { id: string; first_name: string; last_name: string } & Record<MatchField, string | null>
export type CheckItem =
  | { kind: 'field'; row: number; contactId: string; field: MatchField; existing: string; entry: string; snapshot: Record<string, unknown> }
  | { kind: 'ambiguous'; row: number; emailContactId: string; phoneContactId: string; snapshot: Record<string, unknown> }
export type MatchPlan<R> = {
  create: R[]
  updates: { row: number; contactId: string; name: string; fields: Partial<Record<MatchField, string>> }[]
  duplicates: { row: number; key: string }[]
  checks: CheckItem[]
}

const blank = (v: string | null | undefined) => !(v ?? '').trim()
/** Two values are the same after the matching normalization (email lowercase, phone last 10 digits, the rest trimmed and case-insensitive). */
export function sameValue(field: MatchField, a: string | null | undefined, b: string | null | undefined) {
  if (field === 'email') return emailKey(a) === emailKey(b)
  if (field === 'phone') return phoneKey(a) === phoneKey(b)
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}
/** What a row would fill (blank on the contact) and where it disagrees (filled and different). Names never change. */
export function compareRow(row: Partial<Record<MatchField, string | null>>, c: Partial<Record<MatchField, string | null>>) {
  const fills: Partial<Record<MatchField, string>> = {}
  const conflicts: { field: MatchField; existing: string; entry: string }[] = []
  for (const f of MATCH_FIELDS) {
    const v = row[f]
    if (blank(v)) continue
    if (blank(c[f])) fills[f] = (v as string).trim()
    else if (!sameValue(f, c[f], v)) conflicts.push({ field: f, existing: (c[f] as string), entry: (v as string).trim() })
  }
  return { fills, conflicts }
}

/**
 * Sorts rows against the Owning agent's contacts, in file order:
 * no match → create; one match → gap-fill blanks and a Check item per conflicting field (all equal → Duplicate);
 * email and phone matching two different people → one ambiguous Check item. A match on an earlier row of the same
 * file is a Duplicate. Optional nameFallback (My contact list only): a row with no email or phone match whose full
 * name matches someone is skipped as a Duplicate instead of creating a second copy of them.
 */
export function matchRows<R extends { row: number; first_name: string; last_name: string } & Partial<Record<MatchField, string | null>>>(
  rows: R[], existing: Existing[], opts: { nameFallback?: boolean } = {},
): MatchPlan<R> {
  const plan: MatchPlan<R> = { create: [], updates: [], duplicates: [], checks: [] }
  // Working copies, so a value filled by one row counts for the rows after it.
  const people = existing.map((c) => ({ ...c, fromFile: false }))
  type P = (typeof people)[number]
  const byEmail = new Map<string, P[]>()
  const byPhone = new Map<string, P[]>()
  const byName = new Map<string, P>()
  const add = (m: Map<string, P[]>, k: string, c: P) => { if (!k) return; const l = m.get(k) ?? []; if (!l.includes(c)) l.push(c); m.set(k, l) }
  const index = (c: P) => {
    add(byEmail, emailKey(c.email), c)
    add(byPhone, phoneKey(c.phone), c)
    const n = `${c.first_name} ${c.last_name}`.trim().toLowerCase().replace(/\s+/g, ' '); if (n && !byName.has(n)) byName.set(n, c)
  }
  people.forEach(index)
  const updated = new Map<string, MatchPlan<R>['updates'][number]>()
  for (const r of rows) {
    const e = emailKey(r.email)
    const p = phoneKey(r.phone)
    const me = e ? byEmail.get(e)?.[0] : undefined
    const phones = p ? byPhone.get(p) ?? [] : []
    // When the email's person also has this phone, that's the match (even if someone else shares the phone).
    const mp = me && phones.includes(me) ? me : phones[0]
    const snapshot = { ...r } as Record<string, unknown>
    if (me && mp && me !== mp) {
      if (me.fromFile || mp.fromFile) { plan.duplicates.push({ row: r.row, key: r.email || r.phone || '' }); continue }
      plan.checks.push({ kind: 'ambiguous', row: r.row, emailContactId: me.id, phoneContactId: mp.id, snapshot })
      continue
    }
    let c = me ?? mp
    if (!c && opts.nameFallback) {
      const n = `${r.first_name} ${r.last_name}`.trim().toLowerCase().replace(/\s+/g, ' ')
      const hit = byName.get(n)
      if (hit) { plan.duplicates.push({ row: r.row, key: `${r.first_name} ${r.last_name}`.trim() }); continue }
    }
    if (!c) {
      plan.create.push(r)
      const mine = { id: `row-${r.row}`, first_name: r.first_name, last_name: r.last_name, email: r.email ?? null, phone: r.phone ?? null, address: r.address ?? null, city: r.city ?? null, state: r.state ?? null, zip: r.zip ?? null, fromFile: true }
      people.push(mine); index(mine)
      continue
    }
    if (c.fromFile) { plan.duplicates.push({ row: r.row, key: (me ? r.email : r.phone) || '' }); continue }
    const { fills, conflicts } = compareRow(r, c)
    if (!Object.keys(fills).length && !conflicts.length) { plan.duplicates.push({ row: r.row, key: (me ? r.email : r.phone) || '' }); continue }
    if (Object.keys(fills).length) {
      const u = updated.get(c.id) ?? { row: r.row, contactId: c.id, name: `${c.first_name} ${c.last_name}`.trim(), fields: {} }
      Object.assign(u.fields, fills); updated.set(c.id, u)
      Object.assign(c, fills); index(c)
    }
    for (const x of conflicts) plan.checks.push({ kind: 'field', row: r.row, contactId: c.id, field: x.field, existing: x.existing, entry: x.entry, snapshot })
  }
  plan.updates = [...updated.values()]
  return plan
}

/** One entry (from a CSV row or the hosted entry page), or null when it can't become a contact: no name, or no email and no phone. */
export function toEntryRow(row: number, f: { name: string; email?: string; phone?: string; street?: string; city?: string; state?: string; zip?: string }): EntryRow | null {
  const name = (f.name ?? '').trim()
  const email = (f.email ?? '').trim()
  const phone = (f.phone ?? '').trim()
  if (!name || (!email && !phoneKey(phone))) return null
  const parts = name.split(/\s+/)
  return {
    row, first_name: parts[0], last_name: parts.slice(1).join(' '), email: email || null, phone: phone || null,
    address: (f.street ?? '').trim() || null, city: (f.city ?? '').trim() || null, state: (f.state ?? '').trim() || null, zip: (f.zip ?? '').trim() || null,
  }
}
