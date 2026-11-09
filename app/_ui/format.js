// Server-side formatting helpers shared across pages. No 'use client' — used inside Server
// Components.
export function money(cents) {
  if (cents === null || cents === undefined) return "—";
  return "฿" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function Badge({ status }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
