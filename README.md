# airport-wx history

Written by `poller/record.mjs` from the "Poll and deploy" workflow on `main` (every ~10 minutes).
Every file is UTC. Lines are compact JSON (JSON Lines): null, empty strings, empty arrays and empty
objects are left out, and timestamps are ISO 8601 shortened ("2026-10-03T22:00Z", "2026-10-03T22:04:24Z").

## truth/YYYY/MM/DD.jsonl — observed outcomes, one line per poll

    {t, down?: [sources that failed this poll],
     airports: {IATA: {
       metar?: {obsTime, raw, fltCat, visib, ceiling, wx, wspd, wgst},
       faa?: [{type: ground_stop|ground_delay|delay|closure, cause, reason, detail, scope?, active?}],
       atcscc?: [{id, type: GS|GDP|AFP|other, issued, cause, causeText, title, active, cnx, start, end}]}}}

- `metar` is left out when its obsTime equals the last one recorded for that airport (no new report).
- `faa` is the FAA NAS status program state at that poll; no `faa` key = no programs (unless "faa" is in `down`).
- `atcscc` lists advisories that are active, or were issued since the previous line.
- `cause` classes: weather, volume, equipment, staffing, runway, security, airline, vip, space, other, unknown.
- Closures carry `scope`: full (airport closed), runway (some runways), limited (closed only to some users, e.g. GA).

## forecast/YYYY/MM/DD.jsonl — predictions, one line per UTC hour

    {t, issuedHour, down?, airports: {IATA: {
       taf?: {issued, raw}, lamp?: {issued, hours: [{t, gust, tstmProb, cig, vis, typ, pFrz, pPrecip}]},
       spc?, tcf?: [{valid, coverage, confidence, tops}], cwa?: [{hazard, validFrom, validTo, raw}],
       alerts?: [{event, onset, ends}],
       hours: [24 x {t, level, reasons?}]}}}

- Written by the first poll of each UTC hour. `hours` are the site's rule-based risk levels
  (0 None … 4 Severe) for the 24 hours from issuedHour; `reasons` are the texts shown on the site.
- LAMP: gust in kt (0 = "NG", no gust), tstmProb = LP2 (2-h thunder probability ending at t, every other hour),
  cig category 1–8 (1 <200 ft … 8 >12,000 ft/unlimited), vis category 1–7 (1 <1/2 mi … 7 >6 mi), typ R/S/Z,
  pFrz = POZ %, pPrecip = PPO %.

## raw/latest/ — format check

The first 200 KB of each source's latest successful raw response (metar.json, taf.json, airsigmet.json, faa.xml,
nws.json = one point's alerts, spc.geojson, lamp.txt + lamp-airports.txt, atcscc.html + atcscc-detail.html,
tcf.json, cwa.json), overwritten every poll. `sources.json` has, per source: ok, error, http status, bytes,
url, files and fileAt (when the files were captured; a source that failed keeps its previous files).
