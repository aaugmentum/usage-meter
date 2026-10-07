import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageMeterLevel } from '../types'
import {
  alertText,
  asAlerted,
  asReading,
  buildNote,
  buildToolText,
  crossings,
  freshest,
  sameWindows,
  statusSegments,
  TELL_AT,
  type Reading,
} from './format'

const TOOL = 'usage'
const TOOL_ID = 'mcp__usage-meter__usage'
const TOOL_DESCRIPTION =
  'Claude plan usage right now: how much of the 5-hour and 7-day rate-limit windows is used and ' +
  'left, and when each resets. Call it before large work (subagent fan-out, the most expensive ' +
  'models, long autonomous runs) and when the user asks how much usage is left.'

const MINUTE = 60_000
const COLORS: Record<UsageMeterLevel, string | undefined> = { ok: 'green', warn: 'yellow', high: 'red', dim: undefined }

// The session's values, kept across hot reloads; the store holds what sessions share.
const SEGMENTS = { plugin: 'usage-meter', key: 'segments' } as const
const LIVE = { plugin: 'usage-meter', key: 'live' } as const
const IN_TURN = { plugin: 'usage-meter', key: 'isInTurn' } as const
const TOLD = { plugin: 'usage-meter', key: 'told' } as const
const TELL_PENDING = { plugin: 'usage-meter', key: 'isTellPending' } as const
const segments = atom(SEGMENTS, [])

/** The freshest reading, this session's or one any session saved, and which it is. */
async function current($: EngineInterface): Promise<{ reading: Reading | undefined; isSaved: boolean }> {
  const { rateLimits } = await $.session.usage()
  const saved = asReading(await $.store.get('last'))
  let live = (await $.state.get(LIVE)).value ?? null
  if (rateLimits.length > 0 && (live === null || !sameWindows(live, rateLimits))) {
    if (live !== null) {
      // Figures from a response since the last measurement: no older than now.
      live = { windows: [...rateLimits], observedAt: await $.clock.now() }
    } else if (saved === undefined || sameWindows(saved, rateLimits)) {
      live = { windows: [...rateLimits], observedAt: saved?.observedAt ?? (await $.clock.now()) }
    }
    // Else the plugin loaded into a running session whose figures are of unknown age: trust the saved one.
    if (live !== null) await $.state.set(LIVE, live)
  }
  const reading = freshest(live ?? undefined, saved)
  return { reading, isSaved: reading !== undefined && reading === saved }
}

/** Puts the readout the footer draws; written only when it changed, so the footer redraws only then. */
async function showStatus($: EngineInterface, reading: Reading | undefined) {
  const next = reading ? statusSegments(reading, await $.clock.now()) : []
  const held = await $.state.get(SEGMENTS)
  if (JSON.stringify(held.value ?? []) !== JSON.stringify(next)) await $.state.set(SEGMENTS, next)
}

async function refresh($: EngineInterface) {
  await showStatus($, (await current($)).reading)
}

/** Ends a main-loop turn's bookkeeping: a note still waiting is dropped, the next prompt's note covers it. */
async function setInTurn($: EngineInterface, isInTurn: boolean) {
  await $.state.set(IN_TURN, isInTurn)
  await $.state.set(TELL_PENDING, false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION })
    $.ui.status(undefined) // 0.1.0 pinned a plain status line; the footer readout replaces it
    await refresh($)
    $.clock.every(MINUTE, () => {
      refresh($).catch(() => undefined)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const { reading } = await current($)
    if (reading === undefined) return next(e)
    await showStatus($, reading)
    return next({ ...e, context: [...(e.context ?? []), buildNote(reading, await $.clock.now())] })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await setInTurn($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await setInTurn($, false)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length === 0) return next(e)

    const now = await $.clock.now()
    const live: Reading = { windows: [...e.rateLimits], observedAt: now }
    await $.state.set(LIVE, live)
    await $.store.set('last', live)
    await showStatus($, live)

    // Toasts once per threshold across sessions; each session's own model is told on its own.
    const toast = crossings(live.windows, asAlerted(await $.store.get('alerted')), now)
    if (toast.fresh.length > 0) {
      await $.store.set('alerted', toast.alerted)
      for (const c of toast.fresh) $.ui.toast(alertText(c, now), { timeoutMs: 8000 })
    }
    if ((await $.state.get(IN_TURN)).value === true) {
      const tell = crossings(live.windows, (await $.state.get(TOLD)).value ?? {}, now, TELL_AT)
      await $.state.set(TOLD, tell.alerted)
      // This measurement may be the turn's last (it fires before turn.complete): wait for its next request.
      if (tell.fresh.length > 0) await $.state.set(TELL_PENDING, true)
    }
    return next(e)
  })

  // A pending note joins the running turn as it makes its next model request.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && (await $.state.get(TELL_PENDING)).value === true) {
      await $.state.set(TELL_PENDING, false)
      const { reading } = await current($)
      if (reading !== undefined) {
        const text = buildNote(reading, await $.clock.now())
        // A run no plugin may shape refuses the row; the toast and the next prompt's note still tell.
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
      }
    }
    return yield* next(e)
  })

  // The footer's mode labels (right of the prompt footer): theirs, then the readout.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const segs = await read($, segments)
    if (segs.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const modes = e.props.modes.length > 0 ? [<Text dimColor>{`${e.props.modes.join(' & ')} · `}</Text>] : []
    return (
      <Box>
        {modes}
        {segs.map(s => {
          const color = COLORS[s.level]
          return color ? <Text color={color}>{s.text}</Text> : <Text dimColor>{s.text}</Text>
        })}
      </Box>
    )
  })

  on('tool.call', { tool: TOOL_ID }, async $ => {
    const { reading, isSaved } = await current($)
    return { result: buildToolText(reading, await $.clock.now(), isSaved) }
  }).catch(() => ({ deny: 'usage-meter could not read the usage figures; try /usage.' }))
}
