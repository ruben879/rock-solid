// Lets `npm test` load the app's .ts files the way the server build does: an import of './x.js' finds './x.ts'.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.startsWith('file:')) {
    const ts = new URL(spec.replace(/\\.js$/, '.ts'), ctx.parentURL)
    if (!existsSync(fileURLToPath(new URL(spec, ctx.parentURL))) && existsSync(fileURLToPath(ts))) return next(ts.href, ctx)
  }
  return next(spec, ctx)
}`))
