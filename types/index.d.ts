/** How a footer segment is colored: green, yellow, red, or dim. */
export type UsageMeterLevel = 'ok' | 'warn' | 'high' | 'dim'

/** One run of the footer readout and its color. */
export type UsageMeterSegment = { text: string; level: UsageMeterLevel }

/** One rate-limit window as the engine reports it (its SessionRateLimit). */
export type UsageMeterWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** A set of windows and when they were read, in epoch ms. */
export type UsageMeterReading = { windows: UsageMeterWindow[]; observedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      /** The footer readout. */
      segments: UsageMeterSegment[]
      /** This session's own latest reading; kept across hot reloads. */
      live: UsageMeterReading | null
      /** Whether a main-loop turn is running. */
      isInTurn: boolean
      /** Highest threshold this session has told the model mid-turn, per window instance. */
      told: Record<string, number>
      /** A mid-turn note is waiting for the running turn's next model request. */
      isTellPending: boolean
    }
  }
}
