import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase, type Profile } from './supabase'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!configured) return <Shell><Notice title="Almost there">Add the Supabase URL and key in Vercel, then redeploy.</Notice></Shell>
  if (!ready) return <Shell><p className="muted">Loading…</p></Shell>
  return <Shell>{session ? <Home session={session} /> : <SignIn />}</Shell>
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="band">
        <div className="wrap">
          <small>Clear Rock Realty</small>
          <h1>Rock Solid</h1>
        </div>
      </header>
      <main className="wrap">{children}</main>
    </>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
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
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) {
      setError(error.message)
      setStatus('error')
    } else setStatus('sent')
  }

  if (status === 'sent')
    return <Notice title="Check your email">We sent a sign-in link to {email}. Open it on this device.</Notice>

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Sign in</h2>
      <p className="muted">Enter your work email and we'll send you a sign-in link. No password needed.</p>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn primary" disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Send sign-in link'}</button>
      {status === 'error' && <p className="error">{error}</p>}
    </form>
  )
}

function Home({ session }: { session: Session }) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [contactCount, setContactCount] = useState<number | null>(null)

  useEffect(() => {
    supabase
      .from('profiles')
      .select('id, brokerage_id, full_name, email, role, coach_id')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => setProfile(data as Profile | null))
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', session.user.id)
      .then(({ count }) => setContactCount(count ?? 0))
  }, [session.user.id])

  const signOut = () => supabase.auth.signOut()

  if (profile === undefined) return <p className="muted">Loading your profile…</p>
  if (profile === null)
    return (
      <Notice title="You're not on the list yet">
        {session.user.email} isn't set up in Rock Solid. Ask your broker to add you, then sign in again.{' '}
        <button className="link" onClick={signOut}>Sign out</button>
      </Notice>
    )

  return (
    <section className="card stack">
      <h2>Welcome, {profile.full_name ?? profile.email}</h2>
      <p>
        You're signed in as <b>{profile.role}</b>. Your database has <b>{contactCount ?? '…'}</b> contacts.
      </p>
      <p className="muted">This is the foundation build. Your Next 10, Card a Day and the rest arrive here next.</p>
      <button className="btn" onClick={signOut}>Sign out</button>
    </section>
  )
}
