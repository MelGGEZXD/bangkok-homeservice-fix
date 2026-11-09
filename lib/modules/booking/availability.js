// The available-slots read side (§3.6). Advisory only: it mirrors the 30-min interval logic so the
// UI can show open starts, but the WRITE path (slot_holds UNIQUE + BEGIN IMMEDIATE in service.js)
// is what actually guarantees no double-book. Two customers can both pass this read and only one
// can win the insert — which is exactly the teaching contrast with the real product.
import * as providersRepository from "../providers/repository.js";
import * as bookingRepository from "./repository.js";
import { slotRange, timeToMinutes, minutesToTime, weekdayOf, todayDate, nowHHMM } from "./slots.js";

export function availableSlots(providerId, date, durationMin) {
  const timing = providersRepository.findTiming(providerId, weekdayOf(date));
  if (!timing || !timing.is_open) return { date, slots: [] };

  const opening = timeToMinutes(timing.opening_time);
  const closing = timeToMinutes(timing.closing_time);
  const held = new Set(bookingRepository.heldSlotTimes(providerId, date));
  const isToday = date === todayDate();
  const nowMin = isToday ? timeToMinutes(nowHHMM()) : -1;

  const slots = [];
  for (let start = opening; start + durationMin <= closing; start += 30) {
    if (isToday && start < nowMin) continue; // no past starts today
    const occupied = slotRange(minutesToTime(start), durationMin);
    const free = occupied.every((s) => !held.has(s));
    if (free) slots.push(minutesToTime(start));
  }
  return { date, slots };
}
