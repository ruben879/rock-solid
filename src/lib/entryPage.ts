// Words on the hosted entry page. No imports: the page (browser) and api/enter.ts (server) both use this file,
// so the consent line stored with each entry is exactly the one the person saw.
export const consentLine = (first: string) =>
  `By entering, you agree ${first} may contact you about this drawing and about local real estate updates.`
export const thanksLine = (first: string) => `You're in! Watch for a message from ${first} when the winner is drawn.`
export const INACTIVE = 'This entry link is no longer active.'
/** "Ruben Trujillo" → { first: "Ruben", shown: "Ruben T." } */
export function agentName(full: string | null | undefined) {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean)
  const first = parts[0] ?? 'Your agent'
  const last = parts.length > 1 ? parts[parts.length - 1] : ''
  return { first, shown: last ? `${first} ${last[0].toUpperCase()}.` : first }
}
export const TOKEN_RE = /^[A-Za-z0-9]{20,64}$/
