import webpush from 'web-push'
import { admin, vapid } from './_push.js'

/*
  The morning nudge: "Let's get to stacking those rocks."
  Goes to each phone with the nudge on, at the hour its owner picked (7, 8, 9 or 10 a.m. Lubbock time, 9 by default),
  if they haven't logged anything yet today (no touch, no card), Monday to Friday.

  Vercel runs this every hour from 12:00 to 16:00 UTC on weekdays (see vercel.json), which covers 7 to 10 a.m.
  in Lubbock on both sides of daylight saving time. Each run only sends to phones whose hour it is.
  With ?test=1 and a signed-in user's token, it sends that person the nudge right away.
*/

type Req = { query?: Record<string, string | string[]>; headers: Record<string, string | string[] | undefined> }
type Res = { status: (n: number) => { json: (b: unknown) => void } }

const TZ = 'America/Chicago'
function nowLocal() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  )
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekend: p.weekday === 'Sat' || p.weekday === 'Sun' }
}

export default async function handler(req: Req, res: Res) {
  try {
    const db = admin()
    const test = String(req.query?.test ?? '') === '1'
    const auth = String(req.headers.authorization ?? '')
    let onlyUser: string | null = null
    if (test) {
      const { data, error } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ''))
      if (error || !data.user) return res.status(401).json({ error: 'Sign in first.' })
      onlyUser = data.user.id
    } else {
      // Only the Vercel schedule may send to everyone.
      const secret = process.env.CRON_SECRET
      const ua = String(req.headers['user-agent'] ?? '')
      if (secret ? auth !== `Bearer ${secret}` : !ua.startsWith('vercel-cron')) return res.status(401).json({ error: 'Not allowed.' })
    }

    const t = nowLocal()
    if (!test && (t.hour < 7 || t.hour > 10 || t.weekend)) return res.status(200).json({ sent: 0, note: 'Not nudge time on a weekday in Lubbock.' })

    const keys = await vapid(db)
    webpush.setVapidDetails('mailto:ruben@clearrockrealty.com', keys.public_key, keys.private_key)

    type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string; nudge?: boolean; nudge_hour?: number }
    const load = (cols: string) => {
      let q = db.from('push_subscriptions').select(cols)
      if (onlyUser) q = q.eq('user_id', onlyUser)
      return q
    }
    let r = await load('endpoint, user_id, p256dh, auth, nudge, nudge_hour')
    // Before the nudge settings SQL is run, everyone gets it at 9.
    if (r.error && /nudge/.test(r.error.message)) r = await load('endpoint, user_id, p256dh, auth')
    if (r.error) throw new Error(r.error.message)
    const subs = ((r.data ?? []) as unknown as Sub[]).filter((s) => test || ((s.nudge ?? true) && (s.nudge_hour ?? 9) === t.hour))
    if (!subs?.length) return res.status(200).json({ sent: 0, note: 'No phones signed up yet.' })

    const users = [...new Set(subs.map((s) => s.user_id as string))]
    const [touches, cards, profiles, contacts] = await Promise.all([
      db.from('touches').select('agent_id').in('agent_id', users).eq('occurred_on', t.ymd).eq('is_group', false),
      db.from('cards').select('agent_id').in('agent_id', users).eq('sent_on', t.ymd),
      db.from('profiles').select('id, daily_goal, plan').in('id', users),
      db.from('contacts').select('agent_id').in('agent_id', users).limit(10000),
    ])
    for (const r of [touches, cards, profiles, contacts]) if (r.error) throw new Error(r.error.message)
    const active = new Set([...(touches.data ?? []), ...(cards.data ?? [])].map((r) => r.agent_id as string))
    const hasPeople = new Set((contacts.data ?? []).map((r) => r.agent_id as string))
    const goal = new Map(
      (profiles.data ?? []).map((p) => {
        // Same starter goal the app uses for someone who hasn't set one (sized for 100 people).
        const untouched = !p.plan || Object.keys(p.plan).length === 0
        return [p.id as string, untouched && p.daily_goal === 5 ? 7 : (p.daily_goal as number)]
      }),
    )

    let sent = 0
    for (const s of subs) {
      const uid = s.user_id as string
      if (!test && (active.has(uid) || !hasPeople.has(uid))) continue
      const n = goal.get(uid)
      const body = n ? `Your ${n} for today are ready. One call gets it rolling.` : 'Your people for today are ready. One call gets it rolling.'
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: "Let's get to stacking those rocks", body, url: '/', tag: `rs-nudge-${t.ymd}` }),
        )
        sent++
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      }
    }
    res.status(200).json({ sent })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}
