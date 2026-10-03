# Airport Status

A static page showing weather and delay risk at ~32 major US airports: big airport codes, colored status pills and a 24-hour risk timeline per airport, with a detail sheet (FAA programs and ATCSCC advisories with their causes, NWS alerts, LAMP guidance, SPC outlook, TFM convective forecast, convective SIGMETs, center weather advisories, decoded and raw METAR, raw TAF). Sections with nothing in them are hidden; a line at the bottom says which sources were checked, or which failed. Dark-first, inspired by the look of modern flight-tracking apps.

Every poll's predictions and observed outcomes are also recorded to the `history` branch (see "History") so a later phase can verify and train a model.

## Product goal

A user should feel confident they're aware of any potential disruption, weather or not. Clean by default (traveler language), detail behind toggles (aviation mode), and never silently wrong (a source failure or stale data is always stated).

## Architecture

aviationweather.gov does not send CORS headers, so a browser can't call it. Instead:

1. A GitHub Actions workflow (`.github/workflows/poll.yml`) runs every 10 minutes (and on push / manual dispatch).
2. `poller/poll.mjs` fetches every source server-side (each independent, 20 s timeout, per-source `{ok, at, error}`), scores risk with `poller/risk.mjs`, and writes `site/data/status.json`.
3. The workflow uploads `site/` as a Pages artifact and deploys it. Nothing is committed to `main`.
4. After the deploy, `poller/record.mjs` appends to a checkout of the `history` branch and `poller/history.sh` commits and pushes it (see "History"). Those steps are `continue-on-error`, run after the deploy, and can't fail the job.
5. The page (`site/index.html`, `site/app.js`) only reads `./data/status.json` (re-fetched every 2 minutes and when the tab becomes visible). If it 404s it falls back to the committed `site/data/sample.json` and shows a "Sample data" banner.

The poller exits 0 unless every source failed, so a partial outage still deploys; the page lists failed sources ("FAA status unavailable").

A Cloudflare Worker ("Live relay" below) can add fresher data on top: when `data/config.json` names it, the page asks it for its starred and visible airports on every open, refresh and every 2 minutes.

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

## Live relay

The Actions build runs every ~5 minutes and the deploy adds a few more, so the page's data is usually 5–15 minutes old. The live relay is a Cloudflare Worker (`worker/worker.mjs`, script name `airport-wx-live`) that answers with data at most about a minute old for the airports the page shows.

- **Endpoints.** `GET /health` → `{ok, version, time}`. `GET /status?ids=ORD,MSP,KFCM` (IATA or ICAO, up to 12; optional `&tz=KFCM:America/Chicago` for airports outside the curated list) → `{live: true, generated, build: {ok, generated}, ids, unknown, sources, airports, wx, h0}`: `airports` are curated airports in exactly the status.json shape (fields the relay doesn't compute carry over from the build), `wx` holds other airports by ICAO in the `data/wx/<letter>.json` shard-entry shape (3-letter codes outside the curated list go to `unknown`), `sources` has every status.json source with `{ok, at, error}` plus `live: true` (fetched by the relay), `from: "build"`, or `stale: true` + `liveError` (the live request failed and the build's value is used).
- **What is live.** Per request: AWC METAR and TAF for the requested ids only, AWC airsigmet, FAA NAS status, and NWS alerts per point for the requested curated airports, each with `User-Agent: airport-wx (github.com/tylerbridges/airport-wx)`. LAMP (~4.5 MB), SPC, TCF, CWA and ATCSCC advisories come from the latest build (`https://tylerbridges.github.io/airport-wx/data/status.json`). Levels are recomputed with the poller's own functions (`poller/core.mjs` → `risk.mjs`), so with the same inputs the result is identical to the build (a test checks this).
- **Failures.** Every source is independent. A failed live source falls back to the build's value and is marked `stale`; for airports outside the curated list the build's shard (`data/wx/<letter>.json`) is fetched only when the live METAR or TAF request failed. 502 only when the build and every live source failed.
- **Caching.** Each upstream response is kept 60 s (AWC asks for at most one request per minute per thread), status.json and shards 120 s, and the finished reply 30 s keyed by the sorted ids. Two layers: memory in the Worker isolate, then the Cache API. On `*.workers.dev` the Cache API does nothing (it needs a custom domain), so there it's per isolate: with many users on many isolates AWC can see more than one request a minute.
- **CORS.** `Access-Control-Allow-Origin` only for `https://tylerbridges.github.io` and `http://localhost:*`; GET and OPTIONS.
- **Limits.** Free plan: 100,000 requests a day, 10 ms CPU per request, 50 subrequests per request (a 12-airport request makes at most ~19: METAR, TAF, airsigmet, FAA, 12 NWS points, status.json, shards). Measured in Node 22 on the fixtures (`node worker/dev.mjs bench`, stub cost subtracted): with every cache empty ~3 ms for 4 airports and ~5 ms for 12; with the upstreams cached ~1.3 / ~2.5 ms; a cached reply ~0.3 ms. The first request in a new isolate also compiles the modules (~10–20 ms in Node).
- **Page.** `site/data/config.json` = `{"liveUrl": "https://airport-wx-live.<subdomain>.workers.dev"}`, written by the "Live relay URL for the page" step of `poll.yml` once the relay's `/health` is ok (committed default `{"liveUrl": null}`: no relay). `site/app.js` (`// live relay`) asks for starred airports first (non-curated ones through `site/searched.js`), then the visible list, at most 12; merges them over the build; shows "Live · 40 s ago", or "Live data unavailable — showing data from N min ago" (amber) when the call fails, and then shows the build only. The refresh button waits for the relay. Test scenarios and sample data never call it. The check page has a "Live relay" row: `/health` ok and `/status?ids=MSP` with a METAR fetched under 3 minutes ago; with no liveUrl it's a warning ("not configured").
- **Deploy.** `.github/workflows/worker.yml` runs on pushes to main that touch `worker/**`, `poller/**` or `airports.json`, and on manual dispatch. Without the secrets it prints "Cloudflare secrets not set; skipping live relay deploy" and succeeds. With them: unit tests, `node worker/pack.mjs dist`, `PUT /accounts/$ID/workers/scripts/airport-wx-live` (multipart: `metadata` = `{main_module: "worker.mjs", compatibility_date: "2026-09-01", bindings}` plus one `application/javascript+module` part per module), `POST …/scripts/airport-wx-live/subdomain {"enabled": true}`, `GET …/workers/subdomain`, then `/health` and `/status?ids=MSP,ORD` must answer (retried for ~2 minutes); the URL goes to the job summary. No wrangler or npm.
- **Module layout.** Uploaded flat: `worker/worker.mjs` → `worker.mjs` (main module) and `poller/x.mjs` → `x.mjs`; `worker/pack.mjs` follows the imports and rewrites the worker's `../poller/x.mjs` specifiers to `./x.mjs` (the poller modules already import each other as `./x.mjs`). It refuses `node:` or bare imports and name collisions, so any module the worker imports must stay pure. Bindings: `VERSION` (commit) and `AIRPORTS` (`airports.json`, so curated airports resolve even when the build can't be fetched).
- **Setup.** In Cloudflare: open Workers & Pages once so the account has a `workers.dev` subdomain; create an API token (My Profile → API Tokens → Create Custom Token) with **Account → Workers Scripts → Edit** for this account; copy the Account ID (Workers & Pages overview). In GitHub: Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Then run "Live relay deploy" (Actions → Run workflow); the next "Poll and deploy" writes the URL into `data/config.json`.
- **Rotating the token.** Create the new token with the same permission, replace the `CLOUDFLARE_API_TOKEN` secret, run "Live relay deploy" once to confirm it works, then delete the old token in Cloudflare. The token is only used by the deploy job and the poll workflow's config step; the running Worker doesn't use it.
- **Locally.** `node worker/dev.mjs serve` runs the handler on http://localhost:8787 with every upstream answered from `poller/fixtures`, and serves `site/` on http://localhost:8000 pointed at it. Tests: `worker/worker.test.mjs` (in `node poller/run-tests.mjs`).

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

## Plain English (`poller/plain.mjs`)

Pure ESM with no imports, used by the poller and (as the byte-identical copy `site/plain.js`) by the page. Approach: one source file, committed copy; `poller/plain.test.mjs` fails if the copy drifts (`cp poller/plain.mjs site/plain.js`).

- `plainMetar(metar)`, `plainTafHour(fcstGroup)`: traveler sentences in mph, miles and plain cloud words ("Rain and low clouds", "Thunderstorms with heavy rain", "Gusts to 40 mph", "Fog — visibility under 1 mile"; TEMPO = "At times …", PROB30 = "30% chance of …"). Accepts AWC JSON or the status.json `metar` shape.
- `travelerImpact(level, conditions)`: what it means for flights, worded as possible/likely, never certain ("Arrivals are often slowed in these conditions; delays of 30+ min possible", "Storms can pause departures and arrivals (ground stops) — expect delays", "Strong crosswinds may cause delays or diversions", "De-icing and slower operations — delays likely", "Flights operating normally"). FAA programs in `conditions.faa` take precedence; GA-only (`scope: limited`) closures don't count.
- `plainSigmet(s, {tz})` / `plainCwa(c, {tz})`: "Area of severe thunderstorms moving east at 25 mph, tops to 45,000 ft, until 9 PM" (movement is the direction storms move toward). The CWA text field name is unverified (`cwaText`, `rawText`, `text` or `raw` are tried).
- `plainAlert(alert, {tz, now})`: "Winter Storm Warning until Sun 6 AM", "Wind Advisory, 2–8 PM".
- `aviationLines(metar | fcst)`: pilot lines for aviation mode (flight category, ceiling ft AGL, visibility sm, wind dir/speed/gust kt, decoded weather codes, cloud layers, temp/dew point).

Not yet wired into status.json's own fields (that happens when the app gets aviation mode); `poller/global.mjs` already uses it for searched airports.

## Search and the full airport list

- `tools/build-airports.mjs` downloads OurAirports `airports.csv` + `runways.csv` and AWC's `stations.cache.json.gz`, and writes `site/data/airports-all.json`: every airport worldwide with scheduled airline service, plus every US airport (incl. PR, GU, VI, AS, MP, UM) of type small/medium/large with an ICAO or GPS code; no heliports, seaplane bases, balloonports or closed airports. Rows: `[iata, icao, name, city, country, region (iso_region), lat, lon, tz index, scheduled, hasMetar, hasTaf, type L/M/S, runways [[ids, headingTrue]]]` with the field names in `f` and the zone names in `tz`. If the file would exceed ~1.5 MB it is split: `airports-all.json` = core (scheduled + every US airport with a METAR), `airports-extra.json` = the rest, loaded only when the core has no match.
- AWC station field names are unverified: the script detects the station id key and the field marking TAF/METAR sites (the AWC API documents `siteType: ["METAR","TAF"]`; a boolean `*taf*` field is also accepted) and logs a sample record and the counts. OurAirports columns are checked by name (`icao_code` preferred, else `gps_code`).
- Time zones come from a small built-in table (`tools/airport-tz.mjs`): one zone per single-zone country, region tables for the US, Canada, Mexico, Brazil and Australia, longitude bands elsewhere (Russia, Indonesia, …). Airports within ~50 km of a zone line can get the neighbouring zone (e.g. Crossville TN, NW Ontario, the Navajo Nation); unknown countries get no zone (UTC). A proper tz lookup can replace it later.
- `.github/workflows/airports.yml` rebuilds it weekly (Monday 06:17 UTC) and on manual dispatch, committing to main only if the content changed. The committed file until then is the small fixture build (`node tools/build-airports.mjs --fixtures`, from `tools/fixtures/`; its runway headings are approximate).
- `site/search.js` (`mountSearch(container, {onPick, getFavs, onToggleFav})`): 17 px search field, typeahead over IATA/ICAO/city/name, accent-insensitive, up to 8 Flighty-style rows (big code, city and name, star), keyboard (↑ ↓ Enter Esc) and VoiceOver combobox/listbox roles, recent picks in localStorage (`awx-recent`), list lazy-loaded on first focus. Ranking: exact code; alias table (NYC → JFK/LGA/EWR, Chicago → ORD/MDW, DC → DCA/IAD/BWI, Bay Area → SFO/OAK/SJC, London, …; 4+ letters match alias prefixes); scheduled service first; larger types first; then code prefix, city word prefix, name word prefix.
- `site/searched.js` wires it into the page: a major opens its normal sheet; any other airport gets a card from the global shards with "Weather forecast only — FAA programs and alerts shown for major airports" (US) or "Weather only — FAA/NWS data covers U.S. airports" (international); an airport with no METAR/TAF says "No weather reports from this airport — check the nearest major airport" and links the nearest airport with reports. Starred non-major airports share the `awx-favs` list and show on My airports.

## Global weather (`poller/global.mjs`)

Every poll also downloads AWC's global bulk caches (`metars.cache.csv.gz`, `tafs.cache.xml.gz`) and scores every airport in the airport list that has a METAR or TAF with the risk.mjs METAR + TAF rules (no FAA/NWS/SPC). Output: `site/data/wx/<first letter of ICAO>.json` = `{generated, h0, a: {ICAO: {n, p, pt, h, r, c, pl, im, m, mt, t, ti}}}` (now/peak level, peak hour, 24 hourly levels with "-" for hours no report covers, top reason, flight category, plain-English now, traveler impact, METAR raw/time, TAF raw/issue time) and `site/data/wx/index.json` (per-file ok/http/bytes/ms, counts, letters). Only the raw report text is needed from the caches (CSV `raw_text`, XML `<raw_text>`; re-parsed with `poller/taf-parse.mjs`), so other column/element names don't matter; the header and first record are logged and the first 20 KB of each file is listed in the raw `sources.json` (`globalMetars`, `globalTafs`) so it lands in `raw/latest/` on the history branch. A failure never stops the main poll. Hook: one `runGlobal()` call in `poll.mjs` (`// build2a hook`); env `GLOBAL_WX=0` skips it, `GLOBAL_WX_OUT` changes the output dir.

## Test scenarios

`poller/scenarios/_base/` is a complete quiet fixture set (same layout as `poller/fixtures/`); each `poller/scenarios/<name>/` holds `scenario.json` (title, description, assertions, optional `omit` files to make a source fail and `lagMin` to make the data stale) plus only the files that differ (metar/taf merged by `icaoId`, nws by key, other files replace the base). `node tools/build-scenarios.mjs [names]` runs `node poller/poll.mjs --fixtures` per scenario with `FIXTURES_DIR` (the one-line `// build2a hook` in poll.mjs) and writes `site/data/scenarios/<name>.json`, `<name>/wx/` and `index.json` (assertions). Scenarios: thunderstorm-ground-stop (ORD), atc-staffing-ground-stop (EWR, cause staffing), airline-it-outage (ATL, company request), lax-ga-only-closure (the real LAX GA-only NOTAM; must not be Severe), full-closure (MCO), winter-storm-gdp (DEN), source-outage (FAA feed fails), stale-data (50 min old), all-clear (also asserts the global shards: EGLL international with METAR + TAF, KFCM METAR only, Y49 no reports).

Open `index.html?test=<name>` to see one: the page shows "Test scenario: … (not live)" and `site/testmode.js` shifts every time in the file so the scenario always looks current.

## Check page (`site/check.html`)

`check.html` checks the live data; `check.html?mock=1` runs every scenario instead (`&render=0` skips render tests). Rows: freshness (warn > 15 min, fail > 20 min), each source (ok/error plus HTTP status, bytes and time when the file carries them), a METAR under 2 h old at every airport and a TAF wherever the airport list says the airport issues one, plausible values (temp −60..60 °C, wind/gust 0..150 kt, visibility ≥ 0, ceiling ≥ 0), a cause class on every FAA program, no raw coded text in traveler fields (reasons, `faa.plain`, `faa.causeLabel`), the global run's freshness and that airports with a METAR have a shard entry under 2 h old (live: 95%, scenarios: 100%), search ranking, the scenario assertions (mock), and a render test that loads `index.html` and every `?test=` scenario in a hidden 390 px iframe and fails on any uncaught error, rejection or console.error (captured by `site/testmode.js`). Uptime: if `data/uptime.json` exists (`{sources: {name: {d1: {ok, total}, d7: {ok, total}}}}`, written later by the history job) it shows 24 h and 7 d success per source, else "not yet available". "Copy report" copies the text report; the summary is in `<pre id="result">` as `CHECK PASS` or `CHECK FAIL n` plus one line per check, for `--dump-dom`. Linked from the bottom of the app ("Checks").

## Uptime monitor

`.github/workflows/uptime.yml` runs every 30 min and on dispatch: headless Chrome dumps the live `check.html` (`--virtual-time-budget=30000`, plus `--no-sandbox` for the runner), `tools/uptime-parse.mjs` reads `#result` and separately checks `data/status.json` freshness (≤ 20 min) fetched with curl. On failure it opens one issue "Uptime: check failing" (or comments on the open one at most every 6 h) with the report; on success it comments "Recovered at …" and closes it. GitHub REST API via curl and `GITHUB_TOKEN` (`issues: write`). Parsing is unit-tested against saved DOM samples in `tools/fixtures/uptime/`.

## Home-screen install

`site/manifest.webmanifest` (name "Airport Status", short name "Airports", standalone, theme/background `#0b0b0c`, start_url `./`, icons `site/icons/icon-180.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (maskable), `favicon.svg`) and one marked block in `index.html`'s `<head>`: manifest link, favicons, apple-touch-icon, apple-mobile-web-app-capable, black-translucent status bar. The existing light/dark `theme-color` metas are kept.

