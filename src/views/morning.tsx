import { useEffect, useState } from 'react'
import type { Brokerage, Profile } from '../lib/model'
import { addDays, fmt, today, ymd } from '../lib/dates'
import { lineFor, type MorningNote } from '../lib/daily'
import { Rock, store, useToast } from '../ui'
import * as api from '../lib/data'

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}
export const activeNote = (b: Brokerage | null, day = ymd(today())) => {
  const n = b?.settings?.morning_note
  return n && n.text.trim() && n.starts <= day && day <= n.ends ? n : null
}

/** The full-screen hello, the first time someone opens Rock Solid each day. */
export function MorningScreen({ me, brokerage, preview, onClose }: { me: Profile; brokerage: Brokerage | null; preview?: MorningNote | null; onClose?: () => void }) {
  const day = ymd(today())
  const fresh = activeNote(brokerage)
  // Once a day, plus right away when a new message from the broker goes up.
  const [show, setShow] = useState(() => !!preview || store.get<string>('rs-morning', '') !== day || (!!fresh && store.get<string>('rs-morning-note', '') !== fresh.id))
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (!show || preview) return
    store.set('rs-morning', day)
    if (fresh) store.set('rs-morning-note', fresh.id)
  }, [show, preview, day, fresh])
  if (!show) return null
  const note = preview ?? fresh
  const line = lineFor(day)
  const first = (me.full_name ?? '').trim().split(/\s+/)[0] || ''
  const goal = me.daily_goal
  const done = () => { setLeaving(true); setTimeout(() => { setShow(false); onClose?.() }, 220) }
  return (
    <div className={`morning ${leaving ? 'out' : ''}`} role="dialog" aria-modal="true" aria-label="Good morning" onClick={done}>
      <div className="mwrap" onClick={(e) => e.stopPropagation()}>
        <p className="mdate">{today().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1>{greeting()}{first ? `, ${first}` : ''}</h1>
        <div className="mrocks" aria-hidden>{[0, 1, 2].map((i) => <Rock key={i} i={i} on />)}</div>
        {note ? (
          <blockquote className="mquote note-from">
            <p>{note.text}</p>
            <cite>From {note.from}</cite>
          </blockquote>
        ) : (
          <blockquote className="mquote">
            <p>{line.text}</p>
            {line.from && <cite>{line.from}</cite>}
          </blockquote>
        )}
        {goal > 0 && <p className="mgoal">Today: <b>{goal} {goal === 1 ? 'person' : 'people'}</b> to reach</p>}
        <button className="btn gold lg block" onClick={done}>Let's stack some rocks</button>
      </div>
    </div>
  )
}

/** Broker: write a message for the good-morning screen. */
export function MorningNoteEditor({ me, brokerage, onSaved }: { me: Profile; brokerage: Brokerage | null; onSaved: () => void }) {
  const toast = useToast()
  const cur = brokerage?.settings?.morning_note ?? null
  const t = today()
  const sat = addDays(t, 6 - t.getDay())
  const [text, setText] = useState(cur?.text ?? '')
  const [from, setFrom] = useState(cur?.from ?? ((me.full_name ?? '').trim().split(/\s+/)[0] || 'your broker'))
  const [ends, setEnds] = useState(cur && cur.ends >= ymd(t) ? cur.ends : ymd(t))
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  const live = activeNote(brokerage)
  const draft: MorningNote = { id: cur?.id ?? '', text: text.trim(), from: from.trim() || 'your broker', starts: ymd(t), ends }

  async function save(note: MorningNote | null) {
    if (!brokerage) return
    setBusy(true)
    try {
      await api.saveBrokerageSettings(brokerage, { morning_note: note })
      toast(note ? `Saved. Everyone sees it the first time they open the app each day through ${fmt(note.ends)}.` : 'Message removed. Back to the daily lines.')
      onSaved()
    } catch (e) { toast(`That didn't save: ${(e as Error).message}`) }
    setBusy(false)
  }
  return (
    <section>
      <h2 style={{ marginTop: 14 }}>Good-morning message</h2>
      <p className="sub">Everyone sees a full-screen hello the first time they open Rock Solid each day. Most days it's a short line about habits and focus. Write your own here and it takes that spot.</p>
      {live && <div className="okcheck" style={{ marginBottom: 12 }}>Showing now, through {fmt(live.ends)}.</div>}
      <div className="card stack">
        <label className="field"><span>Your message</span>
          <textarea value={text} maxLength={280} rows={4} placeholder="Proud of this team. Let's finish October strong." onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="field"><span>Signed</span><input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <div className="field"><span>Show it through</span>
          <div className="chips">
            <button type="button" aria-pressed={ends === ymd(t)} onClick={() => setEnds(ymd(t))}>Today</button>
            <button type="button" aria-pressed={ends === ymd(sat)} onClick={() => setEnds(ymd(sat))}>This week</button>
            <input type="date" aria-label="Through" value={ends} min={ymd(t)} onChange={(e) => e.target.value && setEnds(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn gold lg" style={{ flex: 1 }} disabled={busy || !draft.text} onClick={() => save({ ...draft, id: `${Date.now()}` })}>{live ? 'Update' : 'Send it'}</button>
          <button className="btn lg" style={{ flex: 1 }} disabled={!draft.text} onClick={() => setPreview(true)}>Preview</button>
        </div>
        {cur && <button className="btn ghost" disabled={busy} onClick={() => { setText(''); save(null) }}>Remove my message</button>}
      </div>
      <p className="note" style={{ marginTop: 10 }}>It pops up the next time each person opens the app, even if they already saw today's hello.</p>
      {preview && <MorningScreen me={me} brokerage={brokerage} preview={draft} onClose={() => setPreview(false)} />}
    </section>
  )
}
