# Repository workflow

airport-wx: a static page showing major-weather and delay risk at major US airports. A GitHub Actions job polls the sources every 10 minutes, computes risk, and deploys `site/` to GitHub Pages.

- Work directly on `main` unless asked otherwise. Start with `git status`; when clean, `git pull --ff-only origin main`. Never discard pre-existing changes.
- Commit task-scoped files with a descriptive message and push with `git push origin main`. Never force-push.
- No dependencies anywhere: Node built-ins only for the poller (Node 20), plain HTML/CSS/JS for the site, no build step.
- Bump the `app.js?v=` number in `site/index.html` whenever `site/app.js` or the page's CSS changes.
- Before publishing, run `node --test poller/`, then `node poller/poll.mjs --fixtures` and load the page (`python3 -m http.server -d site`) at 390px wide in light and dark mode with no console errors.
- Risk rules live in `poller/risk.mjs` and are documented in the README ("Risk levels"). Change both together and update `poller/risk.test.mjs`.
- If the shape of `status.json` changes, update `site/app.js`, the README schema, and regenerate the committed fallback with `node poller/poll.mjs --fixtures --out site/data/sample.json`.
- `site/data/status.json` is generated and git-ignored; never commit it.
- aviationweather.gov does not allow CORS, so the browser must never call it. The page reads only `./data/status.json`.
- Never use Flighty's name, logo or branding; the look is "inspired by" only.
