import { useEffect, useRef, useState } from 'react'
import type { Contact, Profile } from '../lib/model'
import { dailyForPeople, dailyFromPeople, planNumbers } from '../lib/model'
import * as api from '../lib/data'
import { store, useToast } from '../ui'

type Plan = { income: number; cap: number; price: number; rate: number; conversion: number }
type Field = keyof Plan
type Q = { key: Field; q: string; hint: string; chips: number[]; money?: boolean; pct?: boolean }

const QUESTIONS: Q[] = [
  { key: 'income', q: 'How much do you want to take home this year?', hint: 'What lands in your pocket after splits and fees.', chips: [60000, 80000, 100000, 150000], money: true },
  { key: 'cap', q: 'What do you pay the brokerage in a year?', hint: 'Your cap, splits and fees added up. Put 0 if you are not sure yet.', chips: [0, 5000, 10000, 15000], money: true },
  { key: 'price', q: 'What is your average sale price?', hint: 'A good guess is fine. You can change it any time.', chips: [200000, 250000, 275000, 325000], money: true },
  { key: 'rate', q: 'What is your commission rate?', hint: 'Your side of a typical deal.', chips: [2.5, 2.7, 3], pct: true },
  { key: 'conversion', q: 'Out of every 100 people you know well, how many buy, sell or refer someone in a year?', hint: 'Most agents land around 10 to 12.', chips: [8, 10, 12, 15], pct: true },
]

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const short = (n: number) => (n === 0 ? '$0' : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`)

/** Open the goal setup from anywhere. */
export const openGoalWizard = () => window.dispatchEvent(new Event('rs-goal-wizard'))
const seenKey = (id: string) => `rs-goalwiz-${id}`

/**
 * Goal setup, one question at a time. Opens on its own the first time (when there's no plan yet),
 * and any time from the Getting started list. Fills in the plan and the daily goal on Progress.
 */
export function GoalWizardHost({ me, agent, contacts, onSaved }: { me: Profile; agent: Profile; contacts: Contact[]; onSaved?: () => void }) {
  const [open, setOpen] = useState(() => {
    const empty = !agent.plan || Object.keys(agent.plan).length === 0
    return empty && !store.get<boolean>(seenKey(agent.id), false)
  })
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('rs-goal-wizard', show)
    return () => window.removeEventListener('rs-goal-wizard', show)
  }, [])
  useEffect(() => { if (open) store.set(seenKey(agent.id), true) }, [open, agent.id])
  if (!open) return null
  return <GoalWizard me={me} agent={agent} contacts={contacts} onClose={() => setOpen(false)} onSaved={onSaved} />
}

function GoalWizard({ me, agent, contacts, onClose, onSaved }: { me: Profile; agent: Profile; contacts: Contact[]; onClose: () => void; onSaved?: () => void }) {
  const start = { income: 80000, cap: 0, price: 275000, rate: 2.7, conversion: 12, ...(agent.plan ?? {}) }
  const [p, setP] = useState<Plan>({ income: start.income, cap: start.cap, price: start.price, rate: start.rate, conversion: start.conversion })
  const [step, setStep] = useState(0)
  const [mode, setMode] = useState<'goals' | 'custom'>(agent.plan?.auto_goals === 0 ? 'custom' : 'goals')
  const [custom, setCustom] = useState(agent.daily_goal || 5)
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const toast = useToast()

  const { gci, deals, dbNeeded } = planNumbers(p)
  const have = contacts.length
  const planDaily = dailyForPeople(dbNeeded, contacts, agent)
  const peopleDaily = dailyFromPeople(contacts, agent)
  const autoDaily = peopleDaily || planDaily
  const daily = mode === 'goals' ? autoDaily : Math.max(1, custom)

  // 0 intro, 1-5 questions, 6 your year, 7 daily touches, 8 done
  const LAST = 8
  const q = step >= 1 && step <= 5 ? QUESTIONS[step - 1] : null
  const close = () => { setLeaving(true); setTimeout(onClose, 200) }
  const next = () => setStep((s) => Math.min(LAST, s + 1))
  const back = () => setStep((s) => Math.max(0, s - 1))

  async function finish() {
    setSaving(true)
    try {
      await api.updateMyProfile(me, {
        plan: { ...(agent.plan ?? {}), ...p, auto_goals: mode === 'goals' ? 1 : 0 },
        daily_goal: daily, weekly_goal: daily * 5,
      })
      onSaved?.()
      setStep(LAST)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`gwiz${leaving ? ' out' : ''}`} role="dialog" aria-label="Set your goals">
      <div className="gwiz-top">
        {step > 0 && step < LAST
          ? <button className="gwiz-x" onClick={back} aria-label="Back">‹</button>
          : <span className="gwiz-x" />}
        <div className="gwiz-bar"><i style={{ width: `${(step / LAST) * 100}%` }} /></div>
        <button className="gwiz-x" onClick={close} aria-label="Close">×</button>
      </div>

      <div className="gwiz-body" key={step}>
        {step === 0 && (
          <>
            <div className="gwiz-kicker">Your year, in a minute</div>
            <h2>Let's set your goals.</h2>
            <p className="gwiz-hint">A few quick questions. Rock Solid turns your answers into how many people you need and how many to reach each day. You can change any of it later on Progress.</p>
          </>
        )}

        {q && (
          <>
            <div className="gwiz-kicker">Question {step} of 5</div>
            <h2>{q.q}</h2>
            <p className="gwiz-hint">{q.hint}</p>
            <BigNumber key={q.key} value={p[q.key]} money={q.money} pct={q.pct} onChange={(n) => setP({ ...p, [q.key]: n })} onEnter={next} />
            <div className="chips gwiz-chips">
              {q.chips.map((c) => (
                <button key={c} aria-pressed={p[q.key] === c} onClick={() => setP({ ...p, [q.key]: c })}>{q.money ? short(c) : `${c}%`}</button>
              ))}
            </div>
          </>
        )}

        {step === 6 && (
          <>
            <div className="gwiz-kicker">Here is your year</div>
            <h2>{deals} closings gets you there.</h2>
            <div className="stats gwiz-stats">
              <div className="stat"><div className="n">{money(gci)}</div><div className="l">To earn</div></div>
              <div className="stat"><div className="n">{deals}</div><div className="l">Closings</div></div>
              <div className="stat"><div className="n">{dbNeeded}</div><div className="l">People you need</div></div>
              <div className="stat"><div className="n">{have}</div><div className="l">People you have</div></div>
            </div>
            <p className="gwiz-hint">
              {have >= dbNeeded
                ? 'You already know enough people for this plan. Now it is about staying close to them.'
                : have
                  ? `${dbNeeded - have} more people to go. Add them as you think of them; the plan grows with you.`
                  : `Bring in your people next. ${dbNeeded} relationships, cared for well, carry this plan.`}
            </p>
          </>
        )}

        {step === 7 && (
          <>
            <div className="gwiz-kicker">Last one</div>
            <h2>How many people do you want to reach each day?</h2>
            <div className="gwiz-opts">
              <button className={`gwiz-opt${mode === 'goals' ? ' on' : ''}`} onClick={() => setMode('goals')}>
                <span className="gwiz-dot" />
                <span>
                  <b>Based on my goals</b>
                  <small>
                    {have
                      ? `${autoDaily} a day for the ${have} people you have now, building toward about ${planDaily} as you reach ${dbNeeded}. It adjusts on its own.`
                      : `About ${planDaily} a day for your plan. It adjusts on its own as you add and tag people.`}
                  </small>
                </span>
              </button>
              <button className={`gwiz-opt${mode === 'custom' ? ' on' : ''}`} onClick={() => setMode('custom')}>
                <span className="gwiz-dot" />
                <span>
                  <b>Custom</b>
                  <small>Pick your own number and keep it there.</small>
                </span>
              </button>
            </div>
            {mode === 'custom' && (
              <div className="gwiz-step">
                <button className="btn" aria-label="Fewer" onClick={() => setCustom((n) => Math.max(1, n - 1))}>−</button>
                <div><b>{Math.max(1, custom)}</b><small>a day · {Math.max(1, custom) * 5} a week</small></div>
                <button className="btn" aria-label="More" onClick={() => setCustom((n) => Math.min(30, n + 1))}>+</button>
              </div>
            )}
          </>
        )}

        {step === LAST && (
          <>
            <div className="gwiz-check">✓</div>
            <h2>You're set.</h2>
            <p className="gwiz-hint">{daily} {daily === 1 ? 'person' : 'people'} a day, {daily * 5} a week. Each morning Today shows who to reach. A few genuine check-ins a day is all it takes.</p>
            {!have && <p className="gwiz-hint">Next up: bring in your people from the Getting started list.</p>}
          </>
        )}
      </div>

      <div className="gwiz-foot">
        {step === 0 && <button className="btn primary gwiz-go" onClick={next}>Let's go</button>}
        {step >= 1 && step <= 6 && <button className="btn primary gwiz-go" onClick={next}>Next</button>}
        {step === 7 && <button className="btn primary gwiz-go" disabled={saving} onClick={finish}>{saving ? 'Saving…' : 'Save my goals'}</button>}
        {step === LAST && <button className="btn primary gwiz-go" onClick={close}>See my day</button>}
        {step === 0 && <button className="btn ghost gwiz-later" onClick={close}>Maybe later</button>}
      </div>
    </div>
  )
}

/** One big number to type, with $ or % beside it. */
function BigNumber({ value, money: isMoney, pct, onChange, onEnter }: { value: number; money?: boolean; pct?: boolean; onChange: (n: number) => void; onEnter: () => void }) {
  const show = (n: number) => (isMoney ? n.toLocaleString('en-US') : String(n))
  const [text, setText] = useState(show(value))
  const focused = useRef(false)
  const fresh = useRef(false)
  useEffect(() => { if (!focused.current) setText(show(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="gwiz-num">
      {isMoney && <span>$</span>}
      <input
        inputMode={pct ? 'decimal' : 'numeric'} aria-label="Your answer" value={text}
        style={pct ? { flex: 'none', width: `${Math.max(1, text.replace(/\./g, "").length) * 0.64 + (text.includes(".") ? 0.3 : 0) + 0.1}em` } : undefined}
        onFocus={(e) => { focused.current = true; fresh.current = true; const el = e.target; setTimeout(() => el.select(), 0) }}
        onMouseUp={(e) => { if (fresh.current) { e.preventDefault(); (e.target as HTMLInputElement).select(); fresh.current = false } }}
        onBlur={() => { focused.current = false; setText(show(value)) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); onEnter() } }}
        onChange={(e) => {
          fresh.current = false
          let v = e.target.value.replace(pct ? /[^0-9.]/g : /[^0-9]/g, '')
          if (pct) v = v.replace(/(\..*)\./g, '$1')
          v = v.replace(/^0+(?=\d)/, '')
          const n = Number(v) || 0
          setText(v)
          onChange(n)
        }}
      />
      {pct && <span>%</span>}
    </label>
  )
}
