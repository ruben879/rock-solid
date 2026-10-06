import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configured = Boolean(url && key)
export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

export type Role = 'agent' | 'coach' | 'broker'
export interface Profile {
  id: string
  brokerage_id: string
  full_name: string | null
  email: string
  role: Role
  coach_id: string | null
}
