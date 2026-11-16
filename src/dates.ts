import * as chrono from 'chrono-node';

const ONE_DAY = 24 * 60 * 60 * 1000;

// Use UTC if the time zone name is missing or invalid
export function checkTz(tz?: string): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

// The calendar day like "2026-11-15", in the user's time zone
export function getDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// "2026-11-15" -> "Sunday 15 November 2026"
export function prettyDay(day: string): string {
  const text = new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return text.replace(/,/g, ''); // some Node versions add a comma
}

function getClock(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

// "Sunday 15 November 2026, 14:30 (Asia/Kolkata)"
export function nowText(date: Date, tz: string): string {
  return prettyDay(getDay(date, tz)) + ', ' + getClock(date, tz) + ' (' + tz + ')';
}

// Short time label for saved messages: "Mon 9 Nov 2026 10:12"
export function stamp(iso: string, tz: string): string {
  const date = new Date(iso);
  const day = new Date(getDay(date, tz) + 'T12:00:00Z')
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .replace(/,/g, '');
  return day + ' ' + getClock(date, tz);
}

export interface FoundDate {
  phrase: string; // the words the user wrote, like "On Monday"
  day: string; // the day we worked out, like "2026-11-09"
  guessed: boolean; // true when we guessed "the most recent Monday"
}

const FUTURE_WORDS = /\b(next|upcoming|coming|tomorrow|will|going to)\b/i;

// Turns "Monday", "last Tuesday", "3 November", "yesterday" into real days.
// We do this in code because language models are bad at weekday maths.
export function findDates(text: string, now: Date, tz: string): FoundDate[] {
  const today = getDay(now, tz);
  const [year, month, dayNumber] = today.split('-').map(Number);
  const todayTime = Date.UTC(year, month - 1, dayNumber);
  const noonToday = new Date(year, month - 1, dayNumber, 12, 0, 0);
  const found: FoundDate[] = [];

  for (const r of chrono.parse(text, noonToday, { forwardDate: false })) {
    const s = r.start;
    // skip things like "5 pm" or "in March" that are not a specific day
    if (!s.isCertain('day') && !s.isCertain('weekday')) continue;

    let time = Date.UTC(s.get('year')!, s.get('month')! - 1, s.get('day')!);
    let guessed = false;

    // People usually talk about the past ("on Monday we shortlisted..."),
    // so a date in the future is moved back, unless they said "next" etc.
    const wordsBefore = text.slice(Math.max(0, r.index - 14), r.index + r.text.length);
    if (time > todayTime && !FUTURE_WORDS.test(wordsBefore)) {
      if (s.isCertain('weekday') && !s.isCertain('day')) {
        time = time - 7 * ONE_DAY; // just "Monday": go back one week
        guessed = true;
      } else if (!s.isCertain('year')) {
        time = Date.UTC(s.get('year')! - 1, s.get('month')! - 1, s.get('day')!); // "3 November": go back one year
      }
    }

    const day = new Date(time).toISOString().slice(0, 10);
    const alreadyFound = found.some((f) => f.day === day);
    if (day !== today && !alreadyFound) {
      found.push({ phrase: r.text, day, guessed });
    }
  }
  return found;
}
