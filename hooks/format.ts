import type { UsageMeterLevel, UsageMeterReading, UsageMeterSegment, UsageMeterWindow } from '../types'

/** A set of rate-limit windows and when they were read, in epoch ms. */
export type Reading = UsageMeterReading
type Window = UsageMeterWindow

/** The highest threshold reached so far, per window instance (`alertKey`). */
export type Alerted = Record<string, number>

/** One threshold a window has newly crossed. */
export type Crossing = { window: Window; threshold: number }

/** Toasted once each per window instance. */
export const WARN_AT = [75, 90, 95] as const
/** Told to a running turn once each per window instance. */
export const TELL_AT = [90, 95] as const
/** At or past these, the note tells the model to save usage. */
export const NUDGE_AT: Readonly<Record<string, number>> = { five_hour: 85, seven_day: 90 }
/** A reading older than this is marked as possibly behind. */
export const STALE_MS = 10 * 60_000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SLOT = 10 * MINUTE
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

/** An elapsed time, rounded down: `1h28m`, `4d18h`, `12m`, `<1m`. */
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

/** A time left, rounded up to the minute so it agrees with the clock times beside it. */
export const until = (ms: number) => duration(Math.ceil(ms / MINUTE) * MINUTE)

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
/** Whole percent, rounded down so 99.6 never reads as 100. */
const whole = (n: number) => `${Math.floor(n)}%`

const resetMs = (w: Window) => {
  if (w.resetsAt === undefined) return undefined
  const ms = Date.parse(w.resetsAt)
  return Number.isNaN(ms) ? undefined : ms
}

const hasReset = (w: Window, now: number) => {
  const at = resetMs(w)
  return at !== undefined && now >= at
}

/** The rate-limit windows in a stable order: 5h, 7d, then the rest. */
function ordered(windows: readonly Window[]): Window[] {
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
export function sameWindows(reading: Reading, windows: readonly Window[]): boolean {
  const key = (ws: readonly Window[]) => JSON.stringify(ordered(ws).map(w => [w.kind, w.percentUsed, w.resetsAt ?? null]))
  return key(reading.windows) === key(windows)
}

/** Whether the model should be told to save usage. */
export function isHigh(reading: Reading, now: number): boolean {
  return reading.windows.some(w => {
    const at = NUDGE_AT[w.kind]
    return at !== undefined && w.percentUsed >= at && !hasReset(w, now)
  })
}

function sentence(w: Window, now: number, offsetMin?: number): string {
  const at = resetMs(w)
  const name = longName(w.kind)
  if (at !== undefined && now >= at) {
    const next = w.kind === 'five_hour' ? '; a new one starts with the next message' : ''
    return `${name} has reset (ended ${clock(at, now, offsetMin)})${next}.`
  }
  const resets = at === undefined ? '' : `, resets ${clock(at, now, offsetMin)} (in ${until(at - now)})`
  return `${name} ${pct(w.percentUsed)} used (${left(w.percentUsed)})${resets}.`
}

const NUDGE =
  'Usage is high: unless the user asked for them, avoid the most expensive models and extra subagents; ' +
  'prefer small direct steps, and before starting any large task tell the user how much is left and ' +
  'when the window resets.'

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

/** Green under 50%, yellow from 50%, red from 80%. */
export function levelOf(percentUsed: number): UsageMeterLevel {
  return percentUsed >= 80 ? 'high' : percentUsed >= 50 ? 'warn' : 'ok'
}

/** The footer readout, `5h 11% ↻19:50 · 7d 65%`, each window colored by its own level. */
export function statusSegments(reading: Reading, now: number, offsetMin?: number): UsageMeterSegment[] {
  const out: UsageMeterSegment[] = []
  if (now - reading.observedAt > STALE_MS) out.push({ text: '~', level: 'dim' })
  ordered(reading.windows).forEach((w, i) => {
    if (i > 0) out.push({ text: ' · ', level: 'dim' })
    const name = shortName(w.kind)
    if (hasReset(w, now)) {
      out.push({ text: `${name} reset`, level: 'ok' })
      return
    }
    out.push({ text: `${name} ${whole(w.percentUsed)}`, level: levelOf(w.percentUsed) })
    const at = resetMs(w)
    if (w.kind === 'five_hour' && at !== undefined) out.push({ text: ` ↻${clock(at, now, offsetMin)}`, level: 'dim' })
  })
  return out
}

/** The readout as plain text. */
export const segmentsText = (segments: readonly UsageMeterSegment[]) => segments.map(s => s.text).join('')

export const NO_READING =
  'No usage reading yet. Claude Code learns the plan windows from API responses, so there is ' +
  'none before the first reply of the first session, and none at all off a Pro/Max login (API key).'

/** What the `usage` tool answers; `isSaved` when the reading came from another or an earlier session. */
export function buildToolText(reading: Reading | undefined, now: number, isSaved: boolean, offsetMin?: number): string {
  if (reading === undefined) return NO_READING
  const body = ordered(reading.windows)
    .map(w => `- ${sentence(w, now, offsetMin)}`)
    .join('\n')
  const source = isSaved ? 'saved by an earlier or parallel session' : "from this session's latest response"
  const read = `Read ${duration(now - reading.observedAt)} ago, at ${clock(reading.observedAt, now, offsetMin)} (${source}).`
  const others = 'Other sessions on the same account count too, so a reading can lag behind them.'
  const nudge = isHigh(reading, now) ? `\n\n${NUDGE}` : ''
  return `Claude plan usage:\n${body}\n\n${read} ${others}${nudge}`
}

/** One threshold toast. */
export function alertText(c: Crossing, now: number, offsetMin?: number): string {
  const at = resetMs(c.window)
  const resets = at === undefined ? '' : ` · resets ${clock(at, now, offsetMin)} (in ${until(at - now)})`
  return `${longName(c.window.kind)} at ${whole(c.window.percentUsed)}${resets}`
}

/** A window instance: its kind and its reset rounded to 10 minutes, so drift doesn't re-alert. */
export function alertKey(w: Window): string {
  const at = resetMs(w)
  return `${w.kind}:${at === undefined ? 'none' : Math.round(at / SLOT)}`
}

/**
 * The `thresholds` the 5h and 7d windows newly crossed, and the set after
 * them. An instance is dropped once its reset has surely passed (the rounded
 * slot can sit up to half a slot before the real reset), or once its usage
 * reads below the threshold it reached, which only a reset does.
 */
export function crossings(
  windows: readonly Window[],
  alerted: Alerted,
  now: number,
  thresholds: readonly number[] = WARN_AT,
): { fresh: Crossing[]; alerted: Alerted } {
  const kept: Alerted = {}
  for (const [key, t] of Object.entries(alerted)) {
    const slot = Number(key.split(':')[1])
    if (Number.isNaN(slot) || slot * SLOT + SLOT / 2 > now) kept[key] = t
  }
  const fresh: Crossing[] = []
  for (const w of windows) {
    if (w.kind !== 'five_hour' && w.kind !== 'seven_day') continue
    if (hasReset(w, now)) continue
    const key = alertKey(w)
    if ((kept[key] ?? 0) > w.percentUsed) delete kept[key]
    const threshold = [...thresholds].sort((a, b) => b - a).find(t => w.percentUsed >= t)
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
      typeof (w as Window).kind === 'string' &&
      typeof (w as Window).percentUsed === 'number',
  )
  return ok && windows.length > 0 ? { windows: windows as Window[], observedAt } : undefined
}

/** A stored alerted set, or an empty one. */
export function asAlerted(value: unknown): Alerted {
  if (typeof value !== 'object' || value === null) return {}
  const out: Alerted = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v
  return out
}
