import { useEffect, useState, type FormEvent } from 'react'
import { consentLine, INACTIVE, thanksLine, TOKEN_RE } from '../lib/entryPage'

// The public entry page (/enter/<token>). No sign-in. Talks only to /api/enter: nothing here reaches the database directly.
type Info = { brokerage: string; logo: string | null; agent: string; first: string; label: string }
type Form = { name: string; email: string; phone: string; street: string; city: string; state: string; zip: string; website: string }
const EMPTY: Form = { name: '', email: '', phone: '', street: '', city: '', state: '', zip: '', website: '' }

export function EntryPage({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | 'inactive' | 'offline' | null>(null)
  const [f, setF] = useState<Form>(EMPTY)
  const [err, setErr] = useState<{ name?: string; reach?: string; send?: string }>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!TOKEN_RE.test(token)) { setInfo('inactive'); return }
    fetch(`/api/enter?token=${encodeURIComponent(token)}`)
      .then(async (r) => (r.status === 404 ? setInfo('inactive') : r.ok ? setInfo(await r.json()) : setInfo('offline')))
      .catch(() => setInfo('offline'))
  }, [token])
  useEffect(() => { if (info && typeof info === 'object') document.title = info.label }, [info])

  const set = (k: keyof Form) => (e: { target: { value: string } }) => { setF((x) => ({ ...x, [k]: e.target.value })); setErr({}) }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const name = f.name.trim(), email = f.email.trim(), phone = f.phone.replace(/\D/g, '')
    const bad: typeof err = {}
    if (!name) bad.name = 'Please add your name.'
    if (!email && !phone) bad.reach = 'Please add an email or a phone number so we can reach you.'
    if (bad.name || bad.reach) { setErr(bad); return }
    setBusy(true)
    try {
      const r = await fetch('/api/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...f }) })
      if (r.status === 404) { setInfo('inactive'); return }
      const b = await r.json().catch(() => ({}))
      if (r.ok && b.ok) { setDone(true); window.scrollTo({ top: 0 }) }
      else if (r.status === 400) setErr(/name/i.test(b.error ?? '') ? { name: b.error } : { reach: b.error })
      else setErr({ send: b.error || "Couldn't send that. Please try again." })
    } catch {
      setErr({ send: "Couldn't send that. Check your connection and try again." })
    } finally { setBusy(false) }
  }

  if (info === null) return <Frame><p className="muted">Loading…</p></Frame>
  if (info === 'inactive') return <Frame><div className="card enter-card"><h1 className="enter-h">{INACTIVE}</h1></div></Frame>
  if (info === 'offline') return <Frame><div className="card enter-card"><h1 className="enter-h">Can't load right now</h1><p className="muted">Check your connection and refresh the page.</p></div></Frame>

  const head = (
    <header className="enter-head">
      {info.logo ? <img src={info.logo} alt={info.brokerage} className="enter-logo" /> : <div className="enter-brand">{info.brokerage}</div>}
      <h1 className="enter-h">{info.label}</h1>
      <p className="muted">{info.agent}</p>
    </header>
  )
  if (done) return <Frame>{head}<div className="card enter-card enter-done" role="status"><p>{thanksLine(info.first)}</p></div></Frame>

  return (
    <Frame>
      {head}
      <form className="card enter-card" onSubmit={submit} noValidate>
        <label className="field"><span>Full name</span>
          <input value={f.name} onChange={set('name')} autoComplete="name" required aria-invalid={!!err.name} aria-describedby={err.name ? 'e-name' : undefined} />
          {err.name && <small id="e-name" className="error">{err.name}</small>}
        </label>
        <label className="field"><span>Email</span>
          <input type="email" inputMode="email" value={f.email} onChange={set('email')} autoComplete="email" aria-invalid={!!err.reach} />
        </label>
        <label className="field"><span>Phone</span>
          <input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" aria-invalid={!!err.reach} aria-describedby={err.reach ? 'e-reach' : undefined} />
          {err.reach && <small id="e-reach" className="error">{err.reach}</small>}
        </label>
        <label className="field"><span>Mailing street address</span>
          <input value={f.street} onChange={set('street')} autoComplete="address-line1" />
        </label>
        <div className="enter-row">
          <label className="field enter-city"><span>City</span><input value={f.city} onChange={set('city')} autoComplete="address-level2" /></label>
          <label className="field enter-st"><span>State</span><input value={f.state} onChange={set('state')} autoComplete="address-level1" /></label>
          <label className="field enter-zip"><span>ZIP</span><input value={f.zip} onChange={set('zip')} autoComplete="postal-code" inputMode="numeric" /></label>
        </div>
        {/* Left empty by people; bots fill it in. */}
        <div className="enter-hp" aria-hidden="true">
          <label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} name="website" /></label>
        </div>
        <p className="note enter-consent">{consentLine(info.first)}</p>
        {err.send && <p className="error" role="alert">{err.send}</p>}
        <button className="btn primary big" disabled={busy}>{busy ? 'Sending…' : 'Enter'}</button>
      </form>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="wrap enter">{children}</main>
}
