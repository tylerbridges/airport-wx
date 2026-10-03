import test from "node:test";
import assert from "node:assert/strict";
import { classifyCause, causePhrase, CAUSES } from "./cause.mjs";

test("cause classes by keyword", () => {
  const cases = {
    weather: ["WEATHER / THUNDERSTORMS", "WX:Low Ceilings", "thunderstorms", "wind", "low ceilings", "snow removal", "WEATHER / FOG", "TSTMS", "VCTS", "LOW CIGS"],
    volume: ["VOLUME / VOLUME", "volume", "TM Initiatives:MIT:VOL", "DEMAND"],
    equipment: ["EQUIPMENT / OUTAGE", "EQUIPMENT:RWY 22R ILS OTS", "radar outage", "ILS out of service", "FREQUENCY ISSUES", "EQ:Comm outage"],
    staffing: ["STAFFING / STAFFING", "ATC STAFFING TRIGGER", "ATC ZERO", "STAFFING / ATC ZERO", "staffing"],
    runway: ["RUNWAY-TAXIWAY / CONSTRUCTION", "RWY CONFIG", "runway closure", "RWY:Construction", "TAXIWAY WORK"],
    security: ["SECURITY", "OTHER / SECURITY", "terminal evacuation", "SUSPICIOUS PACKAGE"],
    airline: ["COMPANY REQUEST", "AIRLINE REQUEST", "COMPANY REQUEST / IT OUTAGE", "IT outage"],
    vip: ["VIP MOVEMENT", "OTHER / VIP MOVEMENT", "TFR"],
    space: ["SPACE LAUNCH", "OTHER / SPACE LAUNCH", "REENTRY", "rocket launch"],
    other: ["OTHER / AIRSHOW", "something odd", "!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT"],
    unknown: ["", null, undefined, "   "],
  };
  for (const [want, list] of Object.entries(cases)) for (const s of list) assert.equal(classifyCause(s), want, JSON.stringify(s));
  assert.deepEqual(Object.keys(cases).sort(), [...CAUSES].sort());
});

test("cause phrases are plain English with a useful detail only", () => {
  assert.equal(causePhrase("weather", "WEATHER / THUNDERSTORMS"), "weather (thunderstorms)");
  assert.equal(causePhrase("weather", "thunderstorms"), "weather (thunderstorms)");
  assert.equal(causePhrase("volume", "VOLUME / VOLUME"), "high traffic volume");
  assert.equal(causePhrase("staffing", "STAFFING / STAFFING"), "air traffic control staffing");
  assert.equal(causePhrase("staffing", "STAFFING / ATC ZERO"), "air traffic control staffing (ATC zero)");
  assert.equal(causePhrase("airline", "COMPANY REQUEST / IT OUTAGE"), "airline request (IT outage)");
  assert.equal(causePhrase("equipment", "EQUIPMENT / OUTAGE"), "equipment outage");
  assert.equal(causePhrase("vip", "VIP MOVEMENT"), "VIP movement");
  assert.equal(causePhrase("space", "SPACE LAUNCH"), "space launch or reentry (space launch)".replace(" (space launch)", ""));
  assert.equal(causePhrase("volume", "TM Initiatives:MIT:VOL"), "high traffic volume");
  assert.equal(causePhrase(undefined, "WX:Low Ceilings"), "weather (low ceilings)");
  assert.equal(causePhrase("unknown", ""), "");
  assert.equal(causePhrase(undefined, undefined), "");
});
