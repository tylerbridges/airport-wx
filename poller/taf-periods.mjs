// Display-only TAF periods, using the same prevailing/overlay interpretation as scoring.
import { toMs, tafHourParts, parseVisib, ceilingOf, flightCategory } from './risk.mjs';

const iso = t => new Date(t).toISOString();
function conditions(c) {
  const visib = parseVisib(c.visib), ceiling = ceilingOf(c.clouds);
  return { wind: { dir: c.wdir, spd: c.wspd }, gust: c.wgst, visib,
    visibilityAbove: /\+$/.test(String(c.visib)), ceiling, wx: c.wxString || null,
    clouds: c.clouds, fltCat: visib != null ? flightCategory(visib, ceiling) : null };
}
function mergeChange(state, g) {
  const c = { ...state };
  for (const k of ['wdir','wspd','wgst','visib','wxString']) if (g[k] != null && g[k] !== '') c[k] = g[k];
  if (g.clouds?.length) c.clouds = g.clouds;
  return c;
}
export function tafPeriods(taf) {
  const start = toMs(taf?.validTimeFrom), end = toMs(taf?.validTimeTo);
  const groups = taf?.fcsts;
  if (start == null || end == null || end <= start || !Array.isArray(groups) || !groups.some(g => !g.fcstChange)) return [];
  const changes = groups.filter(g => ['FM', 'BECMG'].includes(g.fcstChange));
  const cuts = [...new Set([start, end, ...changes.map(g => toMs(g.fcstChange === 'BECMG' ? g.timeBec ?? g.timeFrom : g.timeFrom)).filter(t => t > start && t < end)])].sort((a,b) => a-b);
  if (cuts.length > 128 || groups.length > 128) return [];
  const rows = [];
  for (let i=0; i<cuts.length-1; i++) {
    const from = cuts[i], to = cuts[i+1];
    const parts = tafHourParts(taf, from, to);
    if (!parts) continue;
    rows.push({ from: iso(from), to: iso(to), kind: 'prevailing', cond: conditions(parts.state) });
    for (const g of groups.filter(g => ['TEMPO','PROB'].includes(g.fcstChange))) {
      const gf = toMs(g.timeFrom), gt = toMs(g.timeTo);
      if (gf == null || gt == null) continue;
      const a = Math.max(from, gf), b = Math.min(to, gt);
      if (a >= b) continue;
      // Merge only fields present in this change group; a temporary group never replaces prevailing weather.
      const c = mergeChange(parts.state, g);
      rows.push({ from: iso(a), to: iso(b), kind: g.fcstChange, probability: g.probability == null ? null : Number(g.probability), cond: conditions(c) });
    }
  }
  for (const g of changes.filter(g => g.fcstChange === 'BECMG')) {
    const from = Math.max(start, toMs(g.timeFrom) ?? start), to = Math.min(end, toMs(g.timeBec ?? g.timeFrom) ?? end);
    if (from >= to) continue;
    const state = tafHourParts(taf, from, from + 1)?.state;
    const target = state && mergeChange(state, g);
    if (target) rows.push({ from: iso(from), to: iso(to), kind: 'BECMG', cond: conditions(target) });
  }
  return rows.sort((a,b) => Date.parse(a.from)-Date.parse(b.from) || (a.kind === 'prevailing' ? -1 : b.kind === 'prevailing' ? 1 : 0));
}
