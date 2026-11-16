import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDay, prettyDay, stamp } from './dates';
import type { FoundDate } from './dates';

// A web page the agent used. The id is unique per user, so "[s12]" always means the same page.
export interface Source { id: number; title: string; url: string; published?: string }
export interface Message { id: string; session: string; role: 'user' | 'assistant'; text: string; time: string; sources?: Source[] }

// Each user has a file with one JSON message per line. We also keep the messages in memory.
const loaded: Record<string, Message[]> = {};

function fileFor(user: string): string {
  const name = user.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  return path.join(process.env.DATA_DIR || 'data', name + '.jsonl');
}

export function loadMessages(user: string): Message[] {
  if (!loaded[user]) {
    loaded[user] = [];
    if (fs.existsSync(fileFor(user))) {
      for (const line of fs.readFileSync(fileFor(user), 'utf8').split('\n')) {
        try { loaded[user].push(JSON.parse(line)); } catch { /* empty or broken line */ }
      }
    }
  }
  return loaded[user];
}

export function saveMessage(user: string, msg: Omit<Message, 'id'>) {
  const message: Message = { id: randomUUID(), ...msg };
  loadMessages(user).push(message);
  fs.mkdirSync(path.dirname(fileFor(user)), { recursive: true });
  fs.appendFileSync(fileFor(user), JSON.stringify(message) + '\n');
}

// The last messages of one chat session (the history must start with a user message)
export function sessionMessages(user: string, session: string, limit = 20): Message[] {
  const list = loadMessages(user).filter((m) => m.session === session).slice(-limit);
  while (list.length > 0 && list[0].role === 'assistant') list.shift();
  return list;
}

function allSources(user: string): Source[] {
  return loadMessages(user).flatMap((m) => m.sources || []);
}
export function nextSourceId(user: string): number {
  return Math.max(0, ...allSources(user).map((s) => s.id)) + 1;
}
export function findSource(user: string, id: number): Source | undefined {
  return allSources(user).find((s) => s.id === id);
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function shorten(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// "[s1] Title (example.com, published 2026-11-12); [s2] ..."
export function sourceList(sources: Source[]): string {
  return sources
    .slice(0, 6)
    .map((s) => `[s${s.id}] ${shorten(s.title, 80)} (${hostOf(s.url)}${s.published ? ', published ' + s.published : ''})`)
    .join('; ');
}

function formatMessages(messages: Message[], tz: string): string {
  return messages
    .map((m) => {
      const time = '[' + stamp(m.time, tz) + ']';
      if (m.role === 'user') return time + ' USER: ' + shorten(m.text, 900);
      const sources = m.sources && m.sources.length > 0 ? '\n  sources then: ' + sourceList(m.sources) : '';
      return time + ' ASSISTANT: ' + shorten(m.text, 1800) + sources;
    })
    .join('\n');
}

// Only look at old chats when the user seems to be talking about the past
const PAST_WORDS =
  /\b(earlier|before|previous|previously|last (time|week|month|\w+day)|ago|yesterday|you (said|told|gave|recommended|suggested|answered|mentioned)|i (ask|asked|told|mentioned|said)|did (i|we)|we (discussed|talked|shortlisted|chose|picked|decided|compared)|still (correct|true|right|valid|accurate)|changed|since|again|my (question|shortlist|list))\b/i;

// Questions like "what did I ask earlier?" that name no day and no topic
const LOOK_BACK = /\b(earlier|last time|previous(ly)?|did (i|we)|i (ask|asked)|you (said|told))\b/i;

const COMMON_WORDS = 'the and for with that this what when where which who how has have had was were are you your our from about since still not but did does any all can could would should just also than then there here get got'.split(' ');

function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !COMMON_WORDS.includes(w));
}

// Finds old messages related to what the user just wrote and returns text for the prompt ('' if not needed).
// It says clearly when nothing is stored, so the model does not make things up.
export function recall(user: string, text: string, dates: FoundDate[], session: string, tz: string): string {
  if (!PAST_WORDS.test(text)) return '';
  const old = loadMessages(user).filter((m) => m.session !== session);
  const parts: string[] = [];
  const shown: string[] = []; // ids of messages already included

  // 1. Messages from the days the user mentioned ("Monday", "3 November"...)
  for (const d of dates) {
    const thatDay = old.filter((m) => getDay(new Date(m.time), tz) === d.day).slice(-14);
    if (thatDay.length === 0) parts.push('No stored messages on ' + prettyDay(d.day) + '.');
    else parts.push('Stored messages from ' + prettyDay(d.day) + ':\n' + formatMessages(thatDay, tz));
    thatDay.forEach((m) => shown.push(m.id));
  }

  // 2. Earlier question+answer pairs that share keywords with the new message
  const words = keywords(text);
  const matches: { pair: Message[]; score: number; position: number }[] = [];
  for (let i = 0; i < old.length && words.length > 0; i++) {
    if (old[i].role !== 'user') continue;
    const pair = [old[i]];
    if (old[i + 1] && old[i + 1].role === 'assistant' && old[i + 1].session === old[i].session) pair.push(old[i + 1]);
    if (pair.some((m) => shown.includes(m.id))) continue;
    const pairWords = keywords(pair.map((m) => m.text).join(' '));
    const score = words.filter((w) => pairWords.includes(w)).length;
    if (score >= Math.min(2, words.length)) matches.push({ pair, score, position: i });
  }
  matches.sort((a, b) => b.score - a.score || b.position - a.position); // best first, newest first on ties
  if (matches.length > 0) {
    parts.push('Earlier exchanges that look related:\n' + matches.slice(0, 3).map((m) => formatMessages(m.pair, tz)).join('\n---\n'));
  }

  // 3. Nothing found
  if (parts.every((p) => p.startsWith('No stored'))) {
    if (dates.length === 0 && LOOK_BACK.test(text) && old.length > 0) {
      // "What did I ask you earlier?": show the end of the most recent earlier session
      const lastSession = old[old.length - 1].session;
      const recent = old.filter((m) => m.session === lastSession).slice(-8);
      parts.push('Most recent earlier conversation:\n' + formatMessages(recent, tz));
    } else {
      // otherwise just say which days we do have, so the model can be honest
      const days = [...new Set(old.map((m) => getDay(new Date(m.time), tz)))];
      parts.push(days.length > 0 ? 'Days with stored messages (most recent last): ' + days.slice(-10).join(', ') + '.' : 'There are no stored messages from any earlier session for this user.');
    }
  }
  return parts.join('\n\n');
}
