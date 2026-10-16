// Encouragement from the broker or a coach. Shows up full screen the next time the agent opens the app.
import { supabase } from '../supabase'
import type { Profile } from './model'

export interface Cheer { id: string; from_name: string; to_id: string; body: string; created_at: string; seen_at: string | null }

export async function unseenCheers(userId: string): Promise<Cheer[]> {
  const r = await supabase.from('cheers').select('id, from_name, to_id, body, created_at, seen_at').eq('to_id', userId).is('seen_at', null).order('created_at')
  return r.error ? [] : (r.data as Cheer[]) // Before the SQL is run: nothing to show.
}
export async function markCheerSeen(id: string) {
  await supabase.from('cheers').update({ seen_at: new Date().toISOString() }).eq('id', id)
}
export async function sendCheer(me: Profile, toId: string, body: string) {
  const from_name = (me.full_name ?? '').trim().split(/\s+/)[0] || 'Your broker'
  const { error } = await supabase.from('cheers').insert({ brokerage_id: me.brokerage_id, from_id: me.id, from_name, to_id: toId, body: body.trim() })
  if (error) throw new Error(/cheers/.test(error.message) && /exist|find/.test(error.message) ? 'Encouragement needs the 0013 SQL run in Supabase first.' : error.message)
}
export async function sentTo(fromId: string, toId: string): Promise<Cheer[]> {
  const r = await supabase.from('cheers').select('id, from_name, to_id, body, created_at, seen_at').eq('from_id', fromId).eq('to_id', toId).order('created_at', { ascending: false }).limit(5)
  return r.error ? [] : (r.data as Cheer[])
}
