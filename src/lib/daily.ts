// The good-morning screen: one line a day, the same for everyone on the team.
// Original lines. Where an idea comes from a book, the book gets the credit.

export interface Line { text: string; from?: string }

const AH = 'An idea from Atomic Habits'
const OT = 'An idea from The ONE Thing'

export const LINES: Line[] = [
  { text: 'Small touches, every day, add up to a database that sends you business for years.', from: AH },
  { text: "Goals point the way. Habits decide where you actually land. Make today's rocks the habit.", from: AH },
  { text: "Every touch you log is a little proof of the agent you're becoming.", from: AH },
  { text: "Make it easy. Open Today, tap the first name, and you've already started.", from: AH },
  { text: "Missed a day? No big deal. Just don't let it turn into two.", from: AH },
  { text: 'Getting 1% better every day sounds small. Over a year, it changes everything.', from: AH },
  { text: "Don't wait to feel motivated. Start, and the motivation tends to show up.", from: AH },
  { text: 'Put the work where you can see it. That is what your rocks are for.', from: AH },
  { text: 'A streak is just a promise you keep to yourself, one day at a time.', from: AH },
  { text: "Systems beat goals. The goal is a great year. The system is today's list.", from: AH },
  { text: 'Pick the one task today that makes the rest of the list lighter. Do it first.', from: OT },
  { text: 'Success is built one domino at a time. Today, the domino is your first call.', from: OT },
  { text: 'Block the time first. Your people deserve a spot on your calendar, not your leftovers.', from: OT },
  { text: 'Going small is how you go big. Do the few things that matter, and do them first.', from: OT },
  { text: "Busy isn't the same as productive. Touch your people before the inbox touches you.", from: OT },
  { text: 'Say yes to the one thing, and it gets a lot easier to say no to the noise.', from: OT },
  { text: "Your database is your business. Treat today's list like your most important appointment." },
  { text: "It's always scarier in your head than on the phone. Make the first call." },
  { text: 'Nobody remembers the market report. Everyone remembers the handwritten card.' },
  { text: "You're not bothering people. You're the one who remembered." },
  { text: "Referrals don't come from being good. They come from being good and being remembered." },
  { text: 'One honest "thinking of you" beats ten "just checking in" texts.' },
  { text: 'Be the agent they call before they call anyone else.' },
  { text: 'Five minutes on the phone today can be a closing next spring.' },
  { text: 'Stack the rocks first. Everything else in your day goes better after.' },
  { text: "Consistency isn't flashy. That's why so few people do it, and why it works." },
  { text: 'The best time to call was last month. The second best time is this morning.' },
  { text: 'Ask about their kids, their job, their dog. Real estate can wait two minutes.' },
  { text: "A pop-by is a hug with a delivery receipt. Go make someone's day." },
  { text: 'Write it like you talk. People keep cards that sound like you.' },
  { text: 'Your past clients are rooting for you. Give them a reason to say your name.' },
  { text: 'Leave people better than you found them, starting with the first person on your list.' },
  { text: 'Faith, integrity, transparency. And a phone call today.' },
  { text: 'Pipeline problems are usually contact problems. You have the fix right here.' },
  { text: "Don't count the days. Make the days count, one touch at a time." },
  { text: 'You get to do this. You get to build something that lasts.' },
  { text: 'Good agents work hard. Great agents work the same way every day.' },
  { text: 'The person who comes to mind first is the one who showed up most.' },
  { text: 'Your future self is grateful for every call you make today.' },
  { text: "Done is better than perfect. Send the text you've been drafting in your head." },
  { text: 'Every rock you stack is a little more solid ground under your business.' },
  { text: "You'll never regret the call. You'll only regret the one you didn't make." },
  { text: 'Make a list. Work the list. Celebrate the list. Repeat tomorrow.' },
  { text: 'People do business with people they like, trust, and remember. Be all three today.' },
  { text: 'The work you do today shows up in your bank account in 90 days.' },
  { text: 'Slow is smooth. Smooth is fast. A steady day beats a frantic week.' },
  { text: "Start with the person you've been avoiding. The rest of the list gets easy." },
  { text: "A thank-you card costs a stamp. It's worth a referral." },
  { text: "Your sphere isn't a list of leads. It's a list of people. Treat them that way." },
  { text: "Today doesn't have to be big. It just has to be done." },
]

/** Today's line: the same for everyone, and it doesn't repeat until the list runs out. */
export function lineFor(day: string): Line {
  const n = Math.floor(Date.parse(`${day}T12:00:00Z`) / 86400000)
  return LINES[((n % LINES.length) + LINES.length) % LINES.length]
}

/** A message from the broker, shown on the good-morning screen every day from start through end. */
export interface MorningNote { id: string; text: string; from: string; starts: string; ends: string }
