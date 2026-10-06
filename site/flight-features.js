// Personal flights are an explicit device preference. Do not download the trip module until opted in.
let pending = null, failed = false;
const enabled = () => window.AWXPrefs.getPrefs().flights;
async function ready() {
  if (!enabled()) return;
  if (!pending) pending = import("./trips.js?v=28").catch(error => { pending = null; failed = true; throw error; });
  await pending;
  window.AWXTrips.setEnabled(enabled());
}
function sync() {
  if (!enabled()) { window.AWXTrips?.setEnabled(false); return; }
  ready().then(() => document.dispatchEvent(new CustomEvent("awx:flights-ready")))
    .catch(() => document.dispatchEvent(new CustomEvent("awx:flights-error")));
}
window.AWXFlights = { ready, failed: () => failed };
window.AWXPrefs.onPrefs((p, key) => { if (key === "flights" || key === null) sync(); });
sync();
