import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './supabase'
import * as api from './lib/data'
import type { Brokerage, Profile } from './lib/model'
import { Sheet, ToastProvider, store } from './ui'
import { AgentWorkspace, type AgentTab } from './views/agent'
import { AgentsOverview, DrawingView, TeamAdmin } from './views/team'
import { ICard, IChart, IHome, IPeople, ITeam } from './icons'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
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
  async function submit(e: FormEvent) {
    e.preventDefault()
    setStatus('sending')
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: window.location.origin } })
    setError('')
    if (error) {
      setError(error.message.includes('rate') ? 'Too many sign-in emails were sent recently. Wait a few minutes and try again.' : error.message)
      setStatus('error')
    } else setStatus('sent')
  }
  async function verify(e: FormEvent) {
    e.preventDefault()
    setStatus('verifying')
    const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' })
    if (error) {
      setError('That code didn’t work. Check the newest email and try again, or send a new one.')
      setStatus('sent')
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
      <p className="muted">Enter your work email and we'll send you a code. No password needed.</p>
      <input type="email" aria-label="Email" placeholder="you@clearrockrealty.com" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn primary lg block" disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Send my code'}</button>
      {status === 'error' && <p className="error">{error}</p>}
    </form>
  )
}

type Tab = AgentTab | 'team'
type TeamView = 'agents' | 'invite' | 'draw'

function Signed({ session }: { session: Session }) {
  const [me, setMe] = useState<Profile | null | undefined>(undefined)
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [team, setTeam] = useState<Profile[]>([])
  const [tab, setTab] = useState<Tab>(() => {
    const t = store.get<string>('rs-tab', 'week')
    return (['week', 'cards', 'activity', 'db', 'team'].includes(t) ? t : 'week') as Tab
  })
  const [teamView, setTeamView] = useState<TeamView>('agents')
  const [viewing, setViewing] = useState<Profile | null>(null)
  const [menu, setMenu] = useState(false)

  const loadProfile = useCallback(async () => {
    const r = await api.loadMe(session.user.id)
    setMe(r.profile)
    setBrokerage(r.brokerage)
    if (r.profile) setTeam(await api.loadTeam(r.profile.brokerage_id).catch(() => []))
  }, [session.user.id])
  useEffect(() => { loadProfile() }, [loadProfile])

  const signOut = () => supabase.auth.signOut()

  if (me === undefined) return <Shell><p className="muted" style={{ marginTop: 24 }}>Loading…</p></Shell>
  if (me === null)
    return (
      <Shell>
        <Notice title="You're not on the list yet">
          {session.user.email} isn't set up in Rock Solid. Ask your broker to add you, then sign in again. <button className="link" onClick={signOut}>Sign out</button>
        </Notice>
      </Shell>
    )

  const leads = me.role !== 'agent'
  const tabs: [Tab, string, ReactNode][] = [
    ['week', 'Today', <IHome key="h" />],
    ['cards', 'Cards', <ICard key="c" />],
    ['db', 'People', <IPeople key="p" />],
    ['activity', 'Progress', <IChart key="a" />],
    ...(leads && !viewing ? [['team', me.role === 'broker' ? 'Team' : 'My agents', <ITeam key="t" />] as [Tab, string, ReactNode]] : []),
  ]
  const current = tabs.some(([k]) => k === tab) ? tab : 'week'
  const go = (t: Tab) => { setTab(t); store.set('rs-tab', t); window.scrollTo({ top: 0 }) }
  const subject = viewing ?? me
  const initial = (me.full_name || me.email).trim()[0]?.toUpperCase() ?? '?'

  return (
    <>
      <Shell wide={current === 'team'} right={<button className="me" aria-label="Account" onClick={() => setMenu(true)}>{initial}</button>}>
        {viewing && (
          <div className="viewing">
            <span>Looking at <b>{viewing.full_name || viewing.email}</b></span>
            <button className="btn" onClick={() => { setViewing(null); go('team') }}>Done</button>
          </div>
        )}
        {current !== 'team' && (
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
      <nav className="bottom" aria-label="Main">
        <div className="wrap">
          {tabs.map(([k, l, icon]) => (
            <button key={k} aria-current={current === k ? 'page' : undefined} onClick={() => go(k)}>{icon}{l}</button>
          ))}
        </div>
      </nav>
      {menu && (
        <Sheet label="Account" onClose={() => setMenu(false)}>
          <h3>{me.full_name || me.email}</h3>
          <p className="note">{me.email} · {me.role === 'broker' ? 'Broker' : me.role === 'coach' ? 'Coach' : 'Agent'} · {brokerage?.name ?? 'Clear Rock Realty'}</p>
          <div className="menu" style={{ marginTop: 12 }}>
            <button onClick={signOut}>Sign out</button>
            <button onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
    </>
  )
}
