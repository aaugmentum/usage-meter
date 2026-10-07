import type { On, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { buildNote, NO_READING } from './format'

const NOW = Date.parse('2026-10-07T09:32:00Z')
const TOOL_ID = 'mcp__usage-meter__usage'

const five = (percentUsed: number): SessionRateLimit => ({
  kind: 'five_hour',
  percentUsed,
  resetsAt: '2026-10-07T11:00:00Z',
})

/** The engine beneath the plugin: a clock, a store, and `session.usage` answering `limits()`. */
function world(on: On, limits: () => SessionRateLimit[], stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: limits() } }))
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__usage-meter__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return { clock, toasts, statuses }
}

const measure = (rateLimits: SessionRateLimit[]) => ({
  context: { window: 200_000 },
  rateLimits,
  changed: ['rateLimits' as const],
})

describe('prompt.submit', () => {
  test('attaches exactly one usage note', async ($, on) => {
    world(on, () => [five(63)])
    let context: readonly string[] | undefined
    on('prompt.submit', ($, e) => {
      context = e.context
      return { text: e.text, context: e.context }
    })

    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })

    expect(context).toEqual([buildNote({ windows: [five(63)], observedAt: NOW }, NOW)])
  })

  test('adds nothing when there is no reading', async ($, on) => {
    world(on, () => [])
    let context: readonly string[] | undefined = ['sentinel']
    on('prompt.submit', ($, e) => {
      context = e.context
      return { text: e.text }
    })

    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })

    expect(context).toBeUndefined()
  })
})

describe('session.measure', () => {
  // The kit has no conversation beneath, so the mid-turn append is refused there (and not observable);
  // the hook must survive that and still toast and update the status line.
  test('toasts a threshold once, mid-turn too', async ($, on) => {
    let percent = 50
    const w = world(on, () => [five(percent)])
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    await $.turn.start({ text: 'work', turnId: 't1' })

    percent = 91
    await $.session.measure(measure([five(91)]))
    await $.session.measure(measure([five(92)]))

    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('5-hour window at 91%')
    expect(w.statuses.at(-1)).toContain('5h 92%')
  })

  test('toasts between turns', async ($, on) => {
    const w = world(on, () => [five(91)])
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

    await $.session.measure(measure([five(91)]))

    expect(w.toasts).toEqual([expect.stringContaining('5-hour window at 91%')])
  })
})

describe('usage tool', () => {
  test('answers from the live reading', async ($, on) => {
    world(on, () => [five(40)])
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

    const r = await $.tool.call({ tool: TOOL_ID, input: {} })

    expect(r.deny).toBeUndefined()
    expect(String(r.result)).toContain('5-hour window 40% used (60% left)')
  })

  test('falls back to the reading another session saved', async ($, on) => {
    world(on, () => [], { last: { windows: [five(77)], observedAt: NOW - 60_000 } })
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

    const r = await $.tool.call({ tool: TOOL_ID, input: {} })

    expect(String(r.result)).toContain('5-hour window 77% used')
    expect(String(r.result)).not.toBe(NO_READING)
  })
})
