# Airport Weather

A static page showing major-weather and delay risk at ~32 major US airports: big airport codes, colored status pills and a 24-hour risk timeline per airport, with a detail sheet (decoded and raw METAR, raw TAF, FAA programs, NWS alerts, SPC outlook, convective SIGMETs). Dark-first, inspired by the look of modern flight-tracking apps.

## Architecture

aviationweather.gov does not send CORS headers, so a browser can't call it. Instead:

1. A GitHub Actions workflow (`.github/workflows/poll.yml`) runs every 10 minutes (and on push / manual dispatch).
2. `poller/poll.mjs` fetches every source server-side (each independent, 20 s timeout, per-source `{ok, at, error}`), scores risk with `poller/risk.mjs`, and writes `site/data/status.json`.
3. The workflow uploads `site/` as a Pages artifact and deploys it. Nothing is committed back to the repo.
4. The page (`site/index.html`, `site/app.js`) only reads `./data/status.json` (re-fetched every 2 minutes and when the tab becomes visible). If it 404s it falls back to the committed `site/data/sample.json` and shows a "Sample data" banner.

The poller exits 0 unless every source failed, so a partial outage still deploys; the page lists failed sources ("FAA status unavailable").

## Data sources

- METAR: https://aviationweather.gov/api/data/metar
- TAF: https://aviationweather.gov/api/data/taf
- Convective SIGMETs: https://aviationweather.gov/api/data/airsigmet (point-in-polygon, currently valid CONVECTIVE only)
- FAA NAS status (ground stops, ground delay programs, delays, closures): https://nasstatus.faa.gov/api/airport-status-information
- NWS alerts per airport: https://api.weather.gov/alerts/active?point=lat,lon
- SPC Day 1 categorical outlook: https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson

Requests send `User-Agent: airport-wx (github.com/tylerbridges/airport-wx)`.

## Risk levels

0 None (green "Clear"), 1 Low (teal "Minor"), 2 Moderate (amber), 3 High (orange-red), 4 Severe (purple). The highest matching rule wins.

- **Severe (4):** FAA ground stop or closure; thunderstorm with `+` or gusts >= 45 kt; freezing rain; SPC MDT/HIGH; NWS Tornado, Blizzard, Ice Storm, Hurricane, Extreme Wind warnings.
- **High (3):** ground delay program; TS or VCTS; LIFR (ceiling BKN/OVC/VV < 500 ft or visibility < 1 sm); gusts >= 35 kt; `+SN`, or SN with visibility <= 1/2 sm; FZDZ or PL; SPC ENH; Severe Thunderstorm, Winter Storm, Tropical Storm, High Wind warnings; convective SIGMET over the airport.
- **Moderate (2):** any general arrival/departure delay; IFR (ceiling < 1000 ft or visibility < 3 sm); gusts >= 25 kt; SN; SPC SLGT; Winter Weather, Wind, Dense Fog advisories.
- **Low (1):** MVFR; RA/DZ/BR; SPC MRGL or TSTM.

Hourly (24 rows from the top of the current hour): the prevailing TAF state per hour from the base group plus FM/BECMG groups (BECMG takes effect at `timeBec` if present, else `timeFrom`); TEMPO groups count at full level; PROB groups count one level lower with "Chance of" in the reason. Hour 0 also takes the METAR, FAA programs and SIGMETs. NWS alerts apply to hours between onset and ends/expires; the SPC category applies to hours until 12Z next day. `now` = hour 0; `peak` = max over 24 hours (earliest hour of that max). Airports are sorted by peak, then now, then IATA code.

## status.json

```
{ generated, sources: {metar,taf,sigmet,faa,nws,spc: {ok, at, error}},
  airports: [{ iata, icao, name, city, state, tz, lat, lon,
    now: {level, reasons[]}, peak: {level, at, reasons[]},
    hours: [24 x {t, level, reasons[], fltCat}],
    metar: {raw, obsTime, fltCat, wind: {dir, spd}, gust, visib, ceiling, wx, temp, dewp} | null,
    taf: {raw, issued} | null,
    faa: [{type: ground_stop|ground_delay|delay|closure, reason, detail, badge}],
    alerts: [{event, severity, headline, ends}], spc: "ENH"|null, sigmets: [{hazard, raw}] }] }
```

## One-time setup

Repo Settings -> Pages -> Source: **GitHub Actions**. Then run the "Poll and deploy" workflow once (Actions tab -> Run workflow).

## Backtest (baseline accuracy)

`.github/workflows/backtest.yml` (manual: Actions -> "Backtest baseline" -> Run workflow; inputs `months`, default 2, and `airports`, default `all`) replays history through the TAF rules in `poller/risk.mjs`:

- Period: the latest `months` months with a published BTS On-Time zip (current month and the 5 before it are probed); if none is found, the last complete months, weather only.
- Forecasts: historical TAFs from IEM (`cgi-bin/request/taf.py`), parsed by `poller/taf-parse.mjs` into AWC JSON shape and scored per hour with `tafHour`, at lead buckets 0-3, 3-6, 6-12 and 12-24 h (latest TAF issued at or before H - lead). TAF rules only: no FAA/NWS/SPC/SIGMET history.
- Truth: IEM METAR/SPECI (`asos.py`) scored with the same `assessConditions` thresholds (max over the hour), and BTS departures per local scheduled hour (disrupted = >= 20% of departures 15+ min late with weather/NAS delay, or >= 5% weather cancellations; >= 5 departures).
- Output: `reports/baseline-YYYY-MM-DD.md` + `.json` and `reports/samples/` (first 50 KB of the raw IEM TAF/METAR CSVs and the BTS header) committed to the `history` branch and uploaded as an artifact. POD/FAR/CSI/bias per level threshold and phenomenon, confusion matrices, disruption reliability table, persistence and climatology baselines.

Locally: `node tools/backtest.mjs --fixtures` (reads `tools/fixtures/`, writes to the system temp dir unless `--out`). `node poller/run-tests.mjs` runs all unit tests, including `tools/`.

## Local development

```
node poller/poll.mjs --fixtures && python3 -m http.server -d site
node --test poller/
```

`--fixtures` reads `poller/fixtures/` instead of the network. Fixture files are templates: tokens like `{{+90}}` (epoch seconds, 90 min from now), `{{h+3}}` (top of the hour + 3 h), `{{iso-10}}`, `{{z-12}}`, `{{dh+3}}` and `{{clock+95 America/Chicago}}` are expanded to the current time so the data always looks current. `--out <path>` changes the output file; the committed `site/data/sample.json` is `node poller/poll.mjs --fixtures --out site/data/sample.json`.
