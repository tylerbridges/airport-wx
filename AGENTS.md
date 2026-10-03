# Repository workflow

## Product goal

A user should feel confident they're aware of any potential disruption, weather or not. Clean by default (traveler language), detail behind toggles (aviation mode), and never silently wrong (a source failure or stale data is always stated). This governs every choice.

## Workflow

airport-wx: a static page showing major-weather and delay risk at major US airports. A GitHub Actions job polls the sources every 10 minutes, computes risk, and deploys `site/` to GitHub Pages.

- Work directly on `main` unless asked otherwise. Start with `git status`; when clean, `git pull --ff-only origin main`. Never discard pre-existing changes.
- Commit task-scoped files with a descriptive message and push with `git push origin main`. Never force-push.
- No dependencies anywhere: Node built-ins only for the poller (Node 20), plain HTML/CSS/JS for the site, no build step.
- Bump the `app.js?v=` number in `site/index.html` whenever `site/app.js` or the page's CSS changes.
- Risk rules live in `poller/risk.mjs` and are documented in the README ("Risk levels"). Change both together and update `poller/risk.test.mjs`.
- If the shape of `status.json` changes, update `site/app.js`, the README schema, and regenerate the committed fallback with `node poller/poll.mjs --fixtures --out site/data/sample.json`.
- `site/data/status.json` is generated and git-ignored; never commit it.
- The workflow records every poll to the `history` branch (`poller/record.mjs`, `poller/history.sh`): `truth/` (observed outcomes), `forecast/` (hourly predictions) and `raw/latest/` (first 200 KB of each source's latest raw response + `sources.json`). Never commit to `history` by hand or force-push it. To check a live response format (LAMP, ATCSCC, TCF and CWA parsers were written from documentation), read `raw/latest/` on that branch, e.g. `git fetch origin history && git show origin/history:raw/latest/sources.json`. If a format differs, fix the tolerant parser in `poller/sources.mjs` and add the real sample as a fixture.
- Program causes live in `poller/cause.mjs`, FAA closure/NOTAM handling in `poller/notam.mjs`; both are documented in the README and unit-tested.
- aviationweather.gov does not allow CORS, so the browser must never call it. The page reads only files under `./data/` (status.json, the airport list, the global `wx/` shards, scenarios, `config.json`) and the live relay that `config.json` names.
- Traveler text comes from `poller/plain.mjs` (`site/plain.js` is a byte-identical copy: after editing, `cp poller/plain.mjs site/plain.js`; a test fails if they differ). Traveler strings never carry raw codes (CLSD, BKN008, TEMPO, PROB30, 2130Z…) and never claim certainty ("possible", "likely").
- `site/data/wx/` (global METAR/TAF shards from `poller/global.mjs`) is generated each poll and git-ignored. `site/data/airports-all.json` is rebuilt weekly by `.github/workflows/airports.yml`; locally `node tools/build-airports.mjs --fixtures` rebuilds the small fixture version.
- Test scenarios: fixture sets in `poller/scenarios/` (README "Test scenarios"); after changing the poller, risk rules or a scenario, run `node tools/build-scenarios.mjs` and commit `site/data/scenarios/`. Add a scenario (with assertions) for each new kind of disruption.

- Live relay (README "Live relay"): `worker/worker.mjs` is a Cloudflare Worker that overlays fresh METAR/TAF/SIGMET/FAA/NWS on the last build. `.github/workflows/worker.yml` deploys it on every push to main that touches `worker/**`, `poller/**` or `airports.json` (and on manual dispatch); it skips with a notice until the repo secrets `CLOUDFLARE_API_TOKEN` (Account → Workers Scripts → Edit) and `CLOUDFLARE_ACCOUNT_ID` exist (Settings → Secrets and variables → Actions). The poll workflow then writes `site/data/config.json` with the relay URL (committed default `{"liveUrl":null}`). Modules the worker imports (`poller/core.mjs` and what it imports) must stay pure: no `node:` imports (`worker/pack.mjs` refuses them). Test locally with `node worker/dev.mjs serve`.

- Delay model (README "Delay model"): features live in `poller/delay.mjs` (shared by training, the poller, the relay and the page's data). After changing features, `SPEC`, the target, `poller/risk.mjs` rules or `tafHourParts`, run the "Train delay model" workflow (`.github/workflows/train.yml`) so `site/data/model/` matches; bump `SPEC` when old models can't be scored correctly (they then fall back). Never commit or ship a `model.json` that failed the safety gate (test Brier skill vs climatology > 0 and better than the rule-level mapping); only the workflow writes `site/data/model/`. `node tools/train.mjs --fixtures` must keep running end to end. UI is in `site/delay.js`, `site/accuracy.html`, `site/accuracy.js`; app.js/index.html only carry `phase3 hook` lines.

## How the site works

- `site/index.html` (markup + all CSS) loads `cats.js` (disruption categories, pure), `prefs.js` (settings state, ES module, also `window.AWXPrefs`), `app.js` (everything rendered; classic script) and `searched.js` (search + non-major airports). Bump `?v=` on each file you change.
- Settings state belongs to `site/prefs.js` (`getPrefs/setPref/onPrefs/DEFAULTS`, localStorage `awx-settings`); never write that key elsewhere. Ground stops and full closures can't be hidden.
- Category/level/impact rules for the page are in `site/cats.js` and must read back every poller reason (`tools/cats.test.mjs`); add a pattern there when `poller/risk.mjs` gets a new reason text.
- Timelines are the local calendar day; past hours come from `observed` (poll.mjs `// build2b hook`), the rest from `hours`. The sheet's card stack keeps one footprint (all states in one grid cell): don't add content that changes its height on hour taps.
- Traveler mode must show no aviation codes outside Pilot details (the check page scans every sheet).

## Checks before publishing

1. `node poller/run-tests.mjs` — all pass.
2. `node tools/build-scenarios.mjs` — runs every scenario through the real poller.
3. Serve `site/` (`python3 -m http.server -d site 8000`) and open `check.html?mock=1` headless; require `CHECK PASS`:
   `chrome --headless=new --disable-gpu --virtual-time-budget=30000 --dump-dom "http://localhost:8000/check.html?mock=1" | grep -o "CHECK [A-Z]*[ 0-9]*"`
   (it also renders `index.html?test=<each scenario>` at 390 px and fails on any console error).
4. Load `index.html` (and `?test=thunderstorm-ground-stop`) at 390 px in light and dark mode with no console errors.
5. After pushing: run the "Uptime monitor" workflow (or open `https://tylerbridges.github.io/airport-wx/check.html`) and require `CHECK PASS`.
- Never use Flighty's name, logo or branding; the look is "inspired by" only.
