// Pure helpers for the radar card (site/radar/card.js; tested by tools/radar.test.mjs): which airports get radar,
// the card's zoom for a ~66 nm wide view, and range-ring labels. Browser ESM with no imports, so Node can load it
// through a data: URL.

// NOAA MRMS grids, as in wx-radar.js `DOMS` (keep the two in step; the test compares them)
export const DOMS = [
  { k: "CONUS", ni: 7000, nj: 3500, lat0: 54.995, lon0: -129.995, d: 0.01 },
  { k: "ALASKA", ni: 5000, nj: 2200, lat0: 71.995, lon0: -175.995, d: 0.01 },
  { k: "HAWAII", ni: 2600, nj: 2200, lat0: 25.9975, lon0: -163.9975, d: 0.005 },
  { k: "CARIB", ni: 3000, nj: 1500, lat0: 24.995, lon0: -89.995, d: 0.01 },
  { k: "GUAM", ni: 2000, nj: 1800, lat0: 17.9975, lon0: 140.0025, d: 0.005 },
];
export function domFor(lat, lon) {
  for (const D of DOMS) {
    const dl = (((lon - D.lon0) % 360) + 360) % 360;
    if (lat <= D.lat0 && lat >= D.lat0 - (D.nj - 1) * D.d && dl <= (D.ni - 1) * D.d) return D;
  }
  return null;
}

// U.S. states (+ DC) and territories. Trip airports outside the curated list carry their country code in `state`
// (poller/trips-poll.mjs), and many country codes are also state codes (CA Canada, DE Germany, IN India…), so the
// airport's time zone has to be a U.S. one too.
const US_STATES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
  "PR GU VI AS MP").split(" "));
const US_AREAS = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];
const US_TZ = /^(America\/(New_York|Detroit|Indiana\/.+|Kentucky\/.+|Chicago|Menominee|North_Dakota\/.+|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Puerto_Rico|St_Thomas)|Pacific\/(Honolulu|Guam|Saipan|Pago_Pago)|US\/.+)$/;
export function isUS(a) {
  if (!a) return false;
  if (a.country) return US_AREAS.includes(a.country);
  if (!US_STATES.has(String(a.state || "").toUpperCase())) return false;
  return !a.tz || US_TZ.test(a.tz);
}
/** The card shows for U.S. airports on one of NOAA's MRMS grids (CONUS, Alaska, Hawaii, Puerto Rico, Guam). */
export function covered(a) {
  return isUS(a) && Number.isFinite(+a.lat) && Number.isFinite(+a.lon) && !!domFor(+a.lat, +a.lon);
}

export const NM = 1852; // metres
export const RINGS_NM = [10, 30];
export const SPAN_NM = 66; // card width: the 30 nm ring just fits across
/** Web-mercator zoom (256 px tiles) at which `widthPx` CSS pixels span `spanNm` at latitude `lat`. */
export function zoomFor(widthPx, lat, spanNm = SPAN_NM) {
  const w = widthPx > 0 ? widthPx : 358;
  const z = Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180) * w) / (256 * spanNm * NM));
  return Math.max(6, Math.min(10, Math.round(z * 100) / 100));
}
/** Range-ring label: nautical miles in Aviation mode, statute miles otherwise (10 nm → "12 mi"). */
export function ringLabel(nm, aviation) {
  return aviation ? nm + " nm" : Math.round(nm * 1.150779) + " mi";
}
