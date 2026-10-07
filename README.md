# usage-meter

A Claude Code plugin that tells Claude how much of your plan usage is left and when each window
resets. It also shows you the same figures under the prompt.

```
claude plugin marketplace add aaugmentum/usage-meter && claude plugin install usage-meter@usage-meter
```

Or in a session: `/plugin marketplace add aaugmentum/usage-meter`, then `/plugin install usage-meter@usage-meter`.
New sessions load it.

## What it does

- **Tells Claude on every prompt.** Each prompt you send carries a hidden note that only Claude reads:
  `<usage-meter>Claude plan usage (as of 14:32): 5-hour window 63% used (37% left), resets 16:00
  (in 1h28m). 7-day window 41% used (59% left), resets Mon 09:00 (in 4d18h).</usage-meter>`.
  The note goes at the end of the prompt, so the prompt cache stays warm.
- **Nudges Claude when usage is high.** At 85% of the 5-hour window or 90% of the 7-day window, the
  note asks Claude to avoid the most expensive models and extra subagents, keep steps small, and tell
  you before starting any large task.
- **Warns Claude mid-turn.** If a window crosses 90% or 95% while Claude is working, the note is
  added to the running turn straight away.
- **Gives Claude a tool.** `mcp__usage-meter__usage` returns the current figures whenever Claude
  wants them, for example before a large fan-out.
- **Shows you a status line**, `5h 63% · resets 16:00 (1h28m) · 7d 41%`, plus a one-time toast at
  75%, 90% and 95% of each window. A leading `~` means the reading is more than 10 minutes old.

The figures come from Claude Code itself (`$.session.usage()` and the `session.measure` event). They
are the ones the API reports with every response, so they include usage from your other sessions
and devices as of that response. The plugin makes no network calls and reads no credentials. Between
sessions it keeps the last reading in its own store, so a new session's first prompt has figures
before any reply arrives.

## Requirements

- Claude Code 2.1.289 or newer: the plugin uses function hooks, which are in early access.
- A Claude Pro or Max login. Under API-key auth there are no plan windows, so the plugin stays
  silent.

## Updating

```
claude plugin update usage-meter@usage-meter
```

## Developing

```
git clone https://github.com/aaugmentum/usage-meter && cd usage-meter
claude plugin validate .
claude plugin test .
claude --plugin-dir .            # try it in a session
```

`hooks/format.ts` holds the pure text and threshold logic, and `hooks/register.ts` holds the hooks.

## License

MIT
