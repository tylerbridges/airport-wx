// Approximate IANA time zone for an airport from its country / region / position.
// OurAirports carries no time zone, so this is a small built-in table: one zone per
// single-zone country, region tables for the US, Canada, Mexico, Brazil and Australia, and
// longitude bands elsewhere. Known imperfections (accepted, documented in README):
// zone lines are approximated by longitude/latitude, so airports within ~50 km of a zone
// boundary (e.g. Crossville TN, West Wendover NV, the Navajo Nation, NW Ontario, Russia's
// irregular borders) can get the neighbouring zone. Unknown countries get null (shown as UTC).

const COUNTRY = {
  // Americas (single zone)
  PR: "America/Puerto_Rico", VI: "America/St_Thomas", AG: "America/Antigua", AI: "America/Anguilla", AW: "America/Aruba",
  BB: "America/Barbados", BL: "America/St_Barthelemy", BM: "Atlantic/Bermuda", BO: "America/La_Paz", BQ: "America/Kralendijk",
  BS: "America/Nassau", BZ: "America/Belize", CO: "America/Bogota", CR: "America/Costa_Rica", CU: "America/Havana",
  CW: "America/Curacao", DM: "America/Dominica", DO: "America/Santo_Domingo", GD: "America/Grenada", GF: "America/Cayenne",
  GP: "America/Guadeloupe", GT: "America/Guatemala", GY: "America/Guyana", HN: "America/Tegucigalpa", HT: "America/Port-au-Prince",
  JM: "America/Jamaica", KN: "America/St_Kitts", KY: "America/Cayman", LC: "America/St_Lucia", MF: "America/Marigot",
  MQ: "America/Martinique", MS: "America/Montserrat", NI: "America/Managua", PA: "America/Panama", PE: "America/Lima",
  PM: "America/Miquelon", PY: "America/Asuncion", SR: "America/Paramaribo", SV: "America/El_Salvador", SX: "America/Lower_Princes",
  TC: "America/Grand_Turk", TT: "America/Port_of_Spain", UY: "America/Montevideo", VC: "America/St_Vincent", VE: "America/Caracas",
  VG: "America/Tortola", AR: "America/Argentina/Buenos_Aires", FK: "Atlantic/Stanley",
  // Europe
  AD: "Europe/Andorra", AL: "Europe/Tirane", AT: "Europe/Vienna", AX: "Europe/Mariehamn", BA: "Europe/Sarajevo", BE: "Europe/Brussels",
  BG: "Europe/Sofia", BY: "Europe/Minsk", CH: "Europe/Zurich", CY: "Asia/Nicosia", CZ: "Europe/Prague", DE: "Europe/Berlin",
  DK: "Europe/Copenhagen", EE: "Europe/Tallinn", FI: "Europe/Helsinki", FO: "Atlantic/Faroe", FR: "Europe/Paris", GB: "Europe/London",
  GG: "Europe/Guernsey", GI: "Europe/Gibraltar", GR: "Europe/Athens", HR: "Europe/Zagreb", HU: "Europe/Budapest", IE: "Europe/Dublin",
  IM: "Europe/Isle_of_Man", IS: "Atlantic/Reykjavik", IT: "Europe/Rome", JE: "Europe/Jersey", LI: "Europe/Vaduz", LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg", LV: "Europe/Riga", MC: "Europe/Monaco", MD: "Europe/Chisinau", ME: "Europe/Podgorica", MK: "Europe/Skopje",
  MT: "Europe/Malta", NL: "Europe/Amsterdam", NO: "Europe/Oslo", PL: "Europe/Warsaw", RO: "Europe/Bucharest", RS: "Europe/Belgrade",
  SE: "Europe/Stockholm", SI: "Europe/Ljubljana", SJ: "Arctic/Longyearbyen", SK: "Europe/Bratislava", SM: "Europe/San_Marino",
  TR: "Europe/Istanbul", UA: "Europe/Kyiv", XK: "Europe/Belgrade",
  // Africa
  AO: "Africa/Luanda", BF: "Africa/Ouagadougou", BI: "Africa/Bujumbura", BJ: "Africa/Porto-Novo", BW: "Africa/Gaborone", CF: "Africa/Bangui",
  CG: "Africa/Brazzaville", CI: "Africa/Abidjan", CM: "Africa/Douala", CV: "Atlantic/Cape_Verde", DJ: "Africa/Djibouti", DZ: "Africa/Algiers",
  EG: "Africa/Cairo", EH: "Africa/El_Aaiun", ER: "Africa/Asmara", ET: "Africa/Addis_Ababa", GA: "Africa/Libreville", GH: "Africa/Accra",
  GM: "Africa/Banjul", GN: "Africa/Conakry", GQ: "Africa/Malabo", GW: "Africa/Bissau", KE: "Africa/Nairobi", KM: "Indian/Comoro",
  LR: "Africa/Monrovia", LS: "Africa/Maseru", LY: "Africa/Tripoli", MA: "Africa/Casablanca", MG: "Indian/Antananarivo", ML: "Africa/Bamako",
  MR: "Africa/Nouakchott", MU: "Indian/Mauritius", MW: "Africa/Blantyre", MZ: "Africa/Maputo", NA: "Africa/Windhoek", NE: "Africa/Niamey",
  NG: "Africa/Lagos", RE: "Indian/Reunion", RW: "Africa/Kigali", SC: "Indian/Mahe", SD: "Africa/Khartoum", SH: "Atlantic/St_Helena",
  SL: "Africa/Freetown", SN: "Africa/Dakar", SO: "Africa/Mogadishu", SS: "Africa/Juba", ST: "Africa/Sao_Tome", SZ: "Africa/Mbabane",
  TD: "Africa/Ndjamena", TG: "Africa/Lome", TN: "Africa/Tunis", TZ: "Africa/Dar_es_Salaam", UG: "Africa/Kampala", YT: "Indian/Mayotte",
  ZA: "Africa/Johannesburg", ZM: "Africa/Lusaka", ZW: "Africa/Harare",
  // Asia / Middle East
  AE: "Asia/Dubai", AF: "Asia/Kabul", AM: "Asia/Yerevan", AZ: "Asia/Baku", BD: "Asia/Dhaka", BH: "Asia/Bahrain", BN: "Asia/Brunei",
  BT: "Asia/Thimphu", CN: "Asia/Shanghai", GE: "Asia/Tbilisi", HK: "Asia/Hong_Kong", IL: "Asia/Jerusalem", IN: "Asia/Kolkata",
  IQ: "Asia/Baghdad", IR: "Asia/Tehran", JO: "Asia/Amman", JP: "Asia/Tokyo", KG: "Asia/Bishkek", KH: "Asia/Phnom_Penh",
  KP: "Asia/Pyongyang", KR: "Asia/Seoul", KW: "Asia/Kuwait", KZ: "Asia/Almaty", LA: "Asia/Vientiane", LB: "Asia/Beirut",
  LK: "Asia/Colombo", MM: "Asia/Yangon", MO: "Asia/Macau", MV: "Indian/Maldives", MY: "Asia/Kuala_Lumpur", NP: "Asia/Kathmandu",
  OM: "Asia/Muscat", PH: "Asia/Manila", PK: "Asia/Karachi", PS: "Asia/Gaza", QA: "Asia/Qatar", SA: "Asia/Riyadh", SG: "Asia/Singapore",
  SY: "Asia/Damascus", TH: "Asia/Bangkok", TJ: "Asia/Dushanbe", TL: "Asia/Dili", TM: "Asia/Ashgabat", TW: "Asia/Taipei",
  UZ: "Asia/Tashkent", VN: "Asia/Ho_Chi_Minh", YE: "Asia/Aden", IO: "Indian/Chagos",
  // Oceania / Pacific
  AS: "Pacific/Pago_Pago", CK: "Pacific/Rarotonga", FJ: "Pacific/Fiji", GU: "Pacific/Guam", MH: "Pacific/Majuro", MP: "Pacific/Saipan",
  NC: "Pacific/Noumea", NF: "Pacific/Norfolk", NR: "Pacific/Nauru", NU: "Pacific/Niue", NZ: "Pacific/Auckland", PG: "Pacific/Port_Moresby",
  PW: "Pacific/Palau", SB: "Pacific/Guadalcanal", TO: "Pacific/Tongatapu", TV: "Pacific/Funafuti", VU: "Pacific/Efate", WF: "Pacific/Wallis",
  WS: "Pacific/Apia", PF: "Pacific/Tahiti", FM: "Pacific/Pohnpei", KI: "Pacific/Tarawa", UM: "Pacific/Wake",
};

const US_STATE = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago",
  WY: "America/Denver",
};

/** Split US states: approximate zone lines by longitude (and latitude where the line bends). */
function usTz(st, lat, lon) {
  switch (st) {
    case "FL": return lon < -85.0 ? "America/Chicago" : "America/New_York"; // panhandle west of the Apalachicola
    case "TN": return lon > -85.4 ? "America/New_York" : "America/Chicago"; // Knoxville/Chattanooga Eastern
    case "KY": return lon > -86.2 ? "America/New_York" : "America/Chicago";
    case "IN": return lon < -87.0 ? "America/Chicago" : "America/Indiana/Indianapolis"; // Gary and Evansville areas Central
    case "MI": return lat > 45 && lon < -87.6 ? "America/Menominee" : "America/Detroit";
    case "ND": return lat < 47.3 && lon < -101.3 ? "America/Denver" : "America/Chicago";
    case "SD": return lon < -100.5 ? "America/Denver" : "America/Chicago";
    case "NE": return lon < -101.3 ? "America/Denver" : "America/Chicago";
    case "KS": return lon < -101.4 ? "America/Denver" : "America/Chicago";
    case "TX": return lon < -104.9 ? "America/Denver" : "America/Chicago"; // El Paso
    case "OR": return lon > -117.6 && lat < 44.5 ? "America/Boise" : "America/Los_Angeles"; // Malheur County
    case "ID": return lat > 45.3 ? "America/Los_Angeles" : "America/Boise"; // panhandle Pacific
    case "AK": return lon < -169.5 ? "America/Adak" : "America/Anchorage";
    default: return US_STATE[st] || null;
  }
}

function caTz(r, lat, lon) {
  switch (r) {
    case "BC": return "America/Vancouver";
    case "AB": return "America/Edmonton";
    case "SK": return "America/Regina";
    case "MB": return "America/Winnipeg";
    case "ON": return lon < -90.5 ? "America/Winnipeg" : "America/Toronto";
    case "QC": return "America/Toronto";
    case "NB": case "NS": case "PE": return "America/Halifax";
    case "NL": return lat > 51.5 && lon < -57 ? "America/Goose_Bay" : "America/St_Johns";
    case "YT": return "America/Whitehorse";
    case "NT": return "America/Yellowknife";
    case "NU": return lon > -85 ? "America/Iqaluit" : lon > -102 ? "America/Rankin_Inlet" : "America/Cambridge_Bay";
    default: return "America/Toronto";
  }
}

const MX = { BCN: "America/Tijuana", BCS: "America/Mazatlan", SIN: "America/Mazatlan", NAY: "America/Mazatlan", SON: "America/Hermosillo", CHH: "America/Chihuahua", ROO: "America/Cancun" };
const BR = { AC: "America/Rio_Branco", AM: "America/Manaus", RR: "America/Boa_Vista", RO: "America/Porto_Velho", MT: "America/Cuiaba", MS: "America/Campo_Grande" };
const AU = { WA: "Australia/Perth", NT: "Australia/Darwin", SA: "Australia/Adelaide", QLD: "Australia/Brisbane", NSW: "Australia/Sydney", ACT: "Australia/Sydney", VIC: "Australia/Melbourne", TAS: "Australia/Hobart" };

function ruTz(lon) {
  const bands = [[22.5, "Europe/Kaliningrad"], [48, "Europe/Moscow"], [53, "Europe/Samara"], [66, "Asia/Yekaterinburg"], [76, "Asia/Omsk"],
    [90, "Asia/Novosibirsk"], [106, "Asia/Krasnoyarsk"], [120, "Asia/Irkutsk"], [135, "Asia/Yakutsk"], [147, "Asia/Vladivostok"], [160, "Asia/Magadan"]];
  if (lon < 0) return "Asia/Kamchatka"; // Chukotka east of 180
  for (const [max, tz] of bands) if (lon < max) return tz;
  return "Asia/Kamchatka";
}

/**
 * country: ISO2, region: OurAirports iso_region ("US-MN", "CA-ON", "AU-NSW"), lat/lon in degrees.
 * Returns an IANA zone name or null.
 */
export function tzFor(country, region, lat, lon) {
  const c = String(country || "").toUpperCase();
  const r = String(region || "").toUpperCase().split("-").slice(1).join("-");
  switch (c) {
    case "US": return usTz(r, lat, lon);
    case "CA": return caTz(r, lat, lon);
    case "MX": return MX[r] || "America/Mexico_City";
    case "BR": return BR[r] || "America/Sao_Paulo";
    case "AU": return AU[r] || (lon < 129 ? "Australia/Perth" : lon < 138 ? "Australia/Darwin" : "Australia/Sydney");
    case "RU": return ruTz(lon);
    case "ID": return lon < 114.5 ? "Asia/Jakarta" : lon < 126.5 ? "Asia/Makassar" : "Asia/Jayapura";
    case "CL": return lon < -100 ? "Pacific/Easter" : "America/Santiago";
    case "EC": return lon < -85 ? "Pacific/Galapagos" : "America/Guayaquil";
    case "ES": return lon < -12 ? "Atlantic/Canary" : "Europe/Madrid";
    case "PT": return lon < -20 ? "Atlantic/Azores" : lon < -15 ? "Atlantic/Madeira" : "Europe/Lisbon";
    case "CD": return lon < 22 ? "Africa/Kinshasa" : "Africa/Lubumbashi";
    case "MN": return lon < 100 ? "Asia/Hovd" : "Asia/Ulaanbaatar";
    case "GL": return lat > 75 && lon < -60 ? "America/Thule" : "America/Nuuk";
    case "KI": return lon < 0 ? "Pacific/Kiritimati" : "Pacific/Tarawa";
    case "FM": return lon < 155 ? "Pacific/Chuuk" : "Pacific/Pohnpei";
    case "PF": return lon > -141 && lat > -11 ? "Pacific/Marquesas" : "Pacific/Tahiti";
    default: return COUNTRY[c] || null;
  }
}
