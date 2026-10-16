import { useEffect, useState } from 'react'
import type { Profile } from '../lib/model'
import { fmt } from '../lib/dates'
import { markCheerSeen, sendCheer, sentTo, unseenCheers, type Cheer } from '../lib/cheers'
import { Sheet, useToast } from '../ui'

/** Agent side: a note from the broker or coach, full screen, the next time they open the app. */
export function CheerScreen({ me }: { me: Profile }) {
  const [queue, setQueue] = useState<Cheer[]>([])
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const check = () => { if (navigator.onLine) unseenCheers(me.id).then(setQueue, () => {}) }
    check()
    const vis = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [me.id])
  const c = queue[0]
  if (!c) return null
  const done = () => {
    setLeaving(true)
    markCheerSeen(c.id).catch(() => {})
    setTimeout(() => { setQueue((q) => q.slice(1)); setLeaving(false) }, 220)
  }
  return (
    <div className={`morning cheer ${leaving ? 'out' : ''}`} role="dialog" aria-modal="true" aria-label={`A note from ${c.from_name}`} onClick={done}>
      <div className="mwrap" onClick={(e) => e.stopPropagation()}>
        <div className="cheer-ic" aria-hidden>👏</div>
        <p className="mdate">A note from {c.from_name}</p>
        <blockquote className="mquote note-from">
          <p>{c.body}</p>
          <cite>{c.from_name} · {fmt(c.created_at.slice(0, 10))}</cite>
        </blockquote>
        <button className="btn gold lg block" onClick={done}>{queue.length > 1 ? 'Next' : 'Thanks!'}</button>
      </div>
    </div>
  )
}

const STARTERS = [
  'Proud of you. Your consistency this week has been awesome!',
  'Love seeing your rocks stacked. Keep it rolling!',
  'You are building something that lasts. Thank you for showing up.',
  'Great week of reaching out. Your people are lucky to have you.',
]

/** Broker or coach side: write a quick note to one agent. */
export function CheerSheet({ me, to, onClose }: { me: Profile; to: Profile; onClose: () => void }) {
  const toast = useToast()
  const first = (to.full_name ?? '').trim().split(/\s+/)[0] || to.email.split('@')[0]
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [past, setPast] = useState<Cheer[]>([])
  useEffect(() => { sentTo(me.id, to.id).then(setPast, () => {}) }, [me.id, to.id])
  async function send() {
    setBusy(true)
    try {
      await sendCheer(me, to.id, text)
      toast(`Sent. ${first} will see it the next time they open Rock Solid.`)
      onClose()
    } catch (e) { toast((e as Error).message); setBusy(false) }
  }
  return (
    <Sheet label={`Encourage ${first}`} onClose={onClose}>
      <h3>Encourage {first}</h3>
      <p className="note">It pops up full screen the next time {first} opens the app.</p>
      <div className="chips" style={{ marginTop: 10 }}>
        {STARTERS.map((s) => <button key={s} type="button" aria-pressed={text === s} onClick={() => setText(s)}>{s.split('.')[0].split('!')[0]}</button>)}
      </div>
      <textarea style={{ marginTop: 10, width: '100%' }} rows={4} maxLength={500} placeholder={`Write something for ${first}…`} value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn gold lg block" style={{ marginTop: 10 }} disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : `Send to ${first}`}</button>
      {past.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="grp" style={{ marginTop: 0 }}>Recent notes</div>
          {past.map((c) => (
            <div key={c.id} className="hrow" style={{ alignItems: 'flex-start' }}>
              <span style={{ flex: 1, minWidth: 0 }}><small style={{ color: 'var(--ink)' }}>{c.body}</small></span>
              <span className="note" style={{ whiteSpace: 'nowrap' }}>{fmt(c.created_at.slice(0, 10))} · {c.seen_at ? 'Seen' : 'Not yet'}</span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}
