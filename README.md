# Airport Status

A static page showing weather and delay risk at ~32 major US airports: big airport codes, colored status pills and a 24-hour risk timeline per airport, with a detail sheet in plain English ("Delays & closures", "FAA traffic notices" incl. the FAA Command Center operations plan, "Weather warnings", "Thunderstorms", "Storm outlook", "Storm forecast") and a collapsed "Pilot details" section holding the coded material (decoded and raw METAR, raw TAF, LAMP table, SIGMET and CWA text, TCF tops). Risk reasons stay coded in the data (and history); the page maps them to traveler wording ("Ceiling 400 ft" → "Very low clouds", "Gusts 30 kt" → "Wind gusts to 35 mph", "GDP avg 49m" → "Arrival delays ~49 min"). Sections with nothing in them are hidden; a line at the bottom says which sources were checked, or which failed. Dark-first, inspired by the look of modern flight-tracking apps.

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
- FAA ATCSCC: https://www.fly.faa.gov/adv/advADB.jsp is "The Most Recent ATCSCC Advisory" (a single advisory, not a list). Usually that is the Command Center's **operations plan** ("ATCSCC ADVZY 072 DCC 10/03/2026 OPERATIONS PLAN", body after "RAW TEXT:" in a `<pre>`), parsed by `poller/opsplan.mjs` (see "FAA operations plan"). When it is a program advisory (ground stop, GDP, AFP with "IMPACTING CONDITION"), it is parsed as before; program advisories linked from the page are followed too (up to 40, 4 at a time, 45 s budget). Per control element and program type the latest advisory decides; it is active when it isn't a cancellation (CNX), its period has started and its end is after now.
- NWS alerts per airport: https://api.weather.gov/alerts/active?point=lat,lon
- SPC Day 1 categorical outlook: https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson
- NWS LAMP text bulletin (hourly guidance): `https://nomads.ncep.noaa.gov/pub/data/nccf/com/lmp/prod/lmp.YYYYMMDD/lmp.tHH30z.lavtxt.ascii`, newest HH:30 cycle, stepping back up to 3 hours on 404. Real CONUS blocks have hourly P01/PC1/LP1/LC1/CP1/CC1 rows plus PPO, PCO, P06, POZ, POS, TYP, CLD, CIG, CCG, VIS, CVS, OBV, WGS; there is no LP2/CP2 row, and some blocks (e.g. Hawaii) have no probability rows at all. Per airport and hour: WGS gust (kt, "NG" = 0), `tstmProb` = LP1 (1-hour lightning probability for the hour ending at that column; LP2, 2-hour, only if LP1 is missing), `convProb` = CP1 (1-hour convection probability; CP2 fallback), `probHrs` (1 or 2), CIG and VIS categories, TYP, POZ, PPO. Columns are found by character position under the UTC row (right-justified 3-character fields), so sparse rows such as P06 (a value every 6th column) line up.
- AWC TFM Convective Forecast: https://aviationweather.gov/api/data/tcf?format=geojson (Mar–Oct; empty/204 is normal). Live properties: `validTime`/`issueTime` as "YYYYMMDD_HHMM" (UTC), `coverage` ("sparse" → low; "medium"; "high"/"solid" → high), `confidence`, `tops` ("390", ">400"). Areas containing the airport (or within 10 NM of the edge), with valid time, coverage, confidence and tops.
- AWC Center Weather Advisories: https://aviationweather.gov/api/data/cwa?format=json. Live records: `hazard` ("TS"), `qualifier`, `validTimeFrom`/`validTimeTo` (epoch seconds), `coords` [{lat, lon} as strings], `rawText`. Advisories whose polygon contains the airport or passes within 10 NM of it.

Requests send `User-Agent: airport-wx (github.com/tylerbridges/airport-wx)`, time out after 20 s, and fail independently; a failed source is listed in `sources` and never stops the poll.

LAMP, ATCSCC, TCF and CWA were first written from documentation; on Oct 3 2026 they were checked against real responses from `raw/latest/` on the `history` branch (LAMP: LP1/CP1 instead of LP2; ATCSCC: the page is the operations plan; TCF: "YYYYMMDD_HHMM" times; CWA matched). The fixtures `lamp.txt`, `atcscc.html`, `tcf.json` and `cwa.json` are those real formats, with only their times turned into template tokens. Parsers return empty results on anything unexpected.

Convective SIGMETs, CWAs and TCF areas count an airport as affected when it is inside the polygon, on its edge, or within 10 NM of it (`NEAR_NM` in `poller/lib.mjs`): SIGMET 80E on Oct 3 2026 ("FROM 30NNW CLT-20N CLT-CLT-30NNW SPA") had CLT as a vertex and plain ray casting missed it.

### FAA operations plan

`poller/opsplan.mjs` reads the DCC operations plan: advisory number, date, issue time (signature line), EVENT TIME, the narrative paragraph between the rules of underscores, and these sections (headers are lines ending in ":"):

- STAFFING TRIGGER(S): "UNTIL 0100 -BNA OPERATIONS" → {facility, detail, until}. "UNTIL hhmm" (UTC) rolls past midnight relative to the issue time.
- TERMINAL CONSTRAINTS: "CLT/ATL/MCO/TPA/IAH/HOU - VCTS", "N90 - WIND" → per airport {reason}.
- TERMINAL ACTIVE / PLANNED: "UNTIL 0059 -SAN GROUND DELAY PROGRAM", "UNTIL 2300 -MCO/TPA GROUND STOP POSSIBLE", "… GROUND STOP/DELAY PROGRAM POSSIBLE" → {airports, program: GS|GDP|GS/GDP, status: active|possible, until}.
- RUNWAY/EQUIPMENT/…(SIRs): "DEN - RWY 16R/34L CLOSED UNTIL 11/05/2026 0000Z" (2- or 4-digit years) → {airport, item, status: closed|limited|out of service|construction|maintenance, runways, until}.
- EN ROUTE CONSTRAINTS/ACTIVE/PLANNED, CDRS/SWAP/…, AIRSPACE FLOW PROGRAM(S) ACTIVE/PLANNED, PLANNED LAUNCH/REENTRY (name, site, primary and backup windows): national lists.
- Narrative sentences with DELAY/DEVIATION name airports ("ZJX REPORTS THAT TPA AND MCO ARE STILL EXPERIENCING SOME DEVIATIONS …, AND DELAYS WILL CONTINUE").

Facility → airports (`FACILITY_AIRPORTS`): N90 → JFK/LGA/EWR; A80 → ATL; C90 → ORD/MDW; NCT → SFO/OAK/SJC; SCT → LAX/SAN/SNA/BUR/ONT/LGB; D10 → DFW/DAL; I90 → IAH/HOU; PCT → DCA/IAD/BWI; A90 → BOS; D01 → DEN; L30 → LAS; P50 → PHX; M98 → MSP; S46 → SEA; F11 → MCO; A11 → ANC; HCF → HNL; in staffing triggers MIA (TRACON) → MIA/FLL. Any other 3-letter code is the airport itself (BNA, PHL, CLT). Centers (ZNY, ZJX, ZOA …) map to no airport and go to the national `opsplan` (for a future national summary).

### Program causes

FAA NAS status and ATCSCC programs get a cause class from their reason text (`poller/cause.mjs`): weather, volume, equipment (outages, radar/ILS, frequencies), staffing (incl. ATC zero), runway (construction, closures, configuration), security, airline (company/airline request, IT outage), vip (VIP movement, TFR), space (launch/reentry), other, unknown. The category before the first "/" or ":" wins, else keywords. Programs score by program type alone; the cause only names the reason, e.g. "Ground stop — air traffic control staffing, until 7:30 PM ET" or "Ground stop — airline request (IT outage)".

## Risk levels

0 None (green "Clear"), 1 Low (teal "Minor"), 2 Moderate (amber), 3 High (orange-red), 4 Severe (purple). The highest matching rule wins. Program rules apply whatever the cause.

- **Severe (4):** FAA ground stop or full airport closure (`AD AP CLSD` with no "TO …"/"EXC"/"PPR" qualifier, all runways closed, or a non-NOTAM closure); active ATCSCC ground stop (advisory or ops plan "TERMINAL ACTIVE") not already in the NAS status; thunderstorm with `+` or gusts >= 45 kt; freezing rain; SPC MDT/HIGH; NWS Tornado, Blizzard, Ice Storm, Hurricane, Extreme Wind warnings.
- **High (3):** ground delay program (NAS status, or an active ATCSCC advisory / ops plan GDP not already listed there); TS or VCTS; LIFR (ceiling BKN/OVC/VV < 500 ft or visibility < 1 sm); gusts >= 35 kt; `+SN`, or SN with visibility <= 1/2 sm; FZDZ or PL; SPC ENH; LAMP thunder chance (LP1) >= 40% ("Thunder chance 45% (LAMP)"); TCF high coverage over the airport; Severe Thunderstorm, Winter Storm, Tropical Storm, High Wind warnings; convective SIGMET over (or within 10 NM of) the airport.
- **Moderate (2):** any general arrival/departure delay; IFR (ceiling < 1000 ft or visibility < 3 sm); gusts >= 25 kt; SN; SPC SLGT; LAMP thunder chance (LP1) 20–39%; LAMP convection (CP1) >= 50% when the thunder chance is lower ("Storms likely nearby (LAMP)"); TCF medium coverage; Center Weather Advisory for thunderstorms/convection or IFR over the airport; Winter Weather, Wind, Dense Fog advisories; ops plan "GROUND STOP POSSIBLE" / "DELAY PROGRAM POSSIBLE" until its time ("FAA plans a possible ground stop until 7 PM (storms)", cause from the airport's terminal constraint, else "conditions"); ops plan staffing trigger at the airport or its TRACON until its time ("Air traffic control staffing shortage until 8 PM — delays possible"); ops plan narrative naming the airport with delays/deviations, until the plan's valid end ("FAA reports delays at MCO/TPA expected to continue").
- **Low (1):** MVFR; RA/DZ/BR; SPC MRGL; a single-runway closure ("Runway 7L/25R closed"); an ops plan terminal constraint with no possible/active program ("FAA reports nearby storms affecting arrivals"); an ops plan SIR runway closure or construction ("Runway 16R/34L closed until Nov 4", the airport's local date; never above Low, and not repeated when the NAS status already lists that runway); a SIR glideslope/ILS outage or limited operations, only in hours whose flight category is IFR or LIFR.
- **Informational (0, shown in the sheet, never sets a level):** SPC TSTM ("General thunderstorms possible in the area (no severe risk)"); closures limited to some users (e.g. "CLSD TO NON SKED TRANSIENT GA … EXC 24HR PPR": "Closed to private (non-scheduled, general aviation) flights unless approved 24 hours ahead. Airline flights aren't affected."; size-limited "CLSD TO NON SKED ACFT WINGSPAN MORE THAN 214FT …": "Closed to very large non-scheduled aircraft (747-8/A380 size). Airline flights aren't affected."; "general aviation" only when GA/TRANSIENT/PRIVATE is in the text); closures that haven't started or have ended; SIR glideslope/limited-ops in VFR/MVFR hours; taxiway SIRs; an ops plan program already in the NAS status (NAS wins; if NAS gives no end, the plan's end is used).

Hourly (24 rows from the top of the current hour): the prevailing TAF state per hour from the base group plus FM/BECMG groups (BECMG takes effect at `timeBec` if present, else `timeFrom`); TEMPO groups count at full level; PROB groups count one level lower with "Chance of" in the reason. Hour 0 takes the METAR (the observation wins: TAF conditions are left out of hour 0 when there is a current METAR) and SIGMETs. FAA programs (ground stop, GDP, delays) and active ATCSCC GS/GDP score every hour until their stated end; with no end they hold 3 hours (5 when the delays are increasing) and say "until further notice". Closures and SIR runway closures score hour 0. NWS alerts and CWAs apply to hours between their start and end; the SPC category applies to hours until 12Z next day; each LAMP LP1/CP1 value applies to the hour ending at its column time (LP2/CP2: 2 hours); a TCF area applies within an hour of its valid time. Ranges are written "4–7 PM" only within one day and one AM/PM half, else "11 AM – 2 PM" or "11 PM – 1 AM tomorrow". `now` = hour 0; `peak` = max over 24 hours (earliest hour of that max). Reasons in a box are deduped, with one Visibility/Ceiling/Gusts item each (the highest; the observed one on a tie). Airports are sorted by peak, then now, then IATA code.

The sheet shows one box ("Minor · through 3 AM") while the level holds; a separate "Peak 4–7 PM" box only when the peak is later and higher than now. The card's line uses the same rule.

## status.json

```
{ generated, sources: {metar,taf,sigmet,faa,nws,spc,lamp,atcscc,tcf,cwa: {ok, at, error}},
  opsplan: {plan: {advisory, issued, eventTime, eventText, validEnd}, remarks, staffing[], enroute: {constraints[], active[], planned[]},
            cdrs[], launches: [{name, site, primary: {start, end}, backup}], afp: {active[], planned[]}, sirs[]} | null,
  airports: [{ iata, icao, name, city, state, tz, lat, lon,
    now: {level, reasons[]}, peak: {level, at, reasons[]},
    hours: [24 x {t, level, reasons[], fltCat}],
    metar: {raw, obsTime, fltCat, wind: {dir, spd}, gust, visib, ceiling, wx, temp, dewp} | null,
    taf: {raw, issued} | null,
    faa: [{type: ground_stop|ground_delay|delay|closure, reason, detail, badge, cause, causeLabel,
           (programs:) end (ISO, or null = until further notice), trend: increasing|steady|decreasing|null,
           (closures:) scope: full|runway|limited, active, plain, runways[]}],
    atcscc: [{id, type: GS|GDP|AFP|other, airport, issued, cause, causeText, causeLabel, title, active, cnx, start, end}],
    alerts: [{event, severity, headline, onset, ends}], spc: "ENH"|null, sigmets: [{hazard, raw, validTo}],
    lamp: {issued, hours: [{t, gust, tstmProb, convProb, probHrs, cig, vis, typ, pFrz, pPrecip}]} | null,
    tcf: [{valid, coverage: high|medium|low|null, coverageRaw, confidence, tops, props}],
    cwa: [{hazard, validFrom, validTo, raw}],
    opsplan: {plan: {advisory, issued, validEnd}, staffing[], constraints[], programs[], sirs[], notes[],
              items: [{kind: program|note|staffing|constraint|sir, level, text, cause, until, raw, dup?, ifr?}]} | null }] }
```

## History

The workflow keeps a `history` branch (orphan; created on the first run) with:

- `truth/YYYY/MM/DD.jsonl`: one line per poll with the observed outcomes: each airport's new METAR (skipped when its obsTime was already recorded), the FAA program state with cause classes, ATCSCC advisories that are active or new, and the FAA operations plan (national `opsplan` and each airport's `opsplan` items) on the first line with a new plan. Sources that failed are listed in `down`.
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
