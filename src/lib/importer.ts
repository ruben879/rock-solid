import type { Tier } from './model'

export type ImportRow = {
  first_name: string; last_name: string; phone: string | null; email: string | null
  address: string | null; city: string | null; state: string | null; zip: string | null
  tier: Tier | null; birthday: string | null; home_anniversary: string | null; wedding_anniversary?: string
}

/** Every record in the file, blank rows included, so row numbers match the spreadsheet. */
export function csvRecords(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

const digits = (s: string) => s.replace(/\D/g, '')

export function formatPhone(raw: string): string | null {
  const d = digits(raw)
  if (!d) return null
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : raw.trim()
}

export function toDate(v: string): string | null {
  const s = v.trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? (Number(m[3]) > 30 ? `19${m[3]}` : `20${m[3]}`) : m[3]
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  // Month and day only (6/12): saved without a year.
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (m) return `1904-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

/**
 * Reads a CSV (BoldTrail exports included) into contact rows.
 * Each field has a list of column names in priority order; exact header matches win,
 * and for each person the first non-empty column is used (so an empty Work Phone falls through to Cell Phone 1).
 */
export function readContacts(text: string): ImportRow[] {
  const all = parseCsv(text.replace(/^﻿/, ''))
  if (all.length < 2) return []
  const head = all[0].map((h) => h.toLowerCase().trim())
  const cols = (...names: string[]) => {
    const out: number[] = []
    for (const n of names) head.forEach((h, i) => { if (h === n && !out.includes(i)) out.push(i) })
    return out
  }
  const C = {
    first: cols('first name', 'first', 'firstname', 'given name'),
    last: cols('last name', 'last', 'lastname', 'surname', 'family name'),
    name: cols('name', 'full name', 'contact name'),
    phone: cols('cell phone 1', 'cell phone', 'mobile phone', 'mobile', 'cell', 'phone', 'phone number', 'primary phone', 'home phone', 'cell phone 2', 'work phone'),
    email: cols('email', 'email address', 'primary email', 'e-mail', 'second email'),
    address: cols('primary address', 'address', 'street address', 'street', 'address 1', 'mailing address'),
    city: cols('primary city', 'city', 'town'),
    state: cols('primary state', 'state', 'province'),
    zip: cols('primary zip', 'zip', 'zip code', 'postal code', 'zipcode'),
    tier: cols('tier', 'tag', 'category', 'group'),
    tags: cols('hashtags', 'tags'),
    birthday: cols('birthday', 'birth date', 'date of birth'),
    anniv: cols('home anniversary', 'last closing date', 'closing date', 'purchase date'),
    wedding: cols('wedding anniversary', 'anniversary', 'anniversary date', 'wedding date'),
  }
  const out: ImportRow[] = []
  for (const r of all.slice(1)) {
    const get = (list: number[]) => { for (const i of list) { const v = (r[i] ?? '').trim(); if (v) return v } return '' }
    let first = get(C.first)
    let last = get(C.last)
    if (!first && C.name.length) {
      const parts = get(C.name).split(/\s+/)
      first = parts.shift() ?? ''
      last = parts.join(' ')
    }
    if (!first) continue
    const tierRaw = get(C.tier).toUpperCase().trim()
    const tagTier = get(C.tags).toUpperCase().split(/[\s,;]+/).find((t) => ['A', 'B', 'C', 'D'].includes(t))
    const raw = ['A', 'B', 'C', 'D'].includes(tierRaw) ? tierRaw : tagTier ?? null
    const tier = (raw === 'C' || raw === 'D' ? 'B' : raw) as Tier | null
    const phone = get(C.phone)
    out.push({
      first_name: first, last_name: last,
      phone: phone ? formatPhone(phone) : null,
      email: get(C.email).toLowerCase() || null,
      address: get(C.address) || null, city: get(C.city) || null, state: get(C.state) || null, zip: get(C.zip) || null,
      tier, birthday: toDate(get(C.birthday)), home_anniversary: toDate(get(C.anniv)),
      ...(toDate(get(C.wedding)) ? { wedding_anniversary: toDate(get(C.wedding)) as string } : {}),
    })
  }
  return out
}

// ---------- Entry form imports (giveaway forms and the like) ----------
// The CSV contract: these headers (case-insensitive, trimmed), with the Google Form titles as aliases. Other columns are ignored.
const ENTRY_COLS = {
  name: ['full_name', 'full name'],
  email: ['email'],
  phone: ['phone'],
  street: ['street', 'mailing street address'],
  city: ['city'],
  state: ['state'],
  zip: ['zip'],
} as const

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

export type EntryPlan = MatchPlan<EntryRow> & {
  /** Required columns missing entirely (name, email or phone). Nothing imports when any are missing. */
  missing: string[]
  errors: number[]
  /** New people this import creates (the same as create). */
  rows: EntryRow[]
}
/** Email match key: trimmed, lowercase. Phone match key: digits only, last 10. */
export const emailKey = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
export const phoneKey = (s: string | null | undefined) => digits(s ?? '').slice(-10)

/**
 * Reads an entry form CSV and sorts every row into Imported, Duplicate or Error row.
 * Row numbers count the header as row 1. A Duplicate matches a contact the Owning agent already has,
 * or an earlier row in the same file, by email or phone.
 */
export function planEntryImport(text: string, existing: Existing[]): EntryPlan {
  const records = csvRecords(text.replace(/^\uFEFF/, ''))
  const head = (records[0] ?? []).map((h) => h.trim().toLowerCase())
  const idx = (names: readonly string[]) => head.findIndex((h) => names.includes(h))
  const at = { name: idx(ENTRY_COLS.name), email: idx(ENTRY_COLS.email), phone: idx(ENTRY_COLS.phone), street: idx(ENTRY_COLS.street), city: idx(ENTRY_COLS.city), state: idx(ENTRY_COLS.state), zip: idx(ENTRY_COLS.zip) }
  const missing = (['name', 'email', 'phone'] as const).filter((k) => at[k] < 0)
  const empty = { create: [], updates: [], duplicates: [], checks: [], rows: [], errors: [] }
  if (missing.length) return { ...empty, missing: [...missing] }
  const errors: number[] = []
  const good: EntryRow[] = []
  for (const [n, r] of records.slice(1).entries()) {
    const rowNo = n + 2 // spreadsheet row number: the header is row 1
    if (!r.some((c) => c.trim())) continue // a completely blank row isn't an entry
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
    const e = toEntryRow(rowNo, { name: get(at.name), email: get(at.email), phone: get(at.phone), street: get(at.street), city: get(at.city), state: get(at.state), zip: get(at.zip) })
    if (!e) errors.push(rowNo)
    else good.push(e)
  }
  const m = matchRows(good, existing)
  return { ...m, rows: m.create, missing: [], errors }
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
