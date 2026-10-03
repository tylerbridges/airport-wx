#!/usr/bin/env node
// Builds the test scenarios: runs the real poller in fixture mode once per scenario and writes
//   site/data/scenarios/<name>.json        status.json for the scenario (+ a "scenario" block)
//   site/data/scenarios/<name>/wx/*.json   global METAR/TAF shards for the scenario
//   site/data/scenarios/<name>/trips.json  calendar trips for the scenario (from its trips.ics, if any)
//   site/data/scenarios/index.json         every scenario's title and expected assertions
// Usage: node tools/build-scenarios.mjs [name ...]
//
// Fixture sets live in poller/scenarios/: _base/ is a complete, quiet fixture set (same file
// layout as poller/fixtures/); each scenario dir holds scenario.json plus only the files that
// differ. Merging: metar.json and taf.json are merged record-by-record on icaoId, nws.json
// key-by-key; any other file replaces the base file. scenario.json "omit": [files] removes
// files so that source fails (e.g. FAA down); "lagMin" makes the data that many minutes old
// when the page loads it (site/testmode.js shifts all times so scenarios always look current).
import { readFile, writeFile, mkdir, readdir, rm, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCN = join(ROOT, "poller/scenarios");
const OUT = join(ROOT, "site/data/scenarios");

/** Merge a scenario file over the base file text. Returns the merged text. */
export function mergeFile(name, baseText, overText) {
  if (baseText == null) return overText;
  // Templates hold unquoted {{..}} tokens, so quote them for JSON.parse and unquote after.
  const protect = (s) => s.replace(/(:\s*)(\{\{[^}]+\}\})/g, '$1"@@$2@@"');
  const restore = (s) => s.replace(/"@@(\{\{[^}]+\}\})@@"/g, "$1");
  if (name === "metar.json" || name === "taf.json") {
    const base = JSON.parse(protect(baseText));
    const over = JSON.parse(protect(overText));
    const ids = new Set(over.map((r) => r.icaoId));
    const merged = [...base.filter((r) => !ids.has(r.icaoId)), ...over];
    return restore("[\n" + merged.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n]\n");
  }
  if (name === "nws.json") {
    return JSON.stringify({ ...JSON.parse(baseText), ...JSON.parse(overText) }, null, 1) + "\n";
  }
  return overText;
}

async function readMaybe(p) {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

export async function scenarioNames() {
  return (await readdir(SCN, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name).sort();
}

async function buildOne(name) {
  const dir = join(SCN, name);
  const meta = JSON.parse(await readFile(join(dir, "scenario.json"), "utf8"));
  const tmp = await mkdtemp(join(tmpdir(), `awx-scn-${name}-`));
  const baseFiles = await readdir(join(SCN, "_base"));
  const overFiles = (await readdir(dir)).filter((f) => f !== "scenario.json");
  for (const f of new Set([...baseFiles, ...overFiles])) {
    if ((meta.omit || []).includes(f)) continue;
    const base = await readMaybe(join(SCN, "_base", f));
    const over = await readMaybe(join(dir, f));
    await writeFile(join(tmp, f), over != null ? mergeFile(f, base, over) : base);
  }
  const out = join(OUT, `${name}.json`);
  const wxOut = join(OUT, name, "wx");
  const r = spawnSync(process.execPath, [join(ROOT, "poller/poll.mjs"), "--fixtures", "--out", out, "--raw", "none"], {
    env: { ...process.env, FIXTURES_DIR: tmp, GLOBAL_WX_OUT: wxOut, TRIPS_OUT: join(OUT, name, "trips.json"), FLIGHTY_ICS_URL: "" }, // trips hook: <name>/trips.json (from the scenario's trips.ics)
    encoding: "utf8",
  });
  await rm(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`${name}: poller exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  const status = JSON.parse(await readFile(out, "utf8"));
  status.scenario = { name, title: meta.title, builtAt: status.generated, lagMin: meta.lagMin || 0 };
  await writeFile(out, JSON.stringify(status) + "\n");
  const lines = r.stdout.trim().split("\n");
  console.log(`${name}: ${lines[lines.length - 1]}`);
  for (const l of lines.filter((x) => /^FAIL|^global:/.test(x))) console.log(`  ${l}`);
  return {
    name, title: meta.title, description: meta.description || "", file: `${name}.json`, wx: `${name}/wx/`,
    lagMin: meta.lagMin || 0, assert: meta.assert || [],
  };
}

export async function buildScenarios(names) {
  await mkdir(OUT, { recursive: true });
  const all = await scenarioNames();
  const pick = names && names.length ? names : all;
  for (const n of pick) if (!all.includes(n)) throw new Error(`unknown scenario ${n} (have: ${all.join(", ")})`);
  const prev = JSON.parse((await readMaybe(join(OUT, "index.json"))) || '{"scenarios":[]}');
  const byName = new Map(prev.scenarios.map((s) => [s.name, s]));
  for (const n of pick) byName.set(n, await buildOne(n));
  const scenarios = all.filter((n) => byName.has(n)).map((n) => byName.get(n));
  await writeFile(join(OUT, "index.json"), JSON.stringify({ generated: new Date().toISOString(), scenarios }, null, 1) + "\n");
  console.log(`wrote ${scenarios.length} scenarios to ${OUT}`);
  return scenarios;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildScenarios(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(1); });
}
