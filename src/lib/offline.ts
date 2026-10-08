/**
 * Offline support.
 *
 * - The last good copy of each agent's data is kept on the phone, so the app opens and works in airplane mode.
 * - Every change is written as a small "op". If the phone is offline (or the request can't reach the server),
 *   the op is applied to the phone's copy right away and saved in an outbox.
 * - When the connection comes back, the outbox is sent in order and the data is reloaded from the server.
 */
import { supabase } from '../supabase'
import type { Card, Contact, Tally, Touch } from './model'

export interface AgentData {
  contacts: Contact[]
  touches: Touch[]
  cards: Card[]
  tallies: Tally[]
}

type Row = Record<string, unknown>
export type Op =
  | { t: 'insert'; table: string; rows: Row[] }
  | { t: 'update'; table: string; id: string; fields: Row }
  | { t: 'delete'; table: string; id: string }
  | { t: 'upsert'; table: string; row: Row; onConflict: string }

interface Queued { op: Op; key: string; at: number }

const OUTBOX = 'rs-outbox'
const cacheKey = (key: string) => `rs-cache-${key}`

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage full or unavailable */
  }
}

export const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0
        return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })

// ---------- Connection state ----------
export const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

/** True when an error means "couldn't reach the server" rather than "the server said no". */
export function isNetworkError(e: unknown) {
  const m = String((e as { message?: string })?.message ?? e).toLowerCase()
  return !isOnline() || m.includes('failed to fetch') || m.includes('load failed') || m.includes('networkerror') || m.includes('network request failed') || m.includes('fetch failed')
}

// ---------- In-memory copies with listeners ----------
const mem = new Map<string, AgentData>()
const listeners = new Map<string, Set<(d: AgentData) => void>>()

export function getCached(key: string): AgentData | null {
  if (mem.has(key)) return mem.get(key) as AgentData
  const d = read<AgentData | null>(cacheKey(key), null)
  if (d) mem.set(key, d)
  return d
}
export function setCached(key: string, d: AgentData) {
  mem.set(key, d)
  write(cacheKey(key), d)
  listeners.get(key)?.forEach((fn) => fn(d))
}
export function subscribe(key: string, fn: (d: AgentData) => void) {
  if (!listeners.has(key)) listeners.set(key, new Set())
  listeners.get(key)!.add(fn)
  return () => { listeners.get(key)?.delete(fn) }
}

// ---------- Outbox ----------
const outboxListeners = new Set<(n: number) => void>()
export const pendingCount = () => read<Queued[]>(OUTBOX, []).length
export function onPending(fn: (n: number) => void) {
  outboxListeners.add(fn)
  return () => { outboxListeners.delete(fn) }
}
function saveOutbox(q: Queued[]) {
  write(OUTBOX, q)
  outboxListeners.forEach((fn) => fn(q.length))
}

// ---------- Applying an op to the phone's copy ----------
const TABLES: Record<string, keyof AgentData> = { contacts: 'contacts', touches: 'touches', cards: 'cards', tallies: 'tallies' }

export function applyLocal(key: string, op: Op) {
  const d = getCached(key)
  if (!d) return
  const name = TABLES[op.table]
  if (!name) return
  const next: AgentData = { ...d, [name]: [...(d[name] as unknown as Row[])] } as AgentData
  const list = next[name] as unknown as Row[]
  if (op.t === 'insert') {
    for (const r of op.rows) list.push({ created_at: new Date().toISOString(), ...r })
    // Mirror the database trigger that keeps each contact's last touch date current.
    if (op.table === 'touches') {
      next.contacts = next.contacts.map((c) => {
        const latest = op.rows.filter((r) => r.contact_id === c.id).map((r) => r.occurred_on as string).sort().at(-1)
        return latest && (!c.last_touch_on || latest > c.last_touch_on) ? { ...c, last_touch_on: latest } : c
      })
    }
  } else if (op.t === 'update') {
    const i = list.findIndex((r) => r.id === op.id)
    if (i >= 0) list[i] = { ...list[i], ...op.fields }
  } else if (op.t === 'delete') {
    const i = list.findIndex((r) => r.id === op.id)
    if (i >= 0) list.splice(i, 1)
    if (op.table === 'contacts') next.touches = next.touches.filter((t) => t.contact_id !== op.id)
  } else if (op.t === 'upsert') {
    const keys = op.onConflict.split(',')
    const i = list.findIndex((r) => keys.every((k) => r[k] === op.row[k]))
    if (i >= 0) list[i] = { ...list[i], ...op.row }
    else list.push(op.row)
  }
  setCached(key, next)
}

// ---------- Sending an op to the server ----------
async function send(op: Op) {
  const q = supabase.from(op.table)
  const r =
    op.t === 'insert' ? await q.insert(op.rows)
    : op.t === 'update' ? await q.update(op.fields).eq('id', op.id)
    : op.t === 'delete' ? await q.delete().eq('id', op.id)
    : await q.upsert(op.row, { onConflict: op.onConflict })
  if (r.error) throw new Error(r.error.message)
}

/**
 * Run a change: show it on the phone right away, then send it.
 * If the server can't be reached, the rest is saved for later. If the server refuses it, the error is thrown.
 */
export async function exec(key: string, ops: Op[]) {
  for (const op of ops) applyLocal(key, op)
  if (!isOnline() || pendingCount() > 0) {
    // Keep order: anything new waits behind changes that are already queued.
    queue(key, ops)
    if (isOnline()) void flush()
    return { queued: true }
  }
  for (let i = 0; i < ops.length; i++) {
    try {
      await send(ops[i])
    } catch (e) {
      if (isNetworkError(e)) {
        queue(key, ops.slice(i))
        return { queued: true }
      }
      throw e
    }
  }
  return { queued: false }
}

function queue(key: string, ops: Op[]) {
  const q = read<Queued[]>(OUTBOX, [])
  for (const op of ops) q.push({ op, key, at: Date.now() })
  saveOutbox(q)
}

let flushing: Promise<{ sent: number; failed: number }> | null = null

/** Send everything waiting in the outbox, oldest first. Stops at the first connection problem. */
export function flush() {
  if (flushing) return flushing
  flushing = (async () => {
    let sent = 0
    let failed = 0
    let q = read<Queued[]>(OUTBOX, [])
    while (q.length && isOnline()) {
      try {
        await send(q[0].op)
        sent++
      } catch (e) {
        if (isNetworkError(e)) break
        failed++ // The server refused it (for example, it was already deleted). Drop it so the rest can go through.
      }
      q = q.slice(1)
      saveOutbox(q)
    }
    return { sent, failed }
  })().finally(() => {
    flushing = null
  })
  return flushing
}

/** Call once at startup: sends the outbox whenever the connection comes back. */
export function startSync(onSynced: () => void) {
  const go = async () => {
    if (!pendingCount()) return onSynced()
    const r = await flush()
    if (r.sent || r.failed) onSynced()
  }
  window.addEventListener('online', go)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && isOnline() && pendingCount() && go())
  if (isOnline() && pendingCount()) void go()
  return () => window.removeEventListener('online', go)
}
