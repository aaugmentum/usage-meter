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
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__usage-meter__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return { clock, toasts }
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

describe('footer readout', () => {
  test('draws after the mode labels, colored by usage, on every surface that has the footer', async ($, on) => {
    world(on, () => [five(63), { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-12T04:00:00Z' }])
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'SessionMode', props: { modes: ['auto'] } })
      expect((await ui.find({ type: 'Text', text: 'auto · ' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Text', text: '5h 63%' }))?.props.color).toBe('yellow')
      expect((await ui.find({ type: 'Text', text: '7d 85%' }))?.props.color).toBe('red')
      await ui.unmount()
    }
  })

  test('leaves the footer alone with no reading', async ($, on) => {
    world(on, () => [])
    on('ui.render', { component: 'SessionMode' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  })
})

/** The plugin's latest write of `isTellPending`, watched from beneath it. */
function watchPending(on: On) {
  const seen = { value: undefined as unknown }
  on('state.set', ($, e, next) => {
    if (e.plugin === 'usage-meter' && e.key === 'isTellPending') seen.value = e.value
    return next(e)
  })
  return seen
}
const step = (index: number, agentId?: string) => ({
  turnId: 't1',
  index,
  model: 'claude-opus-5-5',
  messageCount: index + 1,
  ...(agentId === undefined ? {} : { agentId }),
})
const complete = (agentId?: string) => ({
  answer: 'done',
  durationMs: 1,
  isAborted: false,
  turnId: agentId ? 'sub' : 't1',
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

describe('mid-turn note', () => {
  test("waits for the turn's next request, and a subagent ending does not end the turn", async ($, on) => {
    world(on, () => [five(91)])
    const pending = watchPending(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.turn.complete(complete('agent-1'))

    await $.session.measure(measure([five(91)]))
    expect(pending.value).toBe(true)

    // A subagent's request does not take it; the main loop's next one does.
    for await (const _ of $.turn.step(step(1, 'agent-1'))) void _
    expect(pending.value).toBe(true)
    for await (const _ of $.turn.step(step(2))) void _
    expect(pending.value).toBe(false)

    // Told once per threshold in this session.
    await $.session.measure(measure([five(92)]))
    expect(pending.value).toBe(false)
  })

  test("is dropped when the crossing comes with the turn's last measurement", async ($, on) => {
    world(on, () => [five(91)])
    const pending = watchPending(on)
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    await $.turn.start({ text: 'work', turnId: 't1' })

    await $.session.measure(measure([five(91)]))
    expect(pending.value).toBe(true)
    await $.turn.complete(complete())

    expect(pending.value).toBe(false)
  })
})

describe('reading freshness', () => {
  test('a plugin loaded into a running session trusts the saved reading over figures of unknown age', async ($, on) => {
    world(on, () => [five(40)], { last: { windows: [five(80)], observedAt: NOW - 60_000 } })
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })

    const r = await $.tool.call({ tool: TOOL_ID, input: {} })

    expect(String(r.result)).toContain('5-hour window 80% used')
    expect(String(r.result)).toContain('saved by an earlier or parallel session')
  })

  test('the minute timer turns the footer to reset once the window has passed', async ($, on) => {
    const w = world(on, () => [five(63)])
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    expect(await ui.find({ type: 'Text', text: '5h 63%' })).toBeDefined()

    await w.clock.advance(90 * 60_000) // past the 11:00 UTC reset
    expect((await ui.find({ type: 'Text', text: '5h reset' }))?.props.color).toBe('green')
    await ui.unmount()
  })
})
