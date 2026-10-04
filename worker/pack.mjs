#!/usr/bin/env node
import { loadMonitoredAirports } from "../poller/airports.mjs";
// Packs the live relay for Cloudflare's multipart module upload (used by .github/workflows/worker.yml).
//   node worker/pack.mjs <outDir> [--version <text>]
// Follows the static imports from worker/worker.mjs and writes every module FLAT into outDir:
// worker/worker.mjs -> worker.mjs (the main module) and poller/x.mjs -> x.mjs, rewriting each
// relative import specifier to "./<basename>" (poller modules already import each other that way,
// so only worker.mjs's "../poller/…" specifiers change). Fails on node: or bare imports and on
// basename collisions. Also writes:
//   metadata.json  {main_module: "worker.mjs", compatibility_date, bindings: VERSION, AIRPORTS (airports.json)}
//   parts.txt      one module file name per line (main first) for the curl -F parts
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const MAIN = "worker.mjs";
export const COMPATIBILITY_DATE = "2026-09-01";
const IMPORT_RE = /(\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bexport\s+[^'"()]*?\s+from\s+)(["'])([^"']+)\2/g;

/** Static import/export-from specifiers of a module's source. */
export function specifiers(src) {
  const out = [];
  for (const m of String(src).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").matchAll(IMPORT_RE)) out.push(m[3]);
  return out;
}

/** -> {modules: [{name, path, code}], metadata} without writing anything. */
export async function bundle({ entry = join(HERE, "worker.mjs"), version = "dev" } = {}) {
  const byPath = new Map();
  const names = new Map();
  const visit = async (path, isMain) => {
    if (byPath.has(path)) return;
    const name = isMain ? MAIN : basename(path);
    if (names.has(name) && names.get(name) !== path) throw new Error(`module name collision: ${name} (${names.get(name)} and ${path})`);
    names.set(name, path);
    const src = await readFile(path, "utf8");
    const mod = { name, path, src, deps: [] };
    byPath.set(path, mod);
    for (const s of specifiers(src)) {
      if (!s.startsWith("./") && !s.startsWith("../")) throw new Error(`${name}: only relative imports can be uploaded, found "${s}"`);
      const dep = resolve(dirname(path), s);
      mod.deps.push([s, dep]);
      await visit(dep, false);
    }
  };
  await visit(resolve(entry), true);
  const modules = [...byPath.values()].map((m) => {
    let code = m.src;
    for (const [s, dep] of m.deps) code = code.split(`"${s}"`).join(`"./${byPath.get(dep).name}"`).split(`'${s}'`).join(`'./${byPath.get(dep).name}'`);
    return { name: m.name, path: m.path, code };
  });
  const catalog = await loadMonitoredAirports();
  const airportModule = modules.find(m=>m.name === "airport-catalog.mjs");
  if (airportModule) airportModule.code = `export default ${JSON.stringify(catalog)};\n`;
  const airports = JSON.parse(await readFile(join(ROOT, "airports.json"), "utf8"));
  const metadata = {
    main_module: MAIN,
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: "plain_text", name: "VERSION", text: String(version) },
      { type: "plain_text", name: "AIRPORTS", text: JSON.stringify(airports) },
    ],
  };
  return { modules, metadata };
}

export async function pack(outDir, opts = {}) {
  const { modules, metadata } = await bundle(opts);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const m of modules) await writeFile(join(outDir, m.name), m.code);
  await writeFile(join(outDir, "metadata.json"), JSON.stringify(metadata));
  await writeFile(join(outDir, "parts.txt"), modules.map((m) => m.name).join("\n") + "\n");
  return { modules: modules.map((m) => m.name), metadata };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const vi = args.indexOf("--version");
  const out = args.find((a, i) => !a.startsWith("--") && i !== vi + 1);
  if (!out) { console.error("usage: node worker/pack.mjs <outDir> [--version <text>]"); process.exit(2); }
  const r = await pack(resolve(out), { version: vi >= 0 ? args[vi + 1] : "dev" });
  console.log(`packed ${r.modules.length} modules into ${out}: ${r.modules.join(", ")}`);
}
