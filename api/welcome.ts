import { admin } from './_push.js'

// The welcome email: sent once, the first time someone opens Rock Solid after signing in.
// Needs RESEND_API_KEY and RESEND_FROM (for example: Rock Solid <hello@clearrockrealty.com>) in Vercel settings.
// Optional RESEND_REPLY_TO: where replies go.

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown }
type Res = { status: (n: number) => { json: (b: unknown) => void } }

const SITE = 'https://rock-solid-three.vercel.app'
const clean = (v?: string) => (v ?? '').trim().replace(/^["']|["']$/g, '').trim()

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const key = clean(process.env.RESEND_API_KEY)
  const from = clean(process.env.RESEND_FROM)
  if (!key || !from) return res.status(200).json({ sent: false, why: 'Add RESEND_API_KEY and RESEND_FROM in Vercel to send welcome emails.' })
  try {
    const db = admin()
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const { data: u, error: authErr } = await db.auth.getUser(token)
    if (authErr || !u.user) return res.status(401).json({ error: 'Sign in first.' })

    // The broker can send themselves a test copy any time.
    const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}) as { test?: boolean }
    let claimed: { full_name: string | null; email: string }[] | null
    if (body.test) {
      const { data: me } = await db.from('profiles').select('full_name, email, role').eq('id', u.user.id).single()
      if (me?.role !== 'broker') return res.status(403).json({ error: 'Only the broker can send a test.' })
      claimed = [me]
    } else {
      // Claim it first so two open tabs can't send it twice.
      const r = await db.from('profiles').update({ welcomed_at: new Date().toISOString() })
        .eq('id', u.user.id).is('welcomed_at', null).select('full_name, email')
      if (r.error) return res.status(200).json({ sent: false, why: /welcomed_at/.test(r.error.message) ? 'Run the 0011 SQL in Supabase first.' : r.error.message })
      if (!r.data?.length) return res.status(200).json({ sent: false, why: 'Already welcomed.' })
      claimed = r.data
    }

    const p = claimed[0] as { full_name: string | null; email: string }
    const first = (p.full_name ?? '').trim().split(/\s+/)[0] || 'there'
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: p.email, ...(clean(process.env.RESEND_REPLY_TO) ? { reply_to: clean(process.env.RESEND_REPLY_TO) } : {}), subject: 'Welcome to Rock Solid. Here is your first week.', html: html(first), text: text(first) }),
    })
    if (!r.ok) {
      if (!body.test) await db.from('profiles').update({ welcomed_at: null }).eq('id', u.user.id) // Try again next time.
      return res.status(200).json({ sent: false, why: `Resend said: ${await r.text()}` })
    }
    res.status(200).json({ sent: true, to: p.email })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}

const STEPS: [string, string, string?, string?][] = [
  ['Set your goals', 'Open Rock Solid and tap the graph icon at the top, next to your initial. Fill in your plan for the year. It tells you how many people you need in your database and how many to reach each day.'],
  ['Bring in your people', 'This part is easiest on a computer. Export your contacts as a CSV file from BoldTrail, Google Contacts or a spreadsheet, then use the button below. Sign in, and the import opens on its own.', 'Upload my contacts', `${SITE}/?go=import`],
  ['Put Rock Solid on your phone', 'On your phone, tap the button below (on iPhone, use Safari) and sign in. iPhone: tap the Share button (the square with the arrow), then Add to Home Screen. Android: tap the three dots in Chrome, then Install app. From then on, open it from your Home Screen like any other app.', 'Open Rock Solid', SITE],
  ["Tag your A's and B's", "On People, tap Needs a tag. A is your VIPs, every two weeks. B is everyone else you want to stay close to, about once a month. Rock Solid builds your list each day from these."],
  ['Turn on reminders', 'Once it is on your Home Screen, tap your initial at the top and turn on reminders. You will get birthdays, home anniversaries and a morning nudge if you have not logged anything yet.'],
  ['Jump into a challenge', "Tap Challenges at the bottom. Card a Day is waiting for you. Write a handwritten card, log it, and watch the streak grow. You can join a challenge a teammate started, or start your own and pin the one you care about most to the top."],
]

export function html(first: string) {
  const step = ([t, b, label, href]: (typeof STEPS)[number], i: number) => `
    <tr><td style="padding:0 0 22px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td valign="top" style="padding-right:14px"><div style="width:30px;height:30px;border-radius:15px;background:#1e3a6e;color:#fff;font:600 15px/30px Helvetica,Arial,sans-serif;text-align:center">${i + 1}</div></td>
        <td valign="top" style="font:400 16px/1.5 Helvetica,Arial,sans-serif;color:#1a2238">
          <div style="font-weight:700;font-size:17px;margin-bottom:2px">${t}</div>
          <div style="color:#3b4560">${b}</div>
          ${label ? `<a href="${href}" style="display:inline-block;margin-top:12px;background:#c9a24a;color:#1a2238;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px">${label}</a>` : ''}
        </td>
      </tr></table>
    </td></tr>`
  return `<!doctype html><html><body style="margin:0;background:#f4f6fa">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa"><tr><td align="center" style="padding:28px 14px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px">
      <tr><td style="padding:28px 28px 8px;font:400 16px/1.55 Helvetica,Arial,sans-serif;color:#1a2238">
        <div style="font-weight:700;color:#1e3a6e;font-size:18px;margin-bottom:18px">Rock Solid</div>
        <p style="margin:0 0 12px">Hey ${first},</p>
        <p style="margin:0 0 12px">Welcome to Rock Solid. This is where we stay close to the people who matter to us. Each day it reminds you who you haven't connected with in a while, so no one slips through the cracks and every relationship gets the care it deserves.</p>
        <p style="margin:0 0 22px">Here is how to get set up. It takes about 20 minutes, and you only do it once.</p>
      </td></tr>
      <tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${STEPS.map(step).join('')}</table></td></tr>
      <tr><td style="padding:0 28px 28px;font:400 16px/1.55 Helvetica,Arial,sans-serif;color:#1a2238">
        <p style="margin:0 0 12px">After that, it is simple. Open Today, reach out to the people on your list, and log each call, text, card and pop-by. A few genuine check-ins a day add up to relationships that last, and people who think of you first when it matters.</p>
        <p style="margin:0 0 12px">Questions? Just reply to this email.</p>
        <p style="margin:0">Glad you're here,<br>Ruben</p>
        <p style="margin:18px 0 0;color:#5d6781;font-size:13px">Clear Rock Realty · Leaving People and Places Better Than We Found Them.<br><a href="${SITE}" style="color:#2a4f8f">${SITE.replace('https://', '')}</a></p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`
}

export function text(first: string) {
  return [
    `Hey ${first},`, '',
    "Welcome to Rock Solid. This is where we stay close to the people who matter to us. Each day it reminds you who you haven't connected with in a while, so no one slips through the cracks and every relationship gets the care it deserves.", '',
    'Here is how to get set up. It takes about 20 minutes, and you only do it once.', '',
    ...STEPS.flatMap(([t, b, label, href], i) => [`${i + 1}. ${t}`, b, ...(label ? [`${label}: ${href}`] : []), '']),
    'After that, it is simple. Open Today, reach out to the people on your list, and log each call, text, card and pop-by. A few genuine check-ins a day add up to relationships that last, and people who think of you first when it matters.', '',
    'Questions? Just reply to this email.', '',
    'Glad you\'re here,', 'Ruben', '', SITE,
  ].join('\n')
}
