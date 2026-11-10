import type { Tier } from './model'
import { matchRows, toEntryRow, type EntryRow, type Existing, type MatchPlan } from './matching.ts'
export * from './matching.ts'

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
/** How a header is compared: lowercase, trimmed, underscores read as spaces ("First_Name" → "first name"). */
export const normHeader = (h: string) => h.toLowerCase().replace(/_/g, ' ').trim()

export function readContacts(text: string): ImportRow[] {
  const all = parseCsv(text.replace(/^﻿/, ''))
  if (all.length < 2) return []
  const head = all[0].map(normHeader)
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
// The CSV contract: these headers (case-insensitive, trimmed, underscores read as spaces), with the Google Form titles
// as aliases. The name can be one Full name column or separate First name and Last name columns. Other columns are ignored.
const ENTRY_COLS = {
  name: ['full name'],
  first: ['first name', 'first', 'firstname', 'given name'],
  last: ['last name', 'last', 'lastname', 'surname', 'family name'],
  email: ['email'],
  phone: ['phone'],
  street: ['street', 'mailing street address'],
  city: ['city'],
  state: ['state'],
  zip: ['zip'],
} as const

export type EntryPlan = MatchPlan<EntryRow> & {
  /** Required columns missing entirely (name, email or phone). Nothing imports when any are missing. */
  missing: string[]
  errors: number[]
  /** New people this import creates (the same as create). */
  rows: EntryRow[]
}
/**
 * Reads an entry form CSV and sorts every row into Imported, Duplicate or Error row.
 * Row numbers count the header as row 1. A Duplicate matches a contact the Owning agent already has,
 * or an earlier row in the same file, by email or phone.
 */
export function planEntryImport(text: string, existing: Existing[]): EntryPlan {
  const records = csvRecords(text.replace(/^\uFEFF/, ''))
  const head = (records[0] ?? []).map(normHeader)
  const idx = (names: readonly string[]) => head.findIndex((h) => names.includes(h))
  const at = { name: idx(ENTRY_COLS.name), first: idx(ENTRY_COLS.first), last: idx(ENTRY_COLS.last), email: idx(ENTRY_COLS.email), phone: idx(ENTRY_COLS.phone), street: idx(ENTRY_COLS.street), city: idx(ENTRY_COLS.city), state: idx(ENTRY_COLS.state), zip: idx(ENTRY_COLS.zip) }
  const hasName = at.name >= 0 || at.first >= 0 || at.last >= 0
  const missing = [...(hasName ? [] : ['name']), ...(['email', 'phone'] as const).filter((k) => at[k] < 0)]
  const empty = { create: [], updates: [], duplicates: [], checks: [], rows: [], errors: [] }
  if (missing.length) return { ...empty, missing }
  const errors: number[] = []
  const good: EntryRow[] = []
  for (const [n, r] of records.slice(1).entries()) {
    const rowNo = n + 2 // spreadsheet row number: the header is row 1
    if (!r.some((c) => c.trim())) continue // a completely blank row isn't an entry
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
    // A Full name cell wins; otherwise First and Last together (either one alone is still a name).
    const name = get(at.name) || [get(at.first), get(at.last)].filter(Boolean).join(' ')
    const e = toEntryRow(rowNo, { name, email: get(at.email), phone: get(at.phone), street: get(at.street), city: get(at.city), state: get(at.state), zip: get(at.zip) })
    if (!e) errors.push(rowNo)
    else good.push(e)
  }
  const m = matchRows(good, existing)
  return { ...m, rows: m.create, missing: [], errors }
}
