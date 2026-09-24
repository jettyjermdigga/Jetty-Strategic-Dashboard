// Jetty's retail calendar.
//
// The sheet carries Year, Week, Start (Week), End (Week), Month and Day next to
// the event date. Every one of them is a function of that date, so the calendar
// derives them instead of storing them. That is not just tidier: the sheet
// already disagrees with itself in three places -- one week number off by one
// and two weekday labels that do not match their own date -- which is exactly
// what happens when the same fact is typed in twice.
//
// Retail week filtering still works; the values are simply computed on the way
// out rather than entered on the way in.

import { RETAIL_EPOCH, RETAIL_EPOCH_YEAR } from './taxonomy.js';

const DAY_MS = 86400000;

function utcFromYmd(s) {
  const p = String(s).split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}

function ymdFromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** { year, week, start, end } for the retail week containing a YYYY-MM-DD date. */
export function retailWeek(dateStr) {
  if (!dateStr) return null;
  const base = utcFromYmd(RETAIL_EPOCH);
  const idx = Math.floor((utcFromYmd(dateStr) - base) / (7 * DAY_MS));
  const yearOffset = Math.floor(idx / 52);
  const start = base + idx * 7 * DAY_MS;
  return {
    year: RETAIL_EPOCH_YEAR + yearOffset,
    week: idx - yearOffset * 52 + 1,
    start: ymdFromUtc(start),
    end: ymdFromUtc(start + 6 * DAY_MS),
  };
}

/** First day of a given retail year/week, or null if the week is out of range. */
export function retailWeekStart(year, week) {
  const w = Number(week);
  const y = Number(year);
  if (!Number.isInteger(w) || w < 1 || w > 53) return null;
  if (!Number.isInteger(y)) return null;
  const idx = (y - RETAIL_EPOCH_YEAR) * 52 + (w - 1);
  return ymdFromUtc(utcFromYmd(RETAIL_EPOCH) + idx * 7 * DAY_MS);
}
