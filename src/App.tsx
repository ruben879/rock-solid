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
import { IChart, IHome, IPeople, ITeam, ITrophy } from './icons'
import { myInvites, unread } from './lib/together'
import { HomeScreenTip } from './views/start'
import { MorningNoteEditor, MorningScreen } from './views/morning'
import { CheerScreen, CheerSheet } from './views/cheer'

// A challenge link (/j/CODE): remember the code, show the normal app, and open the join sheet once signed in.
{
  const m = typeof location !== 'undefined' ? location.pathname.match(/^\/j\/([A-Za-z0-9]{4,12})\/?$/) : null
  if (m) {
    store.set('rs-join', m[1].toUpperCase())
    history.replaceState(null, '', '/')
  }
}

// The welcome email's upload link (?go=import): open People with the import ready, once signed in.
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('go') === 'import') {
  store.set('rs-go', 'import')
  history.replaceState(null, '', '/')
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

type Tab = AgentTab | 'team'
type TeamView = 'agents' | 'invite' | 'draw' | 'note'

function Signed({ session }: { session: Session }) {
  const [me, setMe] = useState<Profile | null | undefined>(undefined)
  const toast = useToast()
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [team, setTeam] = useState<Profile[]>([])
  // Always open on Today (or Challenges when someone tapped a challenge link).
  const [tab, setTab] = useState<Tab>(() => (store.get<string | null>('rs-join', null) ? 'cards' : store.get<string | null>('rs-go', null) === 'import' ? 'db' : 'week'))
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
  const [cheering, setCheering] = useState<Profile | null>(null)
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

  // Bubble on Challenges: new posts from others since you last looked, plus waiting invites.
  const [invites, setInvites] = useState(0)
  const [fresh, setFresh] = useState(0)
  useEffect(() => {
    const uid = session.user.id
    const check = () => {
      if (!navigator.onLine) return
      myInvites().then((v) => setInvites(v.length), () => {})
      unread(uid).then((m) => setFresh(Object.values(m).reduce((a, b) => a + b, 0)), () => {})
    }
    check()
    const on = (e: Event) => setInvites((e as CustomEvent<number>).detail)
    const vis = () => document.visibilityState === 'visible' && check()
    window.addEventListener('rs-invites', on)
    window.addEventListener('rs-seen', check)
    document.addEventListener('visibilitychange', vis)
    // Live: recount when anyone posts in a challenge you're in.
    const ch = supabase.channel('together-badge')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'challenge_posts' }, () => check())
      .subscribe()
    const t = setInterval(check, 120000)
    return () => {
      window.removeEventListener('rs-invites', on); window.removeEventListener('rs-seen', check)
      document.removeEventListener('visibilitychange', vis); supabase.removeChannel(ch); clearInterval(t)
    }
  }, [session.user.id])

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
  // The welcome email goes out once, the first time someone opens the app (the server keeps track).
  const welcomeId = me?.id
  useEffect(() => {
    if (!welcomeId || store.get<boolean>(`rs-welcomed-${welcomeId}`, false) || !navigator.onLine) return
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token
      if (!token) return
      fetch('/api/welcome', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((b: { sent?: boolean; why?: string }) => { if (b.sent || b.why === 'Already welcomed.') store.set(`rs-welcomed-${welcomeId}`, true) })
        .catch(() => {})
    })
  }, [welcomeId])
  // Send changes made offline as soon as the connection is back, then refresh what's on screen.
  useEffect(() => startSync(() => window.dispatchEvent(new Event('rs-synced'))), [])

  const signOut = () => supabase.auth.signOut()
  async function sendTestWelcome() {
    try {
      const { data } = await supabase.auth.getSession()
      const r = await fetch('/api/welcome', { method: 'POST', headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ test: true }) })
      const b = (await r.json().catch(() => ({}))) as { sent?: boolean; to?: string; why?: string; error?: string }
      toast(b.sent ? `Sent to ${b.to}. Check your inbox (and spam) in a minute.` : `Not sent: ${b.why ?? b.error ?? `the server answered ${r.status}`}`)
    } catch (e) { toast(`Not sent: ${(e as Error).message}`) }
  }

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
  // Three tabs: Today sits in the middle, bigger and gold. Progress and Team (broker and coaches) are buttons at the top.
  const tabs: [Tab, string, ReactNode][] = [
    ['db', 'People', <IPeople key="p" />],
    ['week', 'Today', <IHome key="h" size={28} />],
    ['cards', 'Challenges', <ITrophy key="c" />],
  ]
  const allowed = [...tabs.map(([k]) => k), 'activity' as Tab, ...(me.role === 'broker' && !viewing ? (['stool'] as Tab[]) : []), ...(leads && !viewing ? (['team'] as Tab[]) : [])]
  const current = allowed.includes(tab) ? tab : 'week'
  const go = (t: Tab) => { setTab(t); window.scrollTo({ top: 0 }) }
  const subject = viewing ?? me
  const initial = (me.full_name || me.email).trim()[0]?.toUpperCase() ?? '?'

  return (
    <>
      <OfflineBar />
      <Shell wide={current === 'team'} right={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {leads && !viewing && <button className={`teambtn ${current === 'team' ? 'on' : ''}`} onClick={() => go('team')}><ITeam size={18} /> {me.role === 'broker' ? 'Team' : 'My agents'}</button>}
          <button className={`progbtn ${current === 'activity' ? 'on' : ''}`} aria-label="Progress" aria-current={current === 'activity' ? 'page' : undefined} onClick={() => go('activity')}><IChart size={20} /></button>
          <button className="me" aria-label="Account" onClick={() => setMenu(true)}>{initial}</button>
        </span>
      }>
        {viewing && (
          <div className="viewing">
            <span>Looking at <b>{viewing.full_name || viewing.email}</b></span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="btn gold" onClick={() => setCheering(viewing)}>👏 Encourage</button>
              <button className="btn" onClick={() => { setViewing(null); go('team') }}>Done</button>
            </span>
          </div>
        )}
        {current !== 'team' && (
          <AgentWorkspace key={subject.id} me={me} agent={subject} brokerage={brokerage} tab={current as AgentTab} readOnly={!!viewing} onProfileChange={loadProfile} onGo={(t) => go(t)} />
        )}
        {current === 'team' && (
          <>
            {me.role === 'broker' && (
              <div className="seg" role="group" aria-label="Team views">
                {([['agents', 'Agents'], ['invite', 'Invite'], ['draw', 'Drawing'], ['note', 'Message']] as [TeamView, string][]).map(([k, l]) => (
                  <button key={k} aria-pressed={teamView === k} onClick={() => setTeamView(k)}>{l}</button>
                ))}
              </div>
            )}
            {(me.role !== 'broker' || teamView === 'agents') && <AgentsOverview me={me} team={team} brokerage={brokerage} onOpen={(p) => { setViewing(p); go('week') }} onCheer={setCheering} />}
            {me.role === 'broker' && teamView === 'invite' && <TeamAdmin me={me} team={team} onChange={loadProfile} />}
            {me.role === 'broker' && teamView === 'draw' && <DrawingView me={me} team={team} brokerage={brokerage} />}
            {me.role === 'broker' && teamView === 'note' && <MorningNoteEditor me={me} brokerage={brokerage} onSaved={loadProfile} />}
          </>
        )}
      </Shell>
      <PullToRefresh />
      <nav className="bottom" aria-label="Main">
        <div className="wrap">
          {tabs.map(([k, l, icon]) => (
            <button key={k} className={k === 'week' ? 'center' : undefined} aria-current={current === k ? 'page' : undefined} onClick={() => go(k)} aria-label={k === 'week' && openCount > 0 && !viewing ? `${l}, ${openCount} open` : undefined}>
              <span className="navic">{icon}{k === 'week' && openCount > 0 && !viewing && <span className="bubble">{openCount > 99 ? '99+' : openCount}</span>}{k === 'cards' && !viewing && fresh > 0 && <span className="bubble">{fresh > 99 ? '99+' : fresh}</span>}{k === 'cards' && !viewing && !fresh && invites > 0 && <span className="dot" aria-label={`${invites} invite${invites === 1 ? '' : 's'}`} />}</span>{l}
            </button>
          ))}
        </div>
      </nav>
      {!viewing && <HomeScreenTip />}
      {cheering && <CheerSheet me={me} to={cheering} onClose={() => setCheering(null)} />}
      {!viewing && !store.get<string | null>('rs-join', null) && <MorningScreen key={brokerage?.settings?.morning_note?.id ?? 'day'} me={me} brokerage={brokerage} />}
      {!viewing && <CheerScreen me={me} />}
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
          <SkinPicker />
          <PasswordSetup email={me.email} />
          <Reminders me={me} />
          <div className="menu" style={{ marginTop: 12 }}>
            <button onClick={() => { setMenu(false); go('week'); setTimeout(() => window.dispatchEvent(new Event('rs-start-show')), 150) }}>Getting started guide</button>
            {me.role === 'broker' && <button onClick={() => { setMenu(false); sendTestWelcome() }}>Send me a test welcome email</button>}
            <button onClick={signOut}>Sign out</button>
            <button onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
    </>
  )
}

/** Two looks for the whole app: Classic (warm, gold rocks) and Clean (white, gray and navy). Saved on this phone. */
function SkinPicker() {
  const [skin, setSkin] = useState(() => (document.documentElement.dataset.skin === 'clean' ? 'clean' : 'classic'))
  const pick = (v: 'classic' | 'clean') => {
    setSkin(v)
    document.documentElement.dataset.skin = v
    try { localStorage.setItem('rs-skin', v) } catch { /* private mode */ }
  }
  return (
    <div className="skinpick">
      <span>Look</span>
      <div className="seg4 x2" role="group" aria-label="App look">
        <button type="button" aria-pressed={skin === 'classic'} onClick={() => pick('classic')}><i className="sw sw-classic" /> Classic</button>
        <button type="button" aria-pressed={skin === 'clean'} onClick={() => pick('clean')}><i className="sw sw-clean" /> Clean</button>
      </div>
    </div>
  )
}
