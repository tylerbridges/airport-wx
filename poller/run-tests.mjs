// Entry point so `node --test poller/` works on Node 22 as well as Node 20
// (Node 22 treats the directory as a module path; Node 20 scans it for *.test.mjs).
import "./risk.test.mjs";
import "./lib.test.mjs";
