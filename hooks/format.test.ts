import { describe, expect, test } from 'claude-code/testing'

import {
  asReading,
  buildNote,
  buildStatus,
  buildToolText,
  crossings,
  duration,
  NO_READING,
  sameWindows,
  type Reading,
} from './format'

// Wed 2026-10-07 14:32 at +05:00 (Asia/Tashkent); every call pins that offset.
const NOW = Date.parse('2026-10-07T09:32:00Z')
const TZ = 300
const MIN = 60_000

const five = (percentUsed: number, resetsAt = '2026-10-07T11:00:00Z') => ({ kind: 'five_hour', percentUsed, resetsAt })
const week = (percentUsed: number) => ({ kind: 'seven_day', percentUsed, resetsAt: '2026-10-12T04:00:00Z' })
const reading = (windows: Reading['windows'], observedAt = NOW): Reading => ({ windows, observedAt })

describe('duration', () => {
  test('picks the two largest units', () => {
    expect(duration(59_000)).toBe('<1m')
    expect(duration(12 * MIN)).toBe('12m')
    expect(duration(88 * MIN)).toBe('1h28m')
    expect(duration(120 * MIN)).toBe('2h')
    expect(duration((4 * 24 * 60 + 18 * 60 + 28) * MIN)).toBe('4d18h')
  })
})

describe('buildNote', () => {
  test('states used, left and reset for each window', () => {
    expect(buildNote(reading([week(41), five(63)]), NOW, TZ)).toBe(
      '<usage-meter>Claude plan usage (as of 14:32): ' +
        '5-hour window 63% used (37% left), resets 16:00 (in 1h28m). ' +
        '7-day window 41% used (59% left), resets Mon 09:00 (in 4d18h).</usage-meter>',
    )
  })

  test('nudges at 85% of the 5h window and 90% of the 7d window, not below', () => {
    expect(buildNote(reading([five(84.9), week(89)]), NOW, TZ)).not.toContain('Usage is high')
    expect(buildNote(reading([five(85), week(10)]), NOW, TZ)).toContain('Usage is high')
    expect(buildNote(reading([five(10), week(90)]), NOW, TZ)).toContain('Usage is high')
  })

  test('marks an old reading as possibly behind', () => {
    expect(buildNote(reading([five(63)], NOW - 120 * MIN), NOW, TZ)).toContain('(as of 12:32, 2h ago; may be higher now)')
  })

  test('says a passed window has reset, and does not nudge for it', () => {
    const note = buildNote(reading([five(99, '2026-10-07T08:00:00Z')], NOW - 120 * MIN), NOW, TZ)
    expect(note).toContain('5-hour window has reset (ended 13:00); a new one starts with the next message.')
    expect(note).not.toContain('Usage is high')
  })
})

describe('buildStatus', () => {
  test('shows the 5h countdown and the 7d figure', () => {
    expect(buildStatus(reading([five(63.4), week(41)]), NOW, TZ)).toBe('5h 63% · resets 16:00 (1h28m) · 7d 41%')
  })

  test('prefixes an old reading and collapses a reset window', () => {
    expect(buildStatus(reading([five(63, '2026-10-07T08:00:00Z'), week(41)], NOW - 120 * MIN), NOW, TZ)).toBe(
      '~5h reset · 7d 41%',
    )
  })
})

describe('buildToolText', () => {
  test('answers with no reading', () => {
    expect(buildToolText(undefined, NOW, TZ)).toBe(NO_READING)
  })

  test('lists the windows and the reading age', () => {
    const text = buildToolText(reading([five(91)], NOW - 3 * MIN), NOW, TZ)
    expect(text).toContain('- 5-hour window 91% used (9% left), resets 16:00 (in 1h28m).')
    expect(text).toContain('Read 3m ago, at 14:29.')
    expect(text).toContain('Usage is high')
  })
})

describe('crossings', () => {
  test('alerts each threshold once per window instance', () => {
    const first = crossings([five(76)], {}, NOW)
    expect(first.fresh.map(c => c.threshold)).toEqual([75])

    expect(crossings([five(80)], first.alerted, NOW).fresh).toEqual([])

    const second = crossings([five(96)], first.alerted, NOW)
    expect(second.fresh.map(c => c.threshold)).toEqual([95])

    // The next 5h window is a new instance.
    expect(crossings([five(76, '2026-10-07T16:00:00Z')], second.alerted, NOW).fresh.map(c => c.threshold)).toEqual([75])
  })

  test('ignores a window that has reset and drops passed instances', () => {
    const passed = crossings([five(96, '2026-10-07T08:00:00Z')], { 'five_hour:1': 95 }, NOW)
    expect(passed.fresh).toEqual([])
    expect(passed.alerted).toEqual({})
  })

  test('skips the spend limit', () => {
    expect(crossings([{ kind: 'spend_limit', percentUsed: 99 }], {}, NOW).fresh).toEqual([])
  })
})

describe('stored values', () => {
  test('asReading keeps a reading and rejects anything else', () => {
    expect(asReading(reading([five(1)]))).toEqual(reading([five(1)]))
    expect(asReading({ windows: [], observedAt: 1 })).toBeUndefined()
    expect(asReading({ windows: [{ kind: 'five_hour' }], observedAt: 1 })).toBeUndefined()
    expect(asReading('nope')).toBeUndefined()
  })

  test('sameWindows ignores order', () => {
    expect(sameWindows(reading([five(1), week(2)]), [week(2), five(1)])).toBe(true)
    expect(sameWindows(reading([five(1)]), [five(2)])).toBe(false)
  })
})
