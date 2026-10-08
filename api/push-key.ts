import { vapid } from './_push.js'

// Gives the app the public half of the push key so a phone can sign up for reminders.
export default async function handler(_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) {
  try {
    const k = await vapid()
    res.status(200).json({ key: k.public_key })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
}
