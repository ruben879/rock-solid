import { useEffect, useState, type ReactNode } from 'react'
import type { Contact, Profile } from '../lib/model'
import { currentSubscription, pushSupported } from '../lib/push'
import { Sheet, store } from '../ui'
import { ICheck } from '../icons'
import { openGoalWizard } from './goals'

type Tab = 'week' | 'cards' | 'activity' | 'db'
const SITE = 'rock-solid-three.vercel.app'

const isPhone = () => /iphone|ipad|ipod|android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
const openAccount = () => window.dispatchEvent(new Event('rs-open-account'))

interface Step { key: string; title: string; done: boolean; body: ReactNode; action?: { label: string; run: () => void } }

/**
 * "Getting started": a short checklist on Today for new agents. Each step checks itself off when it's done.
 * Hidden once everything is done or the agent closes it; the account menu can bring it back.
 */
export function GettingStarted({ contacts, agent, onGo }: { contacts: Contact[]; agent: Profile; onGo?: (t: Tab) => void }) {
  const [hidden, setHidden] = useState(() => store.get<boolean>('rs-start-hide', false))
  const [open, setOpen] = useState(false)
  const [reminders, setReminders] = useState(false)
  useEffect(() => { currentSubscription().then((s) => setReminders(!!s)).catch(() => {}) }, [open])
  useEffect(() => {
    const show = () => { setHidden(false); store.set('rs-start-hide', false); setOpen(true) }
    window.addEventListener('rs-start-show', show)
    return () => window.removeEventListener('rs-start-show', show)
  }, [])

  const go = (t: Tab) => { setOpen(false); onGo?.(t) }
  const account = () => { setOpen(false); openAccount() }
  const untagged = contacts.filter((c) => c.tier === 'U').length
  const steps: Step[] = [
    {
      key: 'goals', title: 'Set your goals first', done: !!agent.plan && Object.keys(agent.plan).length > 0,
      body: <p>A few quick questions about your year (take-home goal, average price). Rock Solid turns them into how many people you need and how many to reach each day.</p>,
      action: { label: 'Set my goals', run: () => { setOpen(false); openGoalWizard() } },
    },
    {
      key: 'people', title: 'Bring in your people', done: contacts.length > 0,
      body: (
        <>
          <p>This is easiest on a computer. Export your contacts as a CSV file (from BoldTrail, Google Contacts or a spreadsheet).</p>
          <p>Then on your computer go to <b>{SITE}</b>, sign in with your work email, and tap <b>People</b>, then <b>More tools</b>, then <b>Import CSV</b>.</p>
          <p className="note">No file? You can add people one at a time with the + Add button on People.</p>
        </>
      ),
      action: { label: 'Go to People', run: () => go('db') },
    },
    {
      key: 'password', title: 'Set a password', done: store.get<boolean>('rs-has-pw', false),
      body: <p>So you don't need an emailed code every time. Your phone or computer can save it and fill it in for you.</p>,
      action: { label: 'Set a password', run: account },
    },
    {
      key: 'tags', title: 'Tag your A\'s and B\'s', done: contacts.length > 0 && untagged === 0,
      body: (
        <>
          <p><b>A</b> is your VIPs, every 2 weeks. <b>B</b> is everyone else you want to stay close to, about once a month.</p>
          <p>On People, tap <b>Needs a tag</b>, then open each person and pick A or B.{untagged ? ` You have ${untagged} left.` : ''}</p>
        </>
      ),
      action: { label: 'Go to People', run: () => go('db') },
    },
    ...(installed()
      ? []
      : [{
          key: 'home', title: 'Put Rock Solid on your phone', done: false,
          body: isPhone() ? (
            isIOS() ? (
              <p>In <b>Safari</b>, tap the <b>Share</b> button (the square with an arrow), scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>. Open Rock Solid from your Home Screen from now on.</p>
            ) : (
              <p>In <b>Chrome</b>, tap the <b>⋮</b> menu, then <b>Add to Home screen</b> or <b>Install app</b>. Open Rock Solid from your Home Screen from now on.</p>
            )
          ) : (
            <p>On your phone, open <b>{SITE}</b> in Safari (iPhone) or Chrome (Android) and sign in. Then tap <b>Share</b>, <b>Add to Home Screen</b> (iPhone) or <b>⋮</b>, <b>Install app</b> (Android).</p>
          ),
        } as Step]),
    ...(pushSupported() || !isPhone()
      ? [{
          key: 'reminders', title: 'Turn on reminders', done: reminders,
          body: <p>On your phone, after it's on your Home Screen: birthday and anniversary reminders, plus a morning nudge if you haven't logged anything yet.</p>,
          action: isPhone() ? { label: 'Turn on reminders', run: account } : undefined,
        } as Step]
      : []),
  ]
  const doneCount = steps.filter((s) => s.done).length
  const allDone = doneCount === steps.length
  if ((hidden || allDone) && !open) return null

  const close = () => { setHidden(true); store.set('rs-start-hide', true) }
  return (
    <>
      {!hidden && !allDone && (
        <button className="startbar" onClick={() => setOpen(true)}>
          <span><b>Getting started</b><small>{doneCount} of {steps.length} done</small></span>
          <span className="startdots">{steps.map((s) => <i key={s.key} className={s.done ? 'on' : ''} />)}</span>
        </button>
      )}
      {open && (
        <Sheet label="Getting started" onClose={() => setOpen(false)}>
          <h3>Getting started</h3>
          <p className="note">A few minutes of setup and Rock Solid does the rest. Steps check themselves off as you go.</p>
          <ol className="gsteps">
            {steps.map((s, i) => (
              <li key={s.key} className={s.done ? 'done' : ''}>
                <span className="stepn">{s.done ? <ICheck size={16} /> : i + 1}</span>
                <div>
                  <b>{s.title}</b>
                  {!s.done && <div className="stepbody">{s.body}</div>}
                  {!s.done && s.action && <button className="btn" style={{ marginTop: 8 }} onClick={s.action.run}>{s.action.label}</button>}
                </div>
              </li>
            ))}
          </ol>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => setOpen(false)}>Close</button>
            {!allDone && <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setOpen(false); close() }}>Hide this guide</button>}
          </div>
          <p className="note" style={{ marginTop: 8, textAlign: 'center' }}>You can bring this back from your account menu.</p>
        </Sheet>
      )}
    </>
  )
}

const ShareGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ verticalAlign: '-3px' }}>
    <path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
  </svg>
)

/** First time on a phone in the browser: show how to put Rock Solid on the Home Screen, step by step. Once per phone. */
export function HomeScreenTip() {
  const [show, setShow] = useState(() => isPhone() && !installed() && !store.get<boolean>('rs-a2hs-seen', false))
  if (!show) return null
  const done = () => { setShow(false); store.set('rs-a2hs-seen', true) }
  const ios = isIOS()
  const steps = ios
    ? [<>Tap the <b>Share</b> button <ShareGlyph /> at the bottom of Safari.</>, <>Scroll down and tap <b>Add to Home Screen</b>.</>, <>Tap <b>Add</b>. Then open Rock Solid from your Home Screen.</>]
    : [<>Tap the <b>⋮</b> menu at the top right of Chrome.</>, <>Tap <b>Install app</b> or <b>Add to Home screen</b>.</>, <>Tap <b>Install</b>. Then open Rock Solid from your Home Screen.</>]
  return (
    <Sheet label="Put Rock Solid on your Home Screen" onClose={done}>
      <h3>Put Rock Solid on your Home Screen</h3>
      <p className="note">It opens like any other app, stays signed in, and can send you reminders. Takes 10 seconds.</p>
      <ol className="gsteps">
        {steps.map((s, i) => (
          <li key={i}><span className="stepn">{i + 1}</span><div className="stepbody" style={{ marginTop: 3 }}><p style={{ margin: 0 }}>{s}</p></div></li>
        ))}
      </ol>
      {ios && /crios|fxios|edgios|gsa\//i.test(navigator.userAgent) && <p className="note">Not in Safari? Copy <b>{SITE}</b> and open it in Safari first.</p>}
      <button className="btn primary lg block" style={{ marginTop: 12 }} onClick={done}>Got it</button>
    </Sheet>
  )
}
