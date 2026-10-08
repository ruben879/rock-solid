import webpush from 'web-push'
import { admin, vapid } from './_push.js'

/*
  Sends each person who turned on reminders one notification in the morning:
  birthdays, home anniversaries and wedding anniversaries today, plus a heads-up for ones 3 days out
  (time to get a card in the mail).

  Runs every morning from the Vercel schedule in vercel.json. It is safe to call more than once a day:
  each phone gets at most one reminder per day.
  With ?test=1 and a signed-in user's token, it sends that person a test notification right away.
*/

type Req = { query?: Record<string, string | string[]>; headers: Record<string, string | string[] | undefined> }
type Res = { status: (n: number) => { json: (b: unknown) => void } }

const TZ = 'America/Chicago'
export function todayParts(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(d).map((x) => [x.type, x.value]))
  return { ymd: `${p.year}-${p.month}-${p.day}`, md: `${p.month}-${p.day}`, year: Number(p.year), weekday: p.weekday as string }
}

type Contact = { agent_id: string; first_name: string; last_name: string; birthday: string | null; home_anniversary: string | null; wedding_anniversary?: string | null }
const name = (c: Contact) => `${c.first_name} ${c.last_name}`.trim()
const years = (date: string, year: number) => year - Number(date.slice(0, 4))

export function linesFor(cs: Contact[], md: string, year: number) {
  const out: string[] = []
  for (const c of cs) {
    if (c.birthday?.slice(5) === md) out.push(`${name(c)}'s birthday`)
    if (c.home_anniversary?.slice(5) === md) {
      const y = years(c.home_anniversary, year)
      out.push(`${name(c)}'s ${y > 0 ? `${y}-year ` : ''}home anniversary`)
    }
    if (c.wedding_anniversary?.slice(5) === md) {
      const y = years(c.wedding_anniversary, year)
      out.push(`${name(c)}'s ${y > 0 ? `${y}-year ` : ''}wedding anniversary`)
    }
  }
  return out
}

export const join = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

export default async function handler(req: Req, res: Res) {
  try {
    const db = admin()
    const keys = await vapid(db)
    webpush.setVapidDetails('mailto:ruben@clearrockrealty.com', keys.public_key, keys.private_key)

    const test = String(req.query?.test ?? '') === '1'
    let onlyUser: string | null = null
    if (test) {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const { data, error } = await db.auth.getUser(token)
      if (error || !data.user) return res.status(401).json({ error: 'Sign in first.' })
      onlyUser = data.user.id
    }

    let q = db.from('push_subscriptions').select('endpoint, user_id, p256dh, auth, heads_up, last_sent')
    if (onlyUser) q = q.eq('user_id', onlyUser)
    const { data: subs, error } = await q
    if (error) throw new Error(error.message)
    if (!subs?.length) return res.status(200).json({ sent: 0, note: 'No phones signed up yet.' })

    const t = todayParts()
    const soon = todayParts(3)
    const users = [...new Set(subs.map((s) => s.user_id))]
    const { data: contacts, error: cErr } = await db.from('contacts').select('*').in('agent_id', users)
    if (cErr) throw new Error(cErr.message)
    const byAgent = new Map<string, Contact[]>()
    for (const c of (contacts ?? []) as Contact[]) {
      if (!byAgent.has(c.agent_id)) byAgent.set(c.agent_id, [])
      byAgent.get(c.agent_id)!.push(c)
    }

    let sent = 0
    for (const s of subs) {
      if (!test && s.last_sent === t.ymd) continue
      let title = ''
      let body = ''
      if (test) {
        title = 'Reminders are on'
        body = "This is a test. You'll get a note like this on mornings when someone has a birthday or anniversary."
      } else {
        const mine = byAgent.get(s.user_id) ?? []
        const now = linesFor(mine, t.md, t.year)
        const ahead = s.heads_up ? linesFor(mine, soon.md, soon.year) : []
        if (!now.length && !ahead.length) continue
        title = now.length ? `Today: ${join(now)}` : `Coming up ${soon.weekday}`
        body = [
          now.length ? 'A quick call or text today will mean a lot.' : '',
          ahead.length ? `${now.length ? 'Coming up ' + soon.weekday + ': ' : ''}${join(ahead)}. Time to get a card in the mail.` : '',
        ].filter(Boolean).join(' ')
      }
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body, url: '/', tag: `rs-${t.ymd}` }))
        sent++
        if (!test) await db.from('push_subscriptions').update({ last_sent: t.ymd }).eq('endpoint', s.endpoint)
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode
        // The phone turned notifications off or the app was removed: forget this subscription.
        if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      }
    }
    res.status(200).json({ sent })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}
