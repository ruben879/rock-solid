// Phone reminders: sign this phone up (or off) for birthday and anniversary notifications.
import { supabase } from '../supabase'
import type { Profile } from './model'

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
/** iPhones only allow notifications for apps opened from the Home Screen. */
export const needsHomeScreen = () => isIOS() && !standalone()

function keyBytes(base64: string) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export async function currentSubscription() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

export async function turnOn(me: Profile, headsUp: boolean) {
  if (!pushSupported()) throw new Error("This browser can't show notifications.")
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are turned off for Rock Solid. You can allow them in your phone settings.')
  const reg = await navigator.serviceWorker.ready
  const r = await fetch('/api/push-key')
  const body = await r.json().catch(() => ({}))
  if (!r.ok || !body.key) throw new Error(body.error || "Reminders aren't set up on the server yet.")
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(body.key) }))
  const j = sub.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert({
    endpoint: sub.endpoint, user_id: me.id, brokerage_id: me.brokerage_id,
    p256dh: j.keys?.p256dh, auth: j.keys?.auth, heads_up: headsUp,
  }, { onConflict: 'endpoint' })
  if (error) throw new Error(error.message)
}

export async function setHeadsUp(headsUp: boolean) {
  const sub = await currentSubscription()
  if (!sub) return
  const { error } = await supabase.from('push_subscriptions').update({ heads_up: headsUp }).eq('endpoint', sub.endpoint)
  if (error) throw new Error(error.message)
}

export async function getHeadsUp() {
  const sub = await currentSubscription()
  if (!sub) return true
  const { data } = await supabase.from('push_subscriptions').select('heads_up').eq('endpoint', sub.endpoint).maybeSingle()
  return data?.heads_up ?? true
}

export async function turnOff() {
  const sub = await currentSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}

export async function sendTest() {
  const { data } = await supabase.auth.getSession()
  const r = await fetch('/api/send-reminders?test=1', { headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || "The test didn't send.")
  if (!body.sent) throw new Error("This phone isn't signed up yet. Turn reminders on first.")
}
