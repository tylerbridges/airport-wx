# NOAA forecast extraction pilot

This is an artifact-only, manually invoked evaluation of free NOAA HRRR and NBM
forecast grids. It does not change the live risk rules, feature specification,
model, Worker, app data or traveler wording. No account, key, paid service or
external package is required. NOAA makes these data public under its NODD terms;
attribution is requested and NOAA endorsement must not be implied.

## What was proved

The pilot collected three fields from each of two model cycles for both models:
July 1, 2026 at 00Z and October 4, 2026 at 20Z, each ending three hours later.
Sixteen HTTP requests transferred 11,313,119 bytes: four small indexes and twelve
individual GRIB messages selected with byte ranges. The parent objects are
roughly 80–150 MB; they were never downloaded in full. It extracted 36 available
nearest-grid values across ORD, MSP and SFO without source failures.

| Model | Fields | Grid / packing | Historical object publication | Index publication |
|---|---|---|---|---|
| HRRR | surface gust, surface visibility, local lightning proxy | Lambert 3.30 / complex spatial differencing 5.3 | July 1 00:55:09Z | 00:55:12Z |
| NBM | 10 m gust, surface visibility, one-hour thunderstorm forecast | Lambert 3.30 / complex spatial differencing 5.3 | July 1 01:07:10Z | 01:07:15Z |

The July gust values at 03Z were HRRR 14.124, 3.187 and 8.687 m/s, and NBM
9.1, 2.5 and 10.0 m/s, for ORD, MSP and SFO respectively. These are modeled grid
values, not airport observations. NBM thunderstorm values were 2%, 1% and 0% for
02–03Z, not individual-flight disruption probabilities. HRRR's local LTNG field
is retained as an uninterpreted model lightning proxy; no physical unit or delay
chance is inferred from it.

The dependency-free decoder was independently checked against NOAA's
NCEPLIBS-g2c `comunpack.c` using a temporary standalone reference harness. Across
all twelve fields, 33,900,636 values had zero missing-value mismatches and zero
errors above float precision tolerance. The temporary C harness is verification
equipment, not a repository or runtime dependency. Two real NOAA fields are
committed as compressed base64 fixtures, with source URLs, object metadata,
SHA-256 checksums and reference-decoded points including nonzero storm values.

## Correct time and quality handling

Each collected field records the GRIB reference cycle, exact valid time,
statistical interval, object and index Last-Modified, ETags, actual receipt time,
byte range and SHA-256. Historical joins require both S3 object and index to have
been available before the prediction. Live joins additionally require actual
receipt before the prediction. A later rewrite is excluded from earlier joins;
S3 Last-Modified is a conservative availability proxy, not a guaranteed record
of first publication. Cycle time alone is never accepted as publication time.

Instantaneous gust/visibility samples describe the start of an airport hour.
The one-hour NBM thunderstorm interval ending at H describes [H−1 hour,H), and
joins that covered hour rather than the following one. The GRIB interval's end
is used even when the forecast lead field describes its start. Other interval
lengths/statistical processes are ineligible. Forecast cycles older than twelve
hours are excluded by default. Missing values and airports outside the grid
remain null with a quality reason.

The decoder intentionally supports only the real formats verified in this pilot:
northern tangent spherical Lambert grids, row scanning including alternating
rows, complex packing 5.3 with first/second spatial differences and missing-value
management, and product definitions 4.0/4.8. Bitmap encoding, other projections,
constant-field encodings and other packing/product templates fail explicitly;
they never become zero-valued weather features. Ceilings, upwind buffers,
ensemble spread and visibility-threshold probabilities are not extracted yet.

## Run and replay

Run tests with `node --test tools/noaa-forecast.test.mjs`.

Collect a bounded sample outside `site/`:

```sh
node tools/noaa-forecast-pilot.mjs \
  --cycles 2026-07-01T00:00:00Z,2026-10-04T20:00:00Z \
  --out /tmp/airport-noaa-pilot \
  --dataset /path/to/dataset.jsonl.gz
```

`--models hrrr` or `--models nbm` limits the model; `--lead` accepts 1–18 hours.
There are no retries, automatic latest-cycle searches, scheduled collections or
background jobs. Each invocation caps requests at 16, total transferred bytes at
16 MB, individual fields at 2 MB, indexes at 200 KB, request timeouts at 20 seconds
and network collection at three minutes. A missing cycle or unsupported field
is recorded as a failure. Larger fields require a deliberate future budget/design
change rather than silent full-grid download. In a workspace using a configured
proxy and Node 24, `NODE_USE_ENV_PROXY=1` enables that existing proxy; the script
itself requires only Node 20 built-ins and ordinary HTTPS.

Re-decode saved messages and rebuild the causal join without network requests:

```sh
node tools/noaa-forecast-pilot.mjs \
  --replay /tmp/airport-noaa-pilot/report.json \
  --dataset /path/to/dataset.jsonl.gz
```

Replay validates saved checksums and preserves original receipt/publication
timestamps. Outputs are `report.json`, individual messages/indexes under
`messages/`, and optional `training-join.jsonl` containing provenance beside each
feature. The dataset is streamed rather than loading all training rows into RAM.

## Accuracy is still unproved

The actual training dataset contains 434,627 airport-hour records and 1,738,507
usable lead rows across 32 airports, August 2024–July 2026. This sparse pilot joins
only six historical airport-hour rows with any new feature: about 0.000345% of
the available lead rows, all in the 0–3-hour bucket. The newer cycle is outside
the labeled period. The historical 00Z forecast cannot be used for a prediction
made at 00Z, because it had not been published then. Longer-lead coverage needs
older model cycles whose valid times match the same target hours.

Candidate Brier, matched-cohort prior/climatology/rule scores, calibration and
airport metrics are explicitly null. The deployed full-cohort Brier of 0.1534 is
identified as reference information, not compared to this tiny sample. There is
no candidate model and no promotion eligibility.

Before adding these features to the scorer: build a representative archive across
seasons, airports and lead buckets using conservative publication cutoffs; reserve
untouched test rows shared with all comparators; run feature ablations; require
better Brier than the deployed model, climatology and rule mapping with sound
calibration; inspect airport/lead/missing-input results; and verify the displayed
probability words on independent data. Forecast grids cannot identify gates,
flight status, the assigned inbound aircraft or actual trip progress.

## Primary references

- [NOAA HRRR public archive and data terms](https://registry.opendata.aws/noaa-hrrr-pds/)
- [NOAA NBM public archive and data terms](https://registry.opendata.aws/noaa-nbm/)
- [NCEP Lambert grid template 3.30](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_temp3-30.shtml)
- [NCEP complex packing template 5.3](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_temp5-3.shtml)
- [NOAA reference complex unpacker](https://github.com/NOAA-EMC/NCEPLIBS-g2c/blob/develop/src/comunpack.c)
