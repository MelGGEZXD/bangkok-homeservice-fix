// Pure time arithmetic for the 30-minute slot grid. No DB, no I/O — just the conversions the
// booking write path (§3.1) and the available-slots read path (§3.6) both build on.
export const SLOT_MINUTES = 30;

export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// The list of 30-min slot start times a booking of `durationMin` starting at `startHHMM` occupies,
// e.g. ("09:00", 90) -> ["09:00","09:30","10:00"]. This is exactly the set of rows written to
// slot_holds, and exactly the set of slots that must be free for a candidate start to be bookable.
export function slotRange(startHHMM, durationMin) {
  const start = timeToMinutes(startHHMM);
  const slots = [];
  for (let t = start; t < start + durationMin; t += SLOT_MINUTES) {
    slots.push(minutesToTime(t));
  }
  return slots;
}

// The weekday (0=Sun .. 6=Sat) of a 'YYYY-MM-DD' date, matching provider_timings.weekday.
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export function nowHHMM() {
  return new Date().toISOString().slice(11, 16);
}
