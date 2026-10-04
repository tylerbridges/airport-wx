# changes/ — per-airport change log (poller/changes.mjs)

- `state.json`: the last status seen per airport (programs, closure, warnings, ops-plan possible ground stop, and
  debounced level / delay word / movement as {v, p?: pending {t, v}}) plus `recent`, the last 36 h of events.
- `YYYY/MM/DD.jsonl`: one line per event (UTC day of the event): {t, iata, kind, from, to, sentence, cause?, prog?}.
  Kinds: level, program_start, program_end, program_extend, closure_start, closure_end, warning, word,
  plan_gs_add, plan_gs_drop, movement. Level, word and movement changes count only once they have held for
  10 minutes (t = when first seen). The page shows the sentences with the time in front ("3:10 PM Ground stop started (storms)").
