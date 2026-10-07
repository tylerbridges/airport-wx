// Content blockers (AdGuard, 1Blocker, Wipr…) hide elements whose class or id looks like an ad, inside home-screen
// web apps too: the Airport details menu once used .ad-card/.ad-row and vanished on an iPhone. Keep page names clear of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SITE = new URL("../site/", import.meta.url).pathname;
const files = [...readdirSync(SITE).filter((f) => /\.(js|html)$/.test(f)).map((f) => join(SITE, f)),
  ...["radar", "map"].flatMap((d) => readdirSync(join(SITE, d)).filter((f) => /\.(js|html)$/.test(f)).map((f) => join(SITE, d, f)))];
const BAD = /^(ad|ads|adv|advert\w*|banner\w*|sponsor\w*|promo\w*)$|^(ad|ads|banner|sponsor|promo)[-_]|[-_](ad|ads|banner|sponsor|promo)$/i;

test("no class or id names that ad blockers hide", () => {
  const bad = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    const names = [];
    for (const m of s.matchAll(/(?:class(?:Name)?\s*[:=]\s*|classList\.(?:add|toggle|contains)\(\s*)["'`]([^"'`]+)["'`]/g)) names.push(...m[1].split(/\s+/));
    for (const m of s.matchAll(/\bid\s*[:=]\s*["']([^"']+)["']/g)) names.push(m[1]);
    for (const m of s.matchAll(/(?:^|[\s,{}>+~(])[.#]([a-zA-Z][\w-]*)/gm)) names.push(m[1]);
    for (const n of names) if (BAD.test(n)) bad.push(f.replace(SITE, "") + ": " + n);
  }
  assert.deepEqual([...new Set(bad)], []);
});
