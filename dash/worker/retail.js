// Jetty's retail calendar: 52 weeks, grouped 4-4-5.
//
// A copy of calendar/worker/retail.js, deliberately -- the two Workers deploy
// separately, and a shared file would mean a calendar deploy could move the
// weeks a budget was built against. The epoch is the same and verified
// against the 2027 calendar Jeremy supplied, week by week.
//
// What is added here is the grouping the calendar never needed: 4-4-5 means
// March, June, September and December are five weeks long. Spreading a year
// across twelve equal months instead would overstate the four-week months
// and understate the five-week ones, every single year.

const DAY_MS = 86400000;
export const RETAIL_EPOCH = '2026-01-04';
export const RETAIL_EPOCH_YEAR = 2026;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const PATTERN = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];

const utc = (s) => {
  const p = String(s).split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
};
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** First day of a retail year/week. */
export function weekStart(year, week) {
  const idx = (year - RETAIL_EPOCH_YEAR) * 52 + (week - 1);
  return ymd(utc(RETAIL_EPOCH) + idx * 7 * DAY_MS);
}

/** [{ label, start, end, weeks }] for a cadence, in order. */
export function periods(year, cadence) {
  const span = (from, n) => ({
    start: weekStart(year, from),
    end: ymd(utc(weekStart(year, from + n - 1)) + 6 * DAY_MS),
    weeks: n,
  });

  if (cadence === 'week') {
    return Array.from({ length: 52 }, (_, i) => ({ label: 'W' + (i + 1), ...span(i + 1, 1) }));
  }
  if (cadence === 'month') {
    const out = [];
    let w = 1;
    PATTERN.forEach((n, i) => { out.push({ label: MONTHS[i], ...span(w, n) }); w += n; });
    return out;
  }
  if (cadence === 'qtr') {
    return [0, 1, 2, 3].map((q) => ({ label: 'Q' + (q + 1), ...span(q * 13 + 1, 13) }));
  }
  return [{ label: String(year), ...span(1, 52) }];
}

/** How many weeks each period of a cadence holds, in order. */
export function weekCounts(cadence) {
  if (cadence === 'week') return Array(52).fill(1);
  if (cadence === 'month') return [...PATTERN];
  if (cadence === 'qtr') return [13, 13, 13, 13];
  return [52];
}
