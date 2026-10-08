// Shared helpers for the reminder functions. Runs on Vercel, never in the browser.
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

export function admin() {
  // Trim stray spaces, line breaks or quotes that sneak in when pasting.
  const clean = (v?: string) => (v ?? '').trim().replace(/^["']|["']$/g, '').trim()
  const url = clean(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL).replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  if (!url || !key) throw new Error('Add SUPABASE_SERVICE_ROLE_KEY in Vercel settings to turn on reminders.')
  return createClient(url, key, { auth: { persistSession: false } })
}

/** The app's push keys. Made once, the first time they're needed, and kept in the database. */
export async function vapid(db = admin()) {
  const { data, error: readErr } = await db.from('push_config').select('public_key, private_key').eq('id', 1).maybeSingle()
  if (readErr) {
    if (/invalid api key|jwt/i.test(readErr.message))
      throw new Error("The SUPABASE_SERVICE_ROLE_KEY in Vercel doesn't match this Supabase project. Copy the service_role (secret) key again and redeploy.")
    if (/push_config/.test(readErr.message)) throw new Error('Run the reminders SQL in Supabase first.')
    throw new Error(readErr.message)
  }
  if (data?.public_key && data?.private_key) return data as { public_key: string; private_key: string }
  const k = webpush.generateVAPIDKeys()
  const row = { id: 1, public_key: k.publicKey, private_key: k.privateKey }
  const { error } = await db.from('push_config').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw new Error(error.message)
  const { data: again } = await db.from('push_config').select('public_key, private_key').eq('id', 1).single()
  return again as { public_key: string; private_key: string }
}
