import type { Contact, Tier } from './model'

export type ImportRow = {
  first_name: string; last_name: string; phone: string | null; email: string | null
  address: string | null; city: string | null; state: string | null; zip: string | null
  tier: Tier | null; birthday: string | null; home_anniversary: string | null
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
    anniv: cols('home anniversary', 'last closing date', 'closing date', 'anniversary'),
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
    const tier = (raw === 'D' ? 'C' : raw) as Tier | null
    const phone = get(C.phone)
    out.push({
      first_name: first, last_name: last,
      phone: phone ? formatPhone(phone) : null,
      email: get(C.email).toLowerCase() || null,
      address: get(C.address) || null, city: get(C.city) || null, state: get(C.state) || null, zip: get(C.zip) || null,
      tier, birthday: toDate(get(C.birthday)), home_anniversary: toDate(get(C.anniv)),
    })
  }
  return out
}

const FIELDS = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'birthday', 'home_anniversary'] as const

/** Split rows into new people and updates to people already in the database (matched by email, then phone, then full name). */
export function planImport(rows: ImportRow[], existing: Contact[]) {
  const byEmail = new Map<string, Contact>()
  const byPhone = new Map<string, Contact>()
  const byName = new Map<string, Contact>()
  for (const c of existing) {
    if (c.email) byEmail.set(c.email.toLowerCase().trim(), c)
    if (c.phone && digits(c.phone).length >= 10) byPhone.set(digits(c.phone).slice(-10), c)
    byName.set(`${c.first_name} ${c.last_name}`.toLowerCase().replace(/\s+/g, ' ').trim(), c)
  }
  const fresh: ImportRow[] = []
  const updates: { id: string; name: string; fields: Partial<Contact> }[] = []
  let same = 0
  const seen = new Set<string>()
  for (const r of rows) {
    const match =
      (r.email && byEmail.get(r.email)) ||
      (r.phone && digits(r.phone).length >= 10 && byPhone.get(digits(r.phone).slice(-10))) ||
      byName.get(`${r.first_name} ${r.last_name}`.toLowerCase().replace(/\s+/g, ' ').trim())
    if (!match) {
      const key = `${r.first_name} ${r.last_name}|${r.email ?? ''}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(r)
      continue
    }
    if (seen.has(match.id)) continue
    seen.add(match.id)
    const fields: Partial<Contact> = {}
    for (const k of FIELDS) {
      const v = r[k]
      const cur = (match[k] ?? '') as string
      const same = k === 'phone' ? digits(v ?? '') === digits(cur) : k === 'email' ? (v ?? '').toLowerCase() === cur.toLowerCase() : v === cur
      if (v && !same) (fields as Record<string, string>)[k] = v
    }
    // Only fill in a tier when the person doesn't have one yet, so tiers set in the app aren't undone.
    if (r.tier && match.tier === 'U') fields.tier = r.tier
    if (Object.keys(fields).length) updates.push({ id: match.id, name: `${match.first_name} ${match.last_name}`.trim(), fields })
    else same++
  }
  return { fresh, updates, same }
}
