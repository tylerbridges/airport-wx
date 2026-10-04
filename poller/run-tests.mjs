// Entry point so `node --test poller/` works on Node 22 as well as Node 20
// (Node 22 treats the directory as a module path; Node 20 scans it for *.test.mjs).
// `node poller/run-tests.mjs` runs everything, including the backtest tool's tests.
import "./risk.test.mjs";
import "./lib.test.mjs";
import "./sources.test.mjs";
import "./opsplan.test.mjs";
import "./cause.test.mjs";
import "./notam.test.mjs";
import "./record.test.mjs";
import "./taf-parse.test.mjs";
import "../tools/backtest.test.mjs";
// build2a
import "./plain.test.mjs";
import "./global.test.mjs";
import "../tools/build-airports.test.mjs";
import "../tools/build-scenarios.test.mjs";
import "../tools/search.test.mjs";
import "../tools/uptime-parse.test.mjs";
// build2b
import "../tools/cats.test.mjs";
import "../tools/prefs.test.mjs";
import "../tools/delay-words.test.mjs";
import "../tools/outlook.test.mjs";
// live relay
import "../worker/worker.test.mjs";
// phase3: delay model
import "./delay.test.mjs";
import "../tools/train.test.mjs";
// trips
import "./trips.test.mjs";
import "./trip-risk.test.mjs";
// movement: ADS-B traffic rates
import "./movement.test.mjs";
// brief hook: per-airport change log
import "./changes.test.mjs";
import "../tools/brief.test.mjs";
// closures and hub cascades
import "./closures.test.mjs";
import "./hubs.test.mjs";
// radar hook: radar card helpers and the copied engine
import "../tools/radar.test.mjs";
// notams hook: NOTAMs + TFRs (README "Notices")
import "./notams.test.mjs";
import "./tfr.test.mjs";
// terminals hook: terminal maps (Overpass parsing, simplification) and the curated lounge data
import "../tools/terminals.test.mjs";
