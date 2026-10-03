# movement/ — ADS-B traffic counts (poller/movement.mjs)

- `state.json`: last snapshot per airport (aircraft as [state, nm, alt ft, track, gs kt, landed flag, lat, lon, airline]),
  the last ~2 h of per-run counts (`recent`: [unix s, new departure hexes, new arrival hexes, departures by airline]),
  the last 3 finished hours (`hrs`), rotation start (`next`) and field elevations (`elev`: [ft, source]).
- `baseline.json`: per airport and hour of week (local, 0 = Sunday 00): up to 4 finished hours as
  [departures/hr, arrivals/hr, {airline: departures/hr}, date], from hours with at least 50% coverage.
- `YYYY/MM/DD.jsonl`: one line per run (UTC): {t, src, skip?, airports: {IATA: {dep, arr, taxi, ground, holding, coverage, byAirline}}}.
  dep/arr = departures/arrivals first counted in that run (summing an hour's lines gives its raw count);
  coverage = snapshots in the last hour / 12.
- `sample.json`: one raw feed response (first 60 KB), refreshed once per UTC hour, for format checks.

Aircraft data: adsb.fi (https://adsb.fi; personal, non-commercial use), fallback ADSB.lol (ODbL 1.0, © ADSB.lol contributors).
