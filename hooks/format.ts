import type { SessionRateLimit } from 'claude-code'

/** A set of rate-limit windows and when they were read, in epoch ms. */
export type Reading = { windows: SessionRateLimit[]; observedAt: number }

/** The highest threshold toasted so far, per window instance (`alertKey`). */
export type Alerted = Record<string, number>

/** One threshold a window has newly crossed. */
export type Crossing = { window: SessionRateLimit; threshold: number }

export const WARN_AT = [75, 90, 95] as const
/** At or past these, the note tells the model to save usage. */
export const NUDGE_AT: Readonly<Record<string, number>> = { five_hour: 85, seven_day: 90 }
/** A reading older than this is marked as possibly behind. */
export const STALE_MS = 10 * 60_000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const LONG: Readonly<Record<string, string>> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  spend_limit: 'spend limit',
}
const SHORT: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

const longName = (kind: string) => LONG[kind] ?? kind
const shortName = (kind: string) => SHORT[kind] ?? kind

/** The engine's offset for `ms`, in minutes east of UTC (DST-correct per instant). */
export const localOffset = (ms: number) => -new Date(ms).getTimezoneOffset()

/** `1h28m`, `4d18h`, `12m`, `<1m`. */
export function duration(ms: number): string {
  if (ms < MINUTE) return '<1m'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) {
    const m = Math.floor((ms % HOUR) / MINUTE)
    return `${Math.floor(ms / HOUR)}h${m ? `${m}m` : ''}`
  }
  const h = Math.floor((ms % DAY) / HOUR)
  return `${Math.floor(ms / DAY)}d${h ? `${h}h` : ''}`
}

/** Wall-clock parts of `ms` at `offsetMin` east of UTC. */
const wall = (ms: number, offsetMin: number) => new Date(ms + offsetMin * MINUTE)
const pad = (n: number) => String(n).padStart(2, '0')

/** `16:00`, or `Mon 09:00` when `ms` falls on another local day than `now`. */
export function clock(ms: number, now: number, offsetMin?: number): string {
  const at = wall(ms, offsetMin ?? localOffset(ms))
  const today = wall(now, offsetMin ?? localOffset(now))
  const hm = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
  const isSameDay =
    at.getUTCFullYear() === today.getUTCFullYear() &&
    at.getUTCMonth() === today.getUTCMonth() &&
    at.getUTCDate() === today.getUTCDate()
  return isSameDay ? hm : `${DAYS[at.getUTCDay()]} ${hm}`
}

/** `63.5` stays `63.5`, `7` stays `7`, past 100 is kept as reported. */
const pct = (n: number) => `${Number(n.toFixed(1))}%`
const left = (n: number) => `${Number(Math.max(0, 100 - n).toFixed(1))}% left`

const resetMs = (w: SessionRateLimit) => {
  if (w.resetsAt === undefined) return undefined
  const ms = Date.parse(w.resetsAt)
  return Number.isNaN(ms) ? undefined : ms
}

const hasReset = (w: SessionRateLimit, now: number) => {
  const at = resetMs(w)
  return at !== undefined && now >= at
}

/** The rate-limit windows in a stable order: 5h, 7d, then the rest. */
function ordered(windows: readonly SessionRateLimit[]): SessionRateLimit[] {
  const rank = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  return [...windows].sort((a, b) => rank(a.kind) - rank(b.kind))
}

/** The fresher of two readings; either may be missing. */
export function freshest(a: Reading | undefined, b: Reading | undefined): Reading | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return b.observedAt > a.observedAt ? b : a
}

/** Whether a reading holds exactly these windows. */
export function sameWindows(reading: Reading, windows: readonly SessionRateLimit[]): boolean {
  const key = (ws: readonly SessionRateLimit[]) =>
    JSON.stringify(ordered(ws).map(w => [w.kind, w.percentUsed, w.resetsAt ?? null]))
  return key(reading.windows) === key(windows)
}

/** Whether the model should be told to save usage. */
export function isHigh(reading: Reading, now: number): boolean {
  return reading.windows.some(w => {
    const at = NUDGE_AT[w.kind]
    return at !== undefined && w.percentUsed >= at && !hasReset(w, now)
  })
}

function sentence(w: SessionRateLimit, now: number, offsetMin?: number): string {
  const at = resetMs(w)
  const name = longName(w.kind)
  if (at !== undefined && now >= at) {
    return `${name} has reset (ended ${clock(at, now, offsetMin)}); a new one starts with the next message.`
  }
  const resets = at === undefined ? '' : `, resets ${clock(at, now, offsetMin)} (in ${duration(at - now)})`
  return `${name} ${pct(w.percentUsed)} used (${left(w.percentUsed)})${resets}.`
}

const NUDGE =
  'Usage is high: avoid the most expensive models and extra subagents, prefer small direct steps, ' +
  'and before starting any large task tell the user how much is left and when the window resets.'

/** The line attached to each prompt for the model. */
export function buildNote(reading: Reading, now: number, offsetMin?: number): string {
  const age = now - reading.observedAt
  const asOf =
    age > STALE_MS
      ? `as of ${clock(reading.observedAt, now, offsetMin)}, ${duration(age)} ago; may be higher now`
      : `as of ${clock(reading.observedAt, now, offsetMin)}`
  const body = ordered(reading.windows)
    .map(w => sentence(w, now, offsetMin))
    .join(' ')
  const nudge = isHigh(reading, now) ? ` ${NUDGE}` : ''
  return `<usage-meter>Claude plan usage (${asOf}): ${body}${nudge}</usage-meter>`
}

/** The pinned line under the prompt: `5h 63% · resets 16:00 (1h28m) · 7d 41%`. */
export function buildStatus(reading: Reading, now: number, offsetMin?: number): string {
  const parts = ordered(reading.windows).map(w => {
    const name = shortName(w.kind)
    if (hasReset(w, now)) return `${name} reset`
    const at = resetMs(w)
    const p = `${name} ${Math.round(w.percentUsed)}%`
    return w.kind === 'five_hour' && at !== undefined
      ? `${p} · resets ${clock(at, now, offsetMin)} (${duration(at - now)})`
      : p
  })
  const stale = now - reading.observedAt > STALE_MS ? '~' : ''
  return `${stale}${parts.join(' · ')}`
}

export const NO_READING =
  'No usage reading yet. Claude Code learns the plan windows from API responses, so there is ' +
  'none before the first reply of the first session, and none at all off a Pro/Max login (API key).'

/** What the `usage` tool answers. */
export function buildToolText(reading: Reading | undefined, now: number, offsetMin?: number): string {
  if (reading === undefined) return NO_READING
  const body = ordered(reading.windows)
    .map(w => `- ${sentence(w, now, offsetMin)}`)
    .join('\n')
  const read = `Read ${duration(now - reading.observedAt)} ago, at ${clock(reading.observedAt, now, offsetMin)}.`
  const others = 'Other sessions on the same account count too, so a reading can lag behind them.'
  const nudge = isHigh(reading, now) ? `\n\n${NUDGE}` : ''
  return `Claude plan usage:\n${body}\n\n${read} ${others}${nudge}`
}

/** One threshold toast. */
export function alertText(c: Crossing, now: number, offsetMin?: number): string {
  const at = resetMs(c.window)
  const resets = at === undefined ? '' : ` · resets ${clock(at, now, offsetMin)} (in ${duration(at - now)})`
  return `${longName(c.window.kind)} at ${Math.round(c.window.percentUsed)}%${resets}`
}

/** A window instance: its kind and its reset rounded to 10 minutes, so drift doesn't re-alert. */
export function alertKey(w: SessionRateLimit): string {
  const at = resetMs(w)
  return `${w.kind}:${at === undefined ? 'none' : Math.round(at / (10 * MINUTE))}`
}

/**
 * The thresholds the 5h and 7d windows newly crossed, and the alerted set
 * after them, with instances already reset dropped.
 */
export function crossings(
  windows: readonly SessionRateLimit[],
  alerted: Alerted,
  now: number,
): { fresh: Crossing[]; alerted: Alerted } {
  const kept: Alerted = {}
  for (const [key, t] of Object.entries(alerted)) {
    const slot = Number(key.split(':')[1])
    if (Number.isNaN(slot) || slot * 10 * MINUTE > now) kept[key] = t
  }
  const fresh: Crossing[] = []
  for (const w of windows) {
    if (w.kind !== 'five_hour' && w.kind !== 'seven_day') continue
    if (hasReset(w, now)) continue
    const threshold = [...WARN_AT].reverse().find(t => w.percentUsed >= t)
    const key = alertKey(w)
    if (threshold !== undefined && threshold > (kept[key] ?? 0)) {
      fresh.push({ window: w, threshold })
      kept[key] = threshold
    }
  }
  return { fresh, alerted: kept }
}

/** A stored reading, if the value is one. */
export function asReading(value: unknown): Reading | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { windows, observedAt } = value as Record<string, unknown>
  if (typeof observedAt !== 'number' || !Array.isArray(windows)) return undefined
  const ok = windows.every(
    w =>
      typeof w === 'object' &&
      w !== null &&
      typeof (w as SessionRateLimit).kind === 'string' &&
      typeof (w as SessionRateLimit).percentUsed === 'number',
  )
  return ok && windows.length > 0 ? { windows: windows as SessionRateLimit[], observedAt } : undefined
}

/** A stored alerted set, or an empty one. */
export function asAlerted(value: unknown): Alerted {
  if (typeof value !== 'object' || value === null) return {}
  const out: Alerted = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v
  return out
}
