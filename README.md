# Airport Status

A static page showing weather and delay risk at ~32 major US airports: big airport codes, colored status pills and a 24-hour risk timeline per airport, with a detail sheet (FAA programs and ATCSCC advisories with their causes, NWS alerts, LAMP guidance, SPC outlook, TFM convective forecast, convective SIGMETs, center weather advisories, decoded and raw METAR, raw TAF). Sections with nothing in them are hidden; a line at the bottom says which sources were checked, or which failed. Dark-first, inspired by the look of modern flight-tracking apps.

Every poll's predictions and observed outcomes are also recorded to the `history` branch (see "History") so a later phase can verify and train a model.

## Architecture

aviationweather.gov does not send CORS headers, so a browser can't call it. Instead:

1. A GitHub Actions workflow (`.github/workflows/poll.yml`) runs every 10 minutes (and on push / manual dispatch).
2. `poller/poll.mjs` fetches every source server-side (each independent, 20 s timeout, per-source `{ok, at, error}`), scores risk with `poller/risk.mjs`, and writes `site/data/status.json`.
3. The workflow uploads `site/` as a Pages artifact and deploys it. Nothing is committed to `main`.
4. After the deploy, `poller/record.mjs` appends to a checkout of the `history` branch and `poller/history.sh` commits and pushes it (see "History"). Those steps are `continue-on-error`, run after the deploy, and can't fail the job.
5. The page (`site/index.html`, `site/app.js`) only reads `./data/status.json` (re-fetched every 2 minutes and when the tab becomes visible). If it 404s it falls back to the committed `site/data/sample.json` and shows a "Sample data" banner.

The poller exits 0 unless every source failed, so a partial outage still deploys; the page lists failed sources ("FAA status unavailable").

## Data sources

- METAR: https://aviationweather.gov/api/data/metar
- TAF: https://aviationweather.gov/api/data/taf
- Convective SIGMETs: https://aviationweather.gov/api/data/airsigmet (point-in-polygon, currently valid CONVECTIVE only)
- FAA NAS status (ground stops, ground delay programs, delays, closures): https://nasstatus.faa.gov/api/airport-status-information. Closure reasons are NOTAM text; `poller/notam.mjs` reads the scope (full airport / particular runways / limited to some users such as GA), the effective times (`YYMMDDHHMM-YYMMDDHHMM`, `PERM`, `EST`; preferred over the Reopen field) and writes a plain-English summary.
- FAA ATCSCC advisories (ground stops, GDPs, AFPs with their "IMPACTING CONDITION"): https://www.fly.faa.gov/adv/advADB.jsp, plus the program advisories linked from it (up to 40, 4 at a time, 45 s budget). Per control element and program type the latest advisory decides; it is active when it isn't a cancellation (CNX), its period has started and its end is after now.
- NWS alerts per airport: https://api.weather.gov/alerts/active?point=lat,lon
- SPC Day 1 categorical outlook: https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson
- NWS LAMP text bulletin (hourly guidance): `https://nomads.ncep.noaa.gov/pub/data/nccf/com/lmp/prod/lmp.YYYYMMDD/lmp.tHH30z.lavtxt.ascii`, newest HH:30 cycle, stepping back up to 3 hours on 404. Per airport and hour: WGS gust (kt, "NG" = 0), LP2 2-hour thunder probability (for the 2 hours ending at that column), CIG and VIS categories, TYP, POZ, PPO. Columns are found from the UTC row (MOS-style right-justified 3-character fields).
- AWC TFM Convective Forecast: https://aviationweather.gov/api/data/tcf?format=geojson (Mar–Oct; empty/204 is normal). Areas containing the airport, with valid time, coverage, confidence and tops.
- AWC Center Weather Advisories: https://aviationweather.gov/api/data/cwa?format=json. Advisories whose polygon contains the airport.

Requests send `User-Agent: airport-wx (github.com/tylerbridges/airport-wx)`, time out after 20 s, and fail independently; a failed source is listed in `sources` and never stops the poll.

LAMP, ATCSCC, TCF and CWA were written from documentation without seeing a live response (the dev sandbox couldn't reach those hosts). Their parsers return empty results on anything unexpected; check `raw/latest/` on the `history` branch for the real formats.

### Program causes

FAA NAS status and ATCSCC programs get a cause class from their reason text (`poller/cause.mjs`): weather, volume, equipment (outages, radar/ILS, frequencies), staffing (incl. ATC zero), runway (construction, closures, configuration), security, airline (company/airline request, IT outage), vip (VIP movement, TFR), space (launch/reentry), other, unknown. The category before the first "/" or ":" wins, else keywords. Programs score by program type alone; the cause only names the reason, e.g. "Ground stop — air traffic control staffing, until 7:30 PM ET" or "Ground stop — airline request (IT outage)".

## Risk levels

0 None (green "Clear"), 1 Low (teal "Minor"), 2 Moderate (amber), 3 High (orange-red), 4 Severe (purple). The highest matching rule wins. Program rules apply whatever the cause.

- **Severe (4):** FAA ground stop or full airport closure (`AD AP CLSD` with no "TO …"/"EXC"/"PPR" qualifier, all runways closed, or a non-NOTAM closure); active ATCSCC ground stop not already in the NAS status; thunderstorm with `+` or gusts >= 45 kt; freezing rain; SPC MDT/HIGH; NWS Tornado, Blizzard, Ice Storm, Hurricane, Extreme Wind warnings.
- **High (3):** ground delay program (NAS status, or an active ATCSCC GDP not already listed there); TS or VCTS; LIFR (ceiling BKN/OVC/VV < 500 ft or visibility < 1 sm); gusts >= 35 kt; `+SN`, or SN with visibility <= 1/2 sm; FZDZ or PL; SPC ENH; LAMP thunder chance (LP2) >= 40% ("Thunder chance 45% (LAMP)"); TCF high coverage over the airport; Severe Thunderstorm, Winter Storm, Tropical Storm, High Wind warnings; convective SIGMET over the airport.
- **Moderate (2):** any general arrival/departure delay; IFR (ceiling < 1000 ft or visibility < 3 sm); gusts >= 25 kt; SN; SPC SLGT; LAMP thunder chance 20–39%; TCF medium coverage; Center Weather Advisory for thunderstorms/convection or IFR over the airport; Winter Weather, Wind, Dense Fog advisories.
- **Low (1):** MVFR; RA/DZ/BR; SPC MRGL; a single-runway closure ("Runway 7L/25R closed").
- **Informational (0, shown in the sheet, never sets a level):** SPC TSTM ("General thunderstorms possible in the area (no severe risk)"); closures limited to some users (e.g. "CLSD TO NON SKED TRANSIENT GA … EXC 24HR PPR": "Closed to private (non-scheduled, general aviation) flights unless approved 24 hours ahead. Airline flights aren't affected."); closures that haven't started or have ended.

Hourly (24 rows from the top of the current hour): the prevailing TAF state per hour from the base group plus FM/BECMG groups (BECMG takes effect at `timeBec` if present, else `timeFrom`); TEMPO groups count at full level; PROB groups count one level lower with "Chance of" in the reason. Hour 0 also takes the METAR, FAA programs, active ATCSCC GS/GDP and SIGMETs. NWS alerts and CWAs apply to hours between their start and end; the SPC category applies to hours until 12Z next day; each LAMP LP2 value applies to the 2 hours ending at its column time; a TCF area applies within an hour of its valid time. `now` = hour 0; `peak` = max over 24 hours (earliest hour of that max). Reasons in a box are deduped, with one Visibility/Ceiling/Gusts item each (the highest; the observed one on a tie). Airports are sorted by peak, then now, then IATA code.

The sheet shows one box ("Minor · through 3 AM") while the level holds; a separate "Peak 4–7 PM" box only when the peak is later and higher than now. The card's line uses the same rule.

## status.json

```
{ generated, sources: {metar,taf,sigmet,faa,nws,spc,lamp,atcscc,tcf,cwa: {ok, at, error}},
  airports: [{ iata, icao, name, city, state, tz, lat, lon,
    now: {level, reasons[]}, peak: {level, at, reasons[]},
    hours: [24 x {t, level, reasons[], fltCat}],
    metar: {raw, obsTime, fltCat, wind: {dir, spd}, gust, visib, ceiling, wx, temp, dewp} | null,
    taf: {raw, issued} | null,
    faa: [{type: ground_stop|ground_delay|delay|closure, reason, detail, badge, cause, causeLabel,
           (closures:) scope: full|runway|limited, active, plain, runways[]}],
    atcscc: [{id, type: GS|GDP|AFP|other, airport, issued, cause, causeText, causeLabel, title, active, cnx, start, end}],
    alerts: [{event, severity, headline, onset, ends}], spc: "ENH"|null, sigmets: [{hazard, raw}],
    lamp: {issued, hours: [{t, gust, tstmProb, cig, vis, typ, pFrz, pPrecip}]} | null,
    tcf: [{valid, coverage: high|medium|low|null, coverageRaw, confidence, tops, props}],
    cwa: [{hazard, validFrom, validTo, raw}] }] }
```

## History

The workflow keeps a `history` branch (orphan; created on the first run) with:

- `truth/YYYY/MM/DD.jsonl`: one line per poll with the observed outcomes: each airport's new METAR (skipped when its obsTime was already recorded), the FAA program state with cause classes, and ATCSCC advisories that are active or new. Sources that failed are listed in `down`.
- `forecast/YYYY/MM/DD.jsonl`: one line per UTC hour (the first poll of the hour) with the predictions: TAF, LAMP, SPC, TCF, CWA, NWS alerts and the 24 hourly risk levels and reasons.
- `raw/latest/`: the first 200 KB of each source's latest raw response, overwritten every poll, plus `sources.json` (ok, error, http status, bytes, url, when captured). This is the place to check live formats.
- `README.md` describing all of it (written on first creation from `poller/record.mjs`).

Lines are compact JSON (nulls/empties dropped, ISO times shortened). Locally: `node poller/poll.mjs --fixtures && node poller/record.mjs /tmp/history` (raw samples go to `.cache/raw`; `--raw <dir>` changes that). `poller/history.sh prepare|push` is the git side the workflow runs; it never creates an orphan branch unless the remote positively has no `history` branch, and on a rejected push rebases once and retries.

Note on size: raw/latest changes every poll, so its old versions accumulate in the branch's git history (a few hundred KB compressed per poll at most).

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
node --test poller/        # or: node poller/run-tests.mjs
```

`--fixtures` reads `poller/fixtures/` instead of the network. Fixture files are templates: tokens like `{{+90}}` (epoch seconds, 90 min from now), `{{h+3}}` (top of the hour + 3 h), `{{iso-10}}`, `{{z-12}}`, `{{dh+3}}` and `{{clock+95 America/Chicago}}` are expanded to the current time so the data always looks current. `--out <path>` changes the output file; the committed `site/data/sample.json` is `node poller/poll.mjs --fixtures --out site/data/sample.json`.
