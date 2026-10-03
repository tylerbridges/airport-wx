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
