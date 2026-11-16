import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDates, getDay, nowText } from '../src/dates';

// Sunday 15 Nov 2026, 14:30 in India (09:00 UTC)
const now = new Date('2026-11-15T09:00:00Z');
const tz = 'Asia/Kolkata';

// helper: just the days we found in a text
function days(text: string): string[] {
  return findDates(text, now, tz).map((d) => d.day);
}

test('the date and time are shown in the user time zone', () => {
  assert.equal(getDay(now, tz), '2026-11-15');
  assert.match(nowText(now, tz), /Sunday 15 November 2026, 14:30/);
});

test('"Monday" means the most recent Monday', () => {
  const found = findDates('On Monday we shortlisted 5 CRM tools.', now, tz);
  assert.equal(found[0].day, '2026-11-09');
  assert.equal(found[0].guessed, true);
});

test('"last Tuesday"', () => {
  assert.deepEqual(days('Last Tuesday I asked you about Postgres hosting.'), ['2026-11-10']);
});

test('a day and month without a year', () => {
  assert.deepEqual(days('What did I ask you on 3 November?'), ['2026-11-03']);
  assert.deepEqual(days('What did I ask you on 20 December?'), ['2025-12-20']); // 20 Dec 2026 is in the future, so use last year
});

test('yesterday and "3 days ago"', () => {
  assert.deepEqual(days('what did I ask yesterday'), ['2026-11-14']);
  assert.deepEqual(days('I asked you 3 days ago'), ['2026-11-12']);
});

test('"next Monday" stays in the future, and normal text has no dates', () => {
  assert.deepEqual(days('Will the price change next Monday?'), ['2026-11-16']);
  assert.deepEqual(days('Which is cheaper for 20 people, HubSpot or Pipedrive?'), []);
});

test('the user day is used, not the server day', () => {
  // 23:30 UTC on Sunday is already Monday morning in India
  const late = new Date('2026-11-15T23:30:00Z');
  assert.deepEqual(findDates('yesterday', late, tz).map((d) => d.day), ['2026-11-15']);
});
