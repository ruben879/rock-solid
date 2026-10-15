import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './supabase'
import * as api from './lib/data'
import { startSync } from './lib/offline'
import type { Brokerage, Profile } from './lib/model'
import { OfflineBar, PullToRefresh, Sheet, ToastProvider, store, useToast } from './ui'
import { AgentWorkspace, type AgentTab } from './views/agent'
import { AgentsOverview, DrawingView, TeamAdmin } from './views/team'
import { Reminders } from './views/reminders'
import { ICard, IChart, IHeart, IHome, IPeople, ITeam } from './icons'
import { Together } from './views/together'

// A challenge link (/j/CODE): remember the code, show the normal app, and open the join sheet once signed in.
{
  const m = typeof location !== 'undefined' ? location.pathname.match(/^\/j\/([A-Za-z0-9]{4,12})\/?$/) : null
  if (m) {
    store.set('rs-join', m[1].toUpperCase())
    history.replaceState(null, '', '/')
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      // Offline with an expired sign-in token: keep using the saved sign-in until the connection is back.
      setSession(data.session ?? (!navigator.onLine ? savedSession() : null))
      setReady(true)
    }).catch(() => {
      setSession(savedSession())
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  let body: ReactNode
  if (!configured) body = <Notice title="Almost there">Add the Supabase URL and key in Vercel, then redeploy.</Notice>
  else if (!ready) body = <p className="muted">Loading…</p>
  else if (!session) body = <SignIn />
  return <ToastProvider>{session && configured ? <Signed session={session} /> : <Shell>{body}</Shell>}</ToastProvider>
}

function savedSession(): Session | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? ''
      if (/^sb-.*-auth-token$/.test(k)) {
        const v = JSON.parse(localStorage.getItem(k) ?? 'null')
        if (v?.user?.id) return v as Session
      }
    }
  } catch {
    /* nothing saved */
  }
  return null
}

function Mark() {
  return <div className="mark"><img src="/icon.svg" alt="" />Rock Solid</div>
}

function Shell({ children, right, wide }: { children: ReactNode; right?: ReactNode; wide?: boolean }) {
  return (
    <>
      <header className="appbar">
        <div className={`wrap ${wide ? 'wide' : ''} topbar`}><Mark />{right}</div>
      </header>
      <main className={`wrap ${wide ? 'wide' : ''}`}>{children}</main>
    </>
  )
}

/** Set or change a password, so signing in doesn't need an emailed code. */
function PasswordSetup({ email, bare, onDone }: { email: string; bare?: boolean; onDone?: () => void }) {
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const has = store.get<boolean>('rs-has-pw', false)
  async function save(e: FormEvent) {
    e.preventDefault()
    if (pw.length < 8) return toast('Use at least 8 characters.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return toast(error.message)
    store.set('rs-has-pw', true)
    setPw('')
    toast('Password saved. Next time, sign in with it instead of a code.')
    onDone?.()
  }
  const form = (
    <form className="stack" onSubmit={save} style={{ gap: 8 }}>
      {/* The email lets the phone's password manager save the login together. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <input type="password" aria-label="New password" placeholder={has ? 'New password' : 'Pick a password (8+ characters)'} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" style={{ flex: 1 }} disabled={busy || !pw}>{busy ? 'Saving…' : 'Save password'}</button>
        {bare && <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onDone}>Not now</button>}
      </div>
    </form>
  )
  if (bare) return form
  return (
    <div className="card stack" style={{ background: 'var(--bg)', boxShadow: 'none', marginTop: 14 }}>
      <h3>{has ? 'Password' : 'Sign in without a code'}</h3>
      <p className="note">{has ? 'You can sign in with your password. Change it here anytime.' : 'Set a password and your phone or computer can fill it in for you next time.'}</p>
      {form}
    </div>
  )
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack" style={{ marginTop: 24 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p>{children}</p>
    </section>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'verifying' | 'error'>('idle')
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password) return signInPw()
    setStatus('sending')
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: window.location.origin } })
    setError('')
    if (error) {
      setError(error.message.includes('rate') ? 'Too many sign-in emails were sent recently. Wait a few minutes and try again.' : error.message)
      setStatus('error')
    } else setStatus('sent')
  }
  async function signInPw() {
    setStatus('sending')
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
    if (error) {
      setError(/invalid/i.test(error.message) ? "That password didn't match. Try again, or leave it blank and we'll email you a code." : error.message)
      setStatus('error')
    } else store.set('rs-has-pw', true)
  }
  async function verify(e: FormEvent) {
    e.preventDefault()
    setStatus('verifying')
    const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' })
    if (error) {
      setError('That code didn’t work. Check the newest email and try again, or send a new one.')
      setStatus('sent')
    } else if (!store.get('rs-has-pw', false)) {
      store.set('rs-offer-pw', true)
      window.dispatchEvent(new Event('rs-offer-pw'))
    }
  }
  if (status === 'sent' || status === 'verifying')
    return (
      <form className="signin stack" onSubmit={verify}>
        <h2 style={{ margin: 0 }}>Check your email</h2>
        <p className="muted">We sent a code to {email}. Type it below and you'll stay signed in.</p>
        <input className="code" aria-label="Code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={10} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        <button className="btn primary lg block" disabled={status === 'verifying' || code.length < 6}>{status === 'verifying' ? 'Checking…' : 'Sign in'}</button>
        {error && <p className="error">{error}</p>}
        <p className="note">No code? <button type="button" className="link" onClick={() => { setStatus('idle'); setCode(''); setError('') }}>Send a new one</button></p>
      </form>
    )
  return (
    <form className="signin stack" onSubmit={submit}>
      <h2 style={{ margin: 0 }}>Welcome to Rock Solid</h2>
      <p className="muted">Enter your work email. If you've set a password, use it here. If not, leave it blank and we'll email you a code.</p>
      <input type="email" aria-label="Email" placeholder="you@clearrockrealty.com" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" aria-label="Password" placeholder="Password (if you have one)" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn primary lg block" disabled={status === 'sending'}>{status === 'sending' ? (password ? 'Signing in…' : 'Sending…') : password ? 'Sign in' : 'Email me a code'}</button>
      {status === 'error' && <p className="error">{error}</p>}
    </form>
  )
}

type Tab = AgentTab | 'team' | 'together'
type TeamView = 'agents' | 'invite' | 'draw'

function Signed({ session }: { session: Session }) {
  const [me, setMe] = useState<Profile | null | undefined>(undefined)
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [team, setTeam] = useState<Profile[]>([])
  // Always open on Today (or Together when someone tapped a challenge link).
  const [tab, setTab] = useState<Tab>(() => (store.get<string | null>('rs-join', null) ? 'together' : 'week'))
  // Coming back after a while also lands on Today.
  useEffect(() => {
    let hiddenAt = 0
    const on = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > 10 * 60_000) { setTab('week'); window.scrollTo({ top: 0 }) }
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  const [teamView, setTeamView] = useState<TeamView>('agents')
  const [viewing, setViewing] = useState<Profile | null>(null)
  const [menu, setMenu] = useState(false)
  const [offerPw, setOfferPw] = useState(() => store.get<boolean>('rs-offer-pw', false))
  useEffect(() => {
    const acct = () => setMenu(true)
    window.addEventListener('rs-open-account', acct)
    return () => window.removeEventListener('rs-open-account', acct)
  }, [])
  useEffect(() => {
    const on = () => setOfferPw(true)
    window.addEventListener('rs-offer-pw', on)
    return () => window.removeEventListener('rs-offer-pw', on)
  }, [])
  // How many people are still open on Today (sent by the Today screen).
  const [openCount, setOpenCount] = useState(() => store.get<number>('rs-open', 0))
  useEffect(() => {
    const on = (e: Event) => { const n = (e as CustomEvent<number>).detail; setOpenCount(n); store.set('rs-open', n) }
    window.addEventListener('rs-open', on)
    return () => window.removeEventListener('rs-open', on)
  }, [])

  const [loadErr, setLoadErr] = useState('')
  const loadProfile = useCallback(async () => {
    try {
      const r = await api.loadMe(session.user.id)
      setMe(r.profile)
      setBrokerage(r.brokerage)
      setLoadErr('')
      if (r.profile) setTeam(await api.loadTeam(r.profile.brokerage_id).catch(() => []))
    } catch (e) {
      setLoadErr(navigator.onLine ? (e as Error).message : "You're offline, and this phone doesn't have a saved copy yet. Open Rock Solid once with a connection and it will work offline after that.")
    }
  }, [session.user.id])
  useEffect(() => { loadProfile() }, [loadProfile])
  // Send changes made offline as soon as the connection is back, then refresh what's on screen.
  useEffect(() => startSync(() => window.dispatchEvent(new Event('rs-synced'))), [])

  const signOut = () => supabase.auth.signOut()

  if (me === undefined) return <Shell>{loadErr ? <Notice title="Can't load right now">{loadErr}</Notice> : <p className="muted" style={{ marginTop: 24 }}>Loading…</p>}</Shell>
  if (me === null)
    return (
      <Shell>
        <Notice title="You're not on the list yet">
          {session.user.email} isn't set up in Rock Solid. Ask your broker to add you, then sign in again. <button className="link" onClick={signOut}>Sign out</button>
        </Notice>
      </Shell>
    )

  const leads = me.role !== 'agent'
  // Today sits in the middle, bigger and gold. Team (for the broker and coaches) is the button at the top.
  const tabs: [Tab, string, ReactNode][] = [
    ['cards', 'Cards', <ICard key="c" />],
    ['db', 'People', <IPeople key="p" />],
    ['week', 'Today', <IHome key="h" size={28} />],
    ['together', 'Together', <IHeart key="g" />],
    ['activity', 'Progress', <IChart key="a" />],
  ]
  const allowed = [...tabs.map(([k]) => k), ...(leads && !viewing ? (['team'] as Tab[]) : [])]
  const current = allowed.includes(tab) && !(viewing && tab === 'together') ? tab : 'week'
  const go = (t: Tab) => { setTab(t); window.scrollTo({ top: 0 }) }
  const subject = viewing ?? me
  const initial = (me.full_name || me.email).trim()[0]?.toUpperCase() ?? '?'

  return (
    <>
      <OfflineBar />
      <Shell wide={current === 'team'} right={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {leads && !viewing && <button className={`teambtn ${current === 'team' ? 'on' : ''}`} onClick={() => go('team')}><ITeam size={18} /> {me.role === 'broker' ? 'Team' : 'My agents'}</button>}
          <button className="me" aria-label="Account" onClick={() => setMenu(true)}>{initial}</button>
        </span>
      }>
        {viewing && (
          <div className="viewing">
            <span>Looking at <b>{viewing.full_name || viewing.email}</b></span>
            <button className="btn" onClick={() => { setViewing(null); go('team') }}>Done</button>
          </div>
        )}
        {current === 'together' && <Together me={me} />}
        {current !== 'team' && current !== 'together' && (
          <AgentWorkspace key={subject.id} me={me} agent={subject} brokerage={brokerage} tab={current as AgentTab} readOnly={!!viewing} onProfileChange={loadProfile} onGo={(t) => go(t)} />
        )}
        {current === 'team' && (
          <>
            {me.role === 'broker' && (
              <div className="seg" role="group" aria-label="Team views">
                {([['agents', 'Agents'], ['invite', 'Invite'], ['draw', 'Drawing']] as [TeamView, string][]).map(([k, l]) => (
                  <button key={k} aria-pressed={teamView === k} onClick={() => setTeamView(k)}>{l}</button>
                ))}
              </div>
            )}
            {(me.role !== 'broker' || teamView === 'agents') && <AgentsOverview me={me} team={team} brokerage={brokerage} onOpen={(p) => { setViewing(p); go('week') }} />}
            {me.role === 'broker' && teamView === 'invite' && <TeamAdmin me={me} team={team} onChange={loadProfile} />}
            {me.role === 'broker' && teamView === 'draw' && <DrawingView me={me} team={team} brokerage={brokerage} />}
          </>
        )}
      </Shell>
      <PullToRefresh />
      <nav className="bottom" aria-label="Main">
        <div className="wrap">
          {tabs.map(([k, l, icon]) => (
            <button key={k} className={k === 'week' ? 'center' : undefined} aria-current={current === k ? 'page' : undefined} onClick={() => go(k)} aria-label={k === 'week' && openCount > 0 && !viewing ? `${l}, ${openCount} open` : undefined}>
              <span className="navic">{icon}{k === 'week' && openCount > 0 && !viewing && <span className="bubble">{openCount > 99 ? '99+' : openCount}</span>}</span>{l}
            </button>
          ))}
        </div>
      </nav>
      {offerPw && !menu && (
        <Sheet label="Skip the code next time" onClose={() => { setOfferPw(false); store.set('rs-offer-pw', false) }}>
          <h3>Skip the code next time?</h3>
          <p className="note">Set a password and your phone or computer can fill it in for you (Face ID on iPhone). You can always still sign in with a code.</p>
          <PasswordSetup email={me.email} bare onDone={() => { setOfferPw(false); store.set('rs-offer-pw', false) }} />
        </Sheet>
      )}
      {menu && (
        <Sheet label="Account" onClose={() => setMenu(false)}>
          <h3>{me.full_name || me.email}</h3>
          <p className="note">{me.email} · {me.role === 'broker' ? 'Broker' : me.role === 'coach' ? 'Coach' : 'Agent'} · {brokerage?.name ?? 'Clear Rock Realty'}</p>
          <PasswordSetup email={me.email} />
          <Reminders me={me} />
          <div className="menu" style={{ marginTop: 12 }}>
            <button onClick={() => { setMenu(false); go('week'); setTimeout(() => window.dispatchEvent(new Event('rs-start-show')), 150) }}>Getting started guide</button>
            <button onClick={signOut}>Sign out</button>
            <button onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
    </>
  )
}
