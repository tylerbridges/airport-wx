// Entry point so `node --test poller/` works on Node 22 as well as Node 20
// (Node 22 treats the directory as a module path; Node 20 scans it for *.test.mjs).
// `node poller/run-tests.mjs` runs everything, including the backtest tool's tests.
import "./risk.test.mjs";
import "./lib.test.mjs";
import "./sources.test.mjs";
import "./cause.test.mjs";
import "./notam.test.mjs";
import "./record.test.mjs";
import "./taf-parse.test.mjs";
import "../tools/backtest.test.mjs";
