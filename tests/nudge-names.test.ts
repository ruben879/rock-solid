// The morning nudge's words: two people from the person's own Today list, two places further along each day.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { namedPair, queueBody } from '../src/lib/todayQueue.ts'

const P = (full: string) => { const [first_name, ...rest] = full.split(' '); return { first_name, last_name: rest.join(' ') } }
const ruben = ['Maria Lopez', 'James Carter', 'Priya Nair', 'Tom Reed', 'Ana Ruiz'].map(P)
const next = (day: string, n: number) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const DAY1 = '2026-01-01' // the rotation's reference day: the pair starts at the top of the list

test("worked example: Ruben's five, three days running", () => {
  assert.equal(queueBody(ruben, DAY1), 'Maria Lopez, James Carter and 3 others are waiting to hear from you.')
  assert.equal(queueBody(ruben, next(DAY1, 1)), 'Priya Nair, Tom Reed and 3 others are waiting to hear from you.')
  assert.equal(queueBody(ruben, next(DAY1, 2)), 'Ana Ruiz, Maria Lopez and 3 others are waiting to hear from you.')
})

test('the four cases', () => {
  assert.equal(queueBody([], DAY1), null) // the caller keeps today's usual words
  assert.equal(queueBody([P('Cody Grounds')], DAY1), 'Cody Grounds is waiting to hear from you.')
  assert.equal(queueBody([P('Cody Grounds'), P('Ana Ruiz')], DAY1), 'Cody Grounds and Ana Ruiz are waiting to hear from you.')
  assert.equal(queueBody([P('A One'), P('B Two'), P('C Three')], DAY1), 'A One, B Two and 1 other are waiting to hear from you.')
})

test('one person or two: the same words every day', () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(queueBody([P('Cody Grounds')], next('2026-11-24', i)), 'Cody Grounds is waiting to hear from you.')
    assert.equal(queueBody([P('Cody Grounds'), P('Ana Ruiz')], next('2026-11-24', i)), 'Cody Grounds and Ana Ruiz are waiting to hear from you.')
  }
})

test('N is always the list size minus 2, and the pair is two people in a row from the list', () => {
  for (let n = 3; n <= 30; n++) {
    const q = Array.from({ length: n }, (_, i) => i)
    for (let k = 0; k < 40; k++) {
      const day = next('2026-11-01', k)
      const [a, b] = namedPair(q, day)
      assert.equal(b, (a + 1) % n)
      assert.match(queueBody(q.map((i) => P(`P${i} X`)), day)!, new RegExp(`and ${n - 2} ${n - 2 === 1 ? 'other' : 'others'} are`))
    }
  }
})

test('the start moves two places a day, wraps, and names everyone within a few days', () => {
  for (let n = 3; n <= 30; n++) {
    const q = Array.from({ length: n }, (_, i) => i)
    for (let k = 0; k < 60; k++) {
      const today = namedPair(q, next('2026-11-01', k))[0], tomorrow = namedPair(q, next('2026-11-01', k + 1))[0]
      assert.equal(tomorrow, (today + 2) % n)
    }
    const named = new Set<number>()
    for (let k = 0; k < Math.ceil(n / 2) + (n % 2 ? n : 0); k++) namedPair(q, next('2026-11-01', k)).forEach((x) => named.add(x))
    assert.equal(named.size, n, `everyone in a list of ${n} gets named`)
  }
})

test('same list, same day: same pair every time (no stored state)', () => {
  for (let i = 0; i < 5; i++) assert.equal(queueBody(ruben, '2026-11-24'), queueBody(ruben, '2026-11-24'))
})

test('names exactly as stored: first and last, trimmed; a missing last name is just the first', () => {
  assert.equal(queueBody([{ first_name: ' Mary Beth ', last_name: 'Smith-Jones' }], DAY1), 'Mary Beth Smith-Jones is waiting to hear from you.')
  assert.equal(queueBody([{ first_name: 'Cher', last_name: null as unknown as string }], DAY1), 'Cher is waiting to hear from you.')
})
