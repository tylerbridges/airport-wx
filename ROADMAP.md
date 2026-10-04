# Roadmap

Product goal: a traveler should feel confident they know about any disruption at their airports and on their flights.

## In progress
- Build 2b: settings (Traveler/Aviation mode, disruption toggles, time zone), Flighty-style detail sheet, Liquid Glass lens, midnight-to-midnight timeline with instant scrubbing, hold-to-reorder, national summary strip, source/confidence chips.
- Phase 3: calibrated delay chance per airport-hour from 24 months of BTS flight records, historical comparison ("In N similar evenings…"), accuracy page, monthly retraining with a safety gate.
- Build 4: trips (manual + Flighty calendar), per-flight concerns.

## Queued
- Map tab (a "Coming soon" placeholder in the tab bar today): disruption risk across your airports and trips on a map.
- Movement (ADS-B traffic, logging since 2026-10): after 4+ weeks of logging, add the departure-rate index as a live feature in the delay model.
- NOTAMs and FAA flight restrictions (TFRs), hub cascade warnings, 3-day range, delay-cause chips.
- Morning brief, per-airport change log, "what it means for me".
- Radar loop in the airport sheet.
- Terminal maps and lounges: shipped (OSM terminal map with gate search, curated lounges). Next: verify every lounge entry and official map link against the operator pages (all are "check before you go" until then); show the departure gate's concourse and nearest lounge on trip legs (TODO in `site/terminals.js`).

## Parked
- TSA wait times: researched and parked. Live checkpoint wait data is available only from paid providers. Revisit if a free, licensed source appears.

## Later: live flight-level delays and cancellations
Today the app uses FAA programs (ground stops, delay programs, general delays) plus the history-based model. Live "% of departures late, average delay, cancellations today" needs flight-level data, which has no free source at 5-minute coverage (researched 2026-10-03):
- FlightAware AeroAPI Personal: best fit (airport boards with actual vs scheduled times and cancellations, `/airports/delays`); $5/month free credit, then pay per call; personal-use terms.
- AeroDataBox free tier: ~300 board lookups/month, enough only for trip airports.
- Not viable: OpenSky (no schedules, previous-day flights, licence needed for operational use), AviationStack/Aviation Edge/FlightLabs/Cirium (quotas or price), FAA SWIM (persistent messaging connection), FAA ASPM (login, next-day).
Revisit with a capped AeroAPI or AeroDataBox integration limited to starred and trip airports.
