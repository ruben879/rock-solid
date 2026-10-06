import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './supabase'
import * as api from './lib/data'
import { addDays, fmt, weekStart } from './lib/dates'
import type { Brokerage, Profile } from './lib/model'
import { ToastProvider, store } from './ui'
import { AgentWorkspace, type AgentTab } from './views/agent'
import { AgentsOverview, DrawingView, TeamAdmin } from './views/team'

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

function Shell({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <>
      <header className="band">
        <div className="wrap">
          {header ?? (
            <div className="brand" style={{ paddingBottom: 16 }}>
              <div><small>Clear Rock Realty</small><h1>Rock Solid</h1></div>
            </div>
          )}
        </div>
      </header>
      <main className="wrap">{children}</main>
    </>
  )
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p>{children}</p>
    </section>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    setStatus('sending')
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: window.location.origin } })
    if (error) {
      setError(error.message.includes('rate') ? 'Too many sign-in emails were sent recently. Wait a few minutes and try again.' : error.message)
      setStatus('error')
    } else setStatus('sent')
  }
  if (status === 'sent') return <Notice title="Check your email">We sent a sign-in link to {email}. Open it on this device. It can take a minute to arrive.</Notice>
  return (
    <form className="card stack" onSubmit={submit}>
      <h2 style={{ margin: 0 }}>Sign in</h2>
      <p className="muted">Enter your work email and we'll send you a sign-in link. No password needed.</p>
      <label className="field"><span>Email</span>
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button className="btn primary lg" style={{ alignSelf: 'flex-start' }} disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Send sign-in link'}</button>
      {status === 'error' && <p className="error">{error}</p>}
    </form>
  )
}

type Tab = AgentTab | 'agents' | 'team' | 'draw'

function Signed({ session }: { session: Session }) {
  const [me, setMe] = useState<Profile | null | undefined>(undefined)
  const [brokerage, setBrokerage] = useState<Brokerage | null>(null)
  const [team, setTeam] = useState<Profile[]>([])
  const [tab, setTab] = useState<Tab>(() => store.get<Tab>('rs-tab', 'week'))
  const [viewing, setViewing] = useState<Profile | null>(null)

  const loadProfile = useCallback(async () => {
    const r = await api.loadMe(session.user.id)
    setMe(r.profile)
    setBrokerage(r.brokerage)
    if (r.profile) setTeam(await api.loadTeam(r.profile.brokerage_id).catch(() => []))
  }, [session.user.id])
  useEffect(() => { loadProfile() }, [loadProfile])

  const signOut = () => supabase.auth.signOut()

  if (me === undefined) return <Shell><p className="muted">Loading your profile…</p></Shell>
  if (me === null)
    return (
      <Shell>
        <Notice title="You're not on the list yet">
          {session.user.email} isn't set up in Rock Solid. Ask your broker to add you, then sign in again. <button className="link" onClick={signOut}>Sign out</button>
        </Notice>
      </Shell>
    )

  const agentTabs: [Tab, string][] = [['week', 'Your Next 10'], ['cards', 'Card a Day'], ['activity', 'Monthly'], ['db', 'Database']]
  const extra: [Tab, string][] = me.role === 'broker' ? [['agents', 'All Agents'], ['team', 'Team'], ['draw', 'Drawing']] : me.role === 'coach' ? [['agents', 'My Agents']] : []
  const tabs = viewing ? agentTabs : [...agentTabs, ...extra]
  const current = tabs.some(([k]) => k === tab) ? tab : 'week'
  const go = (t: Tab) => { setTab(t); store.set('rs-tab', t) }
  const subject = viewing ?? me
  const firstName = (me.full_name || me.email).split(' ')[0]

  const header = (
    <>
      <div className="brand">
        <div><small>{brokerage?.name ?? 'Clear Rock Realty'}</small><h1>Rock Solid</h1></div>
        <div className="who">
          {viewing ? <>Viewing <b>{viewing.full_name || viewing.email}</b></> : <>Hi, <b>{firstName}</b> · {me.role}</>}
          <br />
          Week of {fmt(weekStart())} – {fmt(addDays(weekStart(), 6))} · <button onClick={signOut}>Sign out</button>
        </div>
      </div>
      <nav className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={current === k} onClick={() => go(k)}>{l}</button>
        ))}
      </nav>
    </>
  )

  return (
    <Shell header={header}>
      {viewing && (
        <div className="banner" style={{ marginBottom: 6 }}>
          <p><b>Viewing {viewing.full_name || viewing.email}'s tracker.</b> <span className="note">Read-only. Only the agent can log touches.</span></p>
          <button className="btn" onClick={() => { setViewing(null); go('agents') }}>Back to agents</button>
        </div>
      )}
      {(['week', 'cards', 'activity', 'db'] as Tab[]).includes(current) && (
        <AgentWorkspace key={subject.id} me={me} agent={subject} brokerage={brokerage} tab={current as AgentTab} readOnly={!!viewing} onProfileChange={loadProfile} />
      )}
      {current === 'agents' && <AgentsOverview me={me} team={team} brokerage={brokerage} onOpen={(p) => { setViewing(p); go('week') }} />}
      {current === 'team' && <TeamAdmin me={me} team={team} onChange={loadProfile} />}
      {current === 'draw' && <DrawingView me={me} team={team} brokerage={brokerage} />}
    </Shell>
  )
}
