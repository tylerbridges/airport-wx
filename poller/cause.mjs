// Cause classification for FAA NAS status and ATCSCC programs, and plain-English cause phrases
// for risk reasons. No imports; unit-tested in cause.test.mjs.
//
// Classes: weather, volume, equipment, staffing, runway, security, airline, vip, space, other, unknown.
// Programs score by program type (ground stop, GDP, delay, closure) whatever the cause; the cause
// only names the reason ("Ground stop — air traffic control staffing, until 7:30 PM ET").

export const CAUSES = ["weather", "volume", "equipment", "staffing", "runway", "security", "airline", "vip", "space", "other", "unknown"];

// Most specific first: "IT OUTAGE" is an airline problem, not an FAA equipment outage.
const RULES = [
  ["staffing", /\b(STAFF\w*|ATC[\s-]+ZERO|ATC0)\b/i],
  ["security", /\b(SECURITY|EVAC\w*|BOMB|THREAT|SUSPICIOUS|LAW ENFORCEMENT|POLICE)\b/i],
  ["airline", /\b(COMPANY REQ\w*|AIRLINE REQ\w*|CARRIER REQ\w*|COMPANY|AIRLINE|IT OUTAGE|IT ISSUES?)\b/i],
  ["vip", /\b(VIP|VIP MOVEMENT|TFR|PRESIDENTIAL|POTUS)\b/i],
  ["space", /\b(SPACE|LAUNCH|REENTRY|RE-ENTRY|ROCKET)\b/i],
  ["runway", /\b(RWY|RWYS|RUNWAYS?|RUNWAY-TAXIWAY|TAXIWAYS?|TWY|CONSTRUCTION|CONFIG\w*)\b/i],
  ["equipment", /\b(EQ|EQUIP\w*|OUTAGE|RADAR|ILS|NAVAIDS?|COMM|COMMS|COMMUNICATIONS?|FREQ\w*|POWER|AUTOMATION|TELCO|OTS|U\/S)\b/i],
  ["volume", /\b(VOL|VOLUME|DEMAND|COMPACTED DEMAND)\b/i],
  ["weather", /\b(WX|WEATHER|THUNDER\w*|TSTMS?|TS|VCTS|TSRA|CONVECT\w*|WINDS?|CROSSWINDS?|WIND SHEAR|CEILINGS?|LOW CIG\w*|CIGS?|FOG|SNOW|ICE|ICING|FREEZING|RAIN|VIS|VISIBILITY|LOW VIS\w*|HURRICANE|TROPICAL|DEICING|DE-ICING|LIGHTNING)\b/i],
];

/**
 * Class from reason text such as "WEATHER / THUNDERSTORMS", "VOLUME / VOLUME", "WX:Low Ceilings",
 * "TM Initiatives:MIT:VOL", "STAFFING / ATC ZERO", "COMPANY REQUEST / IT OUTAGE".
 * The category before the first "/" or ":" wins; otherwise keywords anywhere; else "other".
 */
export function classifyCause(text) {
  const s = String(text ?? "").trim();
  if (!s) return "unknown";
  const head = s.split(/[/:]/)[0];
  for (const [k, re] of RULES) if (re.test(head)) return k;
  for (const [k, re] of RULES) if (re.test(s)) return k;
  return "other";
}

export const CAUSE_LABEL = {
  weather: "weather",
  volume: "high traffic volume",
  equipment: "equipment outage",
  staffing: "air traffic control staffing",
  runway: "runway work or configuration",
  security: "security",
  airline: "airline request",
  vip: "VIP movement",
  space: "space launch or reentry",
  other: "other cause",
  unknown: "",
};

const ACRONYMS = new Set(["IT", "ATC", "ILS", "VIP", "TFR", "GPS", "FAA", "ARTCC", "TRACON", "RWY", "TWY", "NAS"]);

function tidyDetail(s) {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.toLowerCase()))
    .join(" ");
}

/**
 * Plain-English cause for a reason string: "weather (thunderstorms)", "airline request (IT outage)",
 * "air traffic control staffing". "" when the cause is unknown.
 */
export function causePhrase(cause, text) {
  const c = CAUSES.includes(cause) ? cause : classifyCause(text);
  const label = CAUSE_LABEL[c] || "";
  if (!label) return "";
  const s = String(text ?? "").trim();
  const sep = s.search(/[/:]/);
  let detail = sep >= 0 ? s.slice(sep + 1) : s;
  detail = detail.replace(/[.\s]+$/, "").trim();
  if (!detail || detail.length > 40 || !/^[A-Za-z][A-Za-z0-9 ,'&-]*$/.test(detail)) return label;
  const d = tidyDetail(detail);
  const words = (x) => x.toLowerCase().split(/\W+/).filter(Boolean);
  const lw = new Set([...words(label), c]);
  if (words(d).every((w) => lw.has(w))) return label;
  return `${label} (${d})`;
}
