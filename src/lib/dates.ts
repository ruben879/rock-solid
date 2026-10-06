// All dates are handled as local calendar days in 'YYYY-MM-DD' form.
export const DAY = 86_400_000

export function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parse(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

export function today(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12)
}

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)
export const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY)

export function weekStart(d = today()): Date {
  return addDays(d, -((d.getDay() + 6) % 7)) // Monday
}

export function monthStart(d = today()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12)
}

export const fmt = (s: string | Date) =>
  (typeof s === 'string' ? parse(s) : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export const monthName = (d = today()) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
