import type { EngineInterface, Register } from 'claude-code'

import {
  alertText,
  asAlerted,
  asReading,
  buildNote,
  buildStatus,
  buildToolText,
  crossings,
  freshest,
  sameWindows,
  type Reading,
} from './format'

const TOOL = 'usage'
const TOOL_ID = 'mcp__usage-meter__usage'
const TOOL_DESCRIPTION =
  'Claude plan usage right now: how much of the 5-hour and 7-day rate-limit windows is used and ' +
  'left, and when each resets. Call it before large work (subagent fan-out, the most expensive ' +
  'models, long autonomous runs) and when the user asks how much usage is left.'

const MINUTE = 60_000

// This session's own reading; the store holds the freshest from any session.
let live: Reading | undefined
let isInTurn = false

async function current($: EngineInterface): Promise<Reading | undefined> {
  const { rateLimits } = await $.session.usage()
  const saved = asReading(await $.store.get('last'))
  if (rateLimits.length > 0) {
    // After a reload `live` is gone; the saved copy of these same figures knows when they were read.
    const known = live ?? (saved && sameWindows(saved, rateLimits) ? saved : undefined)
    live = { windows: rateLimits, observedAt: known?.observedAt ?? (await $.clock.now()) }
  }
  return freshest(live, saved)
}

async function showStatus($: EngineInterface, reading: Reading | undefined) {
  $.ui.status(reading && buildStatus(reading, await $.clock.now()))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION })
    await showStatus($, await current($))
    $.clock.every(MINUTE, () => {
      void current($).then(r => showStatus($, r))
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const reading = await current($)
    if (reading === undefined) return next(e)
    const now = await $.clock.now()
    $.ui.status(buildStatus(reading, now))
    return next({ ...e, context: [...(e.context ?? []), buildNote(reading, now)] })
  })

  on('turn.start', ($, e, next) => {
    isInTurn = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isInTurn = false
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length === 0) return next(e)

    const now = await $.clock.now()
    live = { windows: e.rateLimits, observedAt: now }
    await $.store.set('last', live)
    $.ui.status(buildStatus(live, now))

    const { fresh, alerted } = crossings(live.windows, asAlerted(await $.store.get('alerted')), now)
    if (fresh.length > 0) {
      await $.store.set('alerted', alerted)
      for (const c of fresh) $.ui.toast(alertText(c, now), { timeoutMs: 8000 })
      // Mid-turn the next prompt's note is too late: tell the running loop now.
      if (isInTurn && fresh.some(c => c.threshold >= 90)) {
        const text = buildNote(live, now)
        // A run no plugin may shape refuses the row; the toast and the next prompt's note still tell.
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL_ID }, async $ => ({
    result: buildToolText(await current($), await $.clock.now()),
  }))
}
