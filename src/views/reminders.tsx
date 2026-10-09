import { useEffect, useState } from 'react'
import type { Profile } from '../lib/model'
import { currentSubscription, getHeadsUp, needsHomeScreen, pushSupported, sendTest, setHeadsUp, turnOff, turnOn } from '../lib/push'
import { useToast } from '../ui'

/** Account sheet section: birthday and anniversary reminders on this phone. */
export function Reminders({ me }: { me: Profile }) {
  const toast = useToast()
  const [on, setOn] = useState<boolean | null>(null)
  const [heads, setHeads] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    currentSubscription().then((s) => setOn(!!s)).catch(() => setOn(false))
    getHeadsUp().then(setHeads).catch(() => {})
  }, [])
  async function run(fn: () => Promise<void>, msg: string) {
    setBusy(true)
    try { await fn(); toast(msg) } catch (e) { toast((e as Error).message) }
    setBusy(false)
  }
  return (
    <div className="card stack" style={{ background: 'var(--bg)', boxShadow: 'none', marginTop: 14 }}>
      <h3>Reminders</h3>
      {!pushSupported() || needsHomeScreen() ? (
        <p className="note">
          {needsHomeScreen()
            ? 'On iPhone, reminders work once Rock Solid is on your Home Screen: tap Share, then "Add to Home Screen", then open it from there and come back here.'
            : "This browser can't show notifications. Try opening Rock Solid from your phone's Home Screen."}
        </p>
      ) : (
        <>
          <p className="note">A note on this phone when someone has a birthday, home anniversary or wedding anniversary, plus a 9:00 nudge on weekdays if you haven't logged anything yet.</p>
          {on ? (
            <>
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 15 }}>
                <input type="checkbox" style={{ width: 20, height: 20 }} checked={heads} disabled={busy}
                  onChange={(e) => { const v = e.target.checked; setHeads(v); run(() => setHeadsUp(v), v ? "You'll also get a heads-up 3 days ahead." : 'Day-of reminders only.') }} />
                Also remind me 3 days ahead, so I can mail a card
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => run(sendTest, 'Test sent. It should pop up in a moment.')}>Send me a test</button>
                <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => run(async () => { await turnOff(); setOn(false) }, 'Reminders are off on this phone.')}>Turn off</button>
              </div>
            </>
          ) : (
            <button className="btn primary" disabled={busy || on === null} onClick={() => run(async () => { await turnOn(me, heads); setOn(true) }, 'Reminders are on.')}>
              {busy ? 'Turning on…' : 'Turn on reminders'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
