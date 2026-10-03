// Raw TAF / METAR text -> the same shape aviationweather.gov's JSON API gives, so
// risk.mjs (tafHour, assessConditions) can score historical reports unchanged.
// Pure, no I/O. Unit-tested in taf-parse.test.mjs.
//
// parseTaf(raw, {issueTime?, ref?}) -> {icaoId, rawTAF, issueTime, validTimeFrom, validTimeTo,
//   amd, cor, cancelled, nil, fcsts: [{timeFrom, timeTo, timeBec, fcstChange, probability,
//   wdir, wspd, wgst, visib, wxString, clouds: [{cover, base, type}]}]} | null
// Times are epoch seconds (as in AWC JSON). DDHH day numbers are resolved to the month
// nearest `issueTime` (or `ref`, default now). visib: number of statute miles, "6+" for P6SM.

const HOUR = 3600e3;

const WIND = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/;
const VIS_SM = /^([MP])?(\d+)SM$/;
const VIS_FRAC = /^([MP])?(\d+)\/(\d+)SM$/;
const VIS_M = /^(\d{4})$/;
const CLOUD = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/;
const CLEAR = /^(SKC|CLR|NSC|NCD)$/;
// Intensity/proximity, up to two descriptors, then phenomena (all two-letter codes).
const WX = /^(?:[+-]|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ){0,2}(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS){0,4}$/;

function isWx(tok) {
  if (tok === "NSW") return true;
  const core = tok.replace(/^([+-]|VC)/, "");
  return core.length >= 2 && WX.test(tok);
}

/**
 * Parse condition tokens (one TAF group or a METAR body).
 * Returns {wdir, wspd, wgst, visib, wxString, clouds}; fields not present are null, clouds [].
 */
export function parseConditions(tokens) {
  const o = { wdir: null, wspd: null, wgst: null, visib: null, wxString: null, clouds: [] };
  const wx = [];
  let visSet = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let m;
    if ((m = WIND.exec(t))) {
      const k = m[4] === "MPS" ? 1.94384 : 1;
      o.wdir = m[1] === "VRB" ? "VRB" : Number(m[1]);
      o.wspd = Math.round(Number(m[2]) * k);
      o.wgst = m[3] ? Math.round(Number(m[3]) * k) : null;
    } else if (t === "P6SM") {
      o.visib = "6+"; visSet = true;
    } else if ((m = VIS_FRAC.exec(t))) {
      let v = Number(m[2]) / Number(m[3]);
      const prev = tokens[i - 1];
      if (!m[1] && prev && /^\d$/.test(prev)) v += Number(prev); // "1 1/2SM"
      o.visib = v; visSet = true;
    } else if ((m = VIS_SM.exec(t))) {
      o.visib = m[1] === "P" ? `${m[2]}+` : Number(m[2]); visSet = true;
    } else if (!visSet && (m = VIS_M.exec(t)) && !(tokens[i + 1] && VIS_FRAC.test(tokens[i + 1]))) {
      const meters = Number(m[1]);
      o.visib = meters >= 9999 ? "6+" : Math.round((meters / 1609.344) * 100) / 100; visSet = true;
    } else if (t === "CAVOK") {
      o.visib = "6+"; visSet = true;
      o.clouds.push({ cover: "SKC", base: null, type: null });
    } else if ((m = CLOUD.exec(t))) {
      o.clouds.push({ cover: m[1], base: m[2] === "///" ? null : Number(m[2]) * 100, type: m[3] && m[3] !== "///" ? m[3] : null });
    } else if (CLEAR.test(t)) {
      o.clouds.push({ cover: t, base: null, type: null });
    } else if (isWx(t)) {
      wx.push(t);
    }
  }
  if (wx.length) o.wxString = wx.join(" ");
  return o;
}

/** Epoch ms for day/hour/minute (UTC) in the month nearest refMs. hour 24 = next day 00. */
export function resolveDay(day, hour, minute, refMs) {
  const r = new Date(refMs);
  let best = null;
  for (const k of [-1, 0, 1]) {
    const y = r.getUTCFullYear();
    const mo = r.getUTCMonth() + k;
    const d = new Date(Date.UTC(y, mo, day, 0, minute));
    if (d.getUTCDate() !== day) continue; // day doesn't exist in that month
    const t = +d + hour * HOUR;
    if (best == null || Math.abs(t - refMs) < Math.abs(best - refMs)) best = t;
  }
  return best;
}

const sec = (ms) => (ms == null ? null : Math.round(ms / 1000));

function tokenize(raw) {
  let s = String(raw || "").toUpperCase().replace(/[\r\n\t]+/g, " ").replace(/=/g, " ");
  // Remarks are free text; US TAFs rarely carry them, but "RMK" ends the coded part.
  s = s.replace(/\sRMK\s.*$/, " ");
  return s.split(/\s+/).filter(Boolean);
}

const PERIOD = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/;
const ISSUE = /^(\d{2})(\d{2})(\d{2})Z$/;
const FM = /^FM(\d{2})(\d{2})(\d{2})$/;
const PROB = /^PROB(\d{2})$/;

export function parseTaf(raw, { issueTime = null, ref = null } = {}) {
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  let i = 0;
  const out = { icaoId: null, rawTAF: String(raw).trim(), issueTime: null, validTimeFrom: null, validTimeTo: null, amd: false, cor: false, cancelled: false, nil: false, fcsts: [] };
  const refMs = issueTime != null ? +issueTime : ref != null ? +ref : Date.now();

  // header: [TAF] [AMD|COR|RTD]* STATION [DDHHMMZ] [DDHH/DDHH]
  while (i < tokens.length && /^(TAF|AMD|COR|RTD)$/.test(tokens[i])) {
    if (tokens[i] === "AMD") out.amd = true;
    if (tokens[i] === "COR") out.cor = true;
    i++;
  }
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] || "") && !isWx(tokens[i])) out.icaoId = tokens[i++];
  while (i < tokens.length && /^(AMD|COR|RTD)$/.test(tokens[i])) {
    if (tokens[i] === "AMD") out.amd = true;
    if (tokens[i] === "COR") out.cor = true;
    i++;
  }
  let issueMs = issueTime != null ? +issueTime : null;
  let m;
  if ((m = ISSUE.exec(tokens[i] || ""))) {
    const parsed = resolveDay(+m[1], +m[2], +m[3], refMs);
    if (issueMs == null) issueMs = parsed;
    i++;
  }
  const anchor = issueMs ?? refMs;
  if (tokens[i] === "NIL") { out.nil = true; out.issueTime = sec(issueMs); return out; }
  let vFrom = null;
  let vTo = null;
  if ((m = PERIOD.exec(tokens[i] || ""))) {
    vFrom = resolveDay(+m[1], +m[2], 0, anchor);
    vTo = resolveDay(+m[3], +m[4], 0, vFrom ?? anchor);
    if (vTo != null && vFrom != null && vTo <= vFrom) vTo += 30 * 24 * HOUR; // never expected
    i++;
  }
  if (tokens[i] === "CNL" || tokens.includes("CNL")) out.cancelled = true;
  if (tokens[i] === "NIL") out.nil = true;
  out.issueTime = sec(issueMs);
  out.validTimeFrom = sec(vFrom);
  out.validTimeTo = sec(vTo);
  if (out.cancelled || out.nil) return out;

  // Split the rest into groups.
  const groups = [];
  let cur = { kind: null, from: vFrom, to: null, bec: null, prob: null, toks: [] };
  const period = (tok, fallbackFrom) => {
    const p = PERIOD.exec(tok || "");
    if (!p) return null;
    const a = resolveDay(+p[1], +p[2], 0, fallbackFrom ?? anchor);
    return [a, resolveDay(+p[3], +p[4], 0, a ?? anchor)];
  };
  const startGroup = (g) => { groups.push(cur); cur = g; };
  while (i < tokens.length) {
    const t = tokens[i];
    if ((m = FM.exec(t))) {
      startGroup({ kind: "FM", from: resolveDay(+m[1], +m[2], +m[3], vFrom ?? anchor), to: null, bec: null, prob: null, toks: [] });
      i++;
    } else if (t === "BECMG" || t === "TEMPO" || PROB.test(t)) {
      let kind = t === "BECMG" ? "BECMG" : t === "TEMPO" ? "TEMPO" : "PROB";
      let prob = null;
      if (kind === "PROB") {
        prob = Number(PROB.exec(t)[1]);
        if (tokens[i + 1] === "TEMPO") { kind = "TEMPO"; i++; }
      }
      const p = period(tokens[i + 1], vFrom);
      if (p) i += 2; else i += 1;
      startGroup({ kind, from: p ? p[0] : null, to: p ? p[1] : null, bec: kind === "BECMG" && p ? p[1] : null, prob, toks: [] });
    } else {
      cur.toks.push(t);
      i++;
    }
  }
  groups.push(cur);

  // FM/base end at the next FM (or the end of validity).
  const fmTimes = groups.filter((g) => g.kind === "FM" && g.from != null).map((g) => g.from).sort((a, b) => a - b);
  for (const g of groups) {
    if (g.kind === null || g.kind === "FM") {
      const start = g.from ?? vFrom;
      g.to = fmTimes.find((x) => start != null && x > start) ?? vTo;
    }
  }
  for (const g of groups) {
    if (g.kind === null && !g.toks.length) continue; // e.g. header only before an FM
    const c = parseConditions(g.toks);
    out.fcsts.push({
      timeFrom: sec(g.from), timeTo: sec(g.to), timeBec: sec(g.bec),
      fcstChange: g.kind, probability: g.prob,
      wdir: c.wdir, wspd: c.wspd, wgst: c.wgst, visib: c.visib, wxString: c.wxString, clouds: c.clouds,
    });
  }
  return out;
}

/**
 * METAR/SPECI raw text -> {icaoId, obsTime (epoch s), wdir, wspd, wgst, visib, wxString, clouds}.
 * Remarks are dropped. obsTime is resolved against ref (epoch ms).
 */
export function parseMetar(raw, { ref = null } = {}) {
  const tokens = tokenize(raw);
  let i = 0;
  while (i < tokens.length && /^(METAR|SPECI|COR)$/.test(tokens[i])) i++;
  let icaoId = null;
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] || "") && !isWx(tokens[i])) icaoId = tokens[i++];
  let obsMs = null;
  const m = ISSUE.exec(tokens[i] || "");
  if (m) { obsMs = resolveDay(+m[1], +m[2], +m[3], ref ?? Date.now()); i++; }
  // Trend groups (not used in the US) end the body.
  const rest = [];
  for (; i < tokens.length; i++) {
    if (/^(BECMG|TEMPO|NOSIG)$/.test(tokens[i])) break;
    rest.push(tokens[i]);
  }
  return { icaoId, obsTime: sec(obsMs), ...parseConditions(rest) };
}
