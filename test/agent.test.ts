import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// use a temporary folder so tests do not touch real data
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'agent-'));

const { runTurn } = await import('../src/agent');
const memory = await import('../src/memory');

const tz = 'Asia/Kolkata';

// A fake model reply that is just text
function say(text: string): any {
  return { calls: [], content: { role: 'model', parts: [{ text }] } };
}

// A fake model reply that asks for searches
function searches(...list: any[]): any {
  return {
    calls: list.map((args, i) => ({ id: 'c' + i, name: 'web_search', args })),
    content: { role: 'model', parts: list.map((args, i) => ({ functionCall: { id: 'c' + i, name: 'web_search', args } })) },
  };
}

// Fake deps: the model gives the replies we list in order, search returns one fake page per query.
function fakeDeps(replies: any[]) {
  const seen: { chat: any[]; lastRound: boolean }[] = [];
  const deps = {
    async askModel(chat: any[], lastRound: boolean, onText: (t: string) => void) {
      seen.push({ chat: JSON.parse(JSON.stringify(chat)), lastRound });
      const reply = replies[seen.length - 1];
      for (const part of reply.content.parts) {
        if (part.text) onText(part.text);
      }
      return reply;
    },
    async search(args: any) {
      const hit = { title: args.query + ' page', url: 'https://example.com/' + encodeURIComponent(args.query), published: '2026-11-12', snippet: 'snippet for ' + args.query };
      return { hits: [hit] };
    },
  };
  return { deps, seen };
}

// Asks one question and returns all events sent to the browser
async function ask(deps: any, text: string, now: string, session: string, user = 'u1') {
  const events: any[] = [];
  await runTurn({ userId: user, sessionId: session, text, tz, now: new Date(now), emit: (e) => events.push(e), signal: new AbortController().signal }, deps);
  return events;
}

// the text of the newest user message sent to the model
function lastPrompt(call: { chat: any[] }): string {
  const lastMessage = call.chat[call.chat.length - 1];
  return lastMessage.parts[lastMessage.parts.length - 1].text;
}

test('searches run together, citations are found and the answer is saved', async () => {
  const { deps, seen } = fakeDeps([
    searches({ query: 'HubSpot pricing' }, { query: 'Pipedrive pricing news', topic: 'news', since: '2026-11-09' }),
    say('HubSpot is unchanged [s1]. Pipedrive announced a change [s2].'),
  ]);
  const events = await ask(deps, 'On Monday we shortlisted HubSpot and Pipedrive. Has anything changed since?', '2026-11-15T09:00:00Z', 'A');

  // the first prompt has the date, the date hint and an honest "nothing stored"
  const prompt = lastPrompt(seen[0]);
  assert.match(prompt, /<now>Sunday 15 November 2026/);
  assert.match(prompt, /"On Monday" -> Monday 9 November 2026/);
  assert.match(prompt, /No stored messages on Monday 9 November 2026/);

  // the second call has both search results, in order
  const results = seen[1].chat[seen[1].chat.length - 1].parts;
  assert.equal(results.length, 2);
  assert.equal(results[0].functionResponse.id, 'c0');
  assert.match(results[0].functionResponse.response.result, /\[s1\] HubSpot pricing page/);

  const done = events.find((e) => e.type === 'done');
  assert.deepEqual(done.sources.map((s: any) => s.id), [1, 2]);

  const saved = memory.sessionMessages('u1', 'A');
  assert.equal(saved.length, 2);
  assert.equal(saved[1].sources!.length, 2);
});

test('a later session finds the old answer and its sources by date', async () => {
  const { deps, seen } = fakeDeps([say('Still holds.')]);
  await ask(deps, 'What did I ask you on 15 November? Is your answer still correct?', '2026-11-20T09:00:00Z', 'B');
  const prompt = lastPrompt(seen[0]);
  assert.match(prompt, /Stored messages from Sunday 15 November 2026/);
  assert.match(prompt, /USER: On Monday we shortlisted HubSpot/);
  assert.match(prompt, /ASSISTANT: HubSpot is unchanged \[s1\]/);
  assert.match(prompt, /sources then: \[s1\] HubSpot pricing page \(example\.com, published 2026-11-12\)/);
});

test('source ids never repeat, and an old id can be cited again', async () => {
  const { deps } = fakeDeps([searches({ query: 'fresh query' }), say('New fact [s3]. Earlier fact [s1].')]);
  const events = await ask(deps, 'Check again please, since last time', '2026-11-21T09:00:00Z', 'C');
  const done = events.find((e) => e.type === 'done');
  assert.deepEqual(done.sources.map((s: any) => s.id).sort(), [1, 3]);
});

test('a new user with no history is told so (nothing is made up)', async () => {
  const { deps, seen } = fakeDeps([say('I have no record of that.')]);
  await ask(deps, 'What did I ask you on 3 November?', '2026-11-22T09:00:00Z', 'D', 'brand-new-user');
  const prompt = lastPrompt(seen[0]);
  assert.match(prompt, /No stored messages on Tuesday 3 November 2026/);
  assert.match(prompt, /no stored messages from any earlier session/);
});

test('a normal question skips old chats, and the model must answer after 2 search rounds', async () => {
  const { deps, seen } = fakeDeps([
    searches({ query: 'q0' }, { query: 'q1' }),
    searches({ query: 'r0' }, { query: 'r1' }),
    say('Done.'),
  ]);
  await ask(deps, 'Which CRM is cheapest?', '2026-11-23T09:00:00Z', 'E');
  assert.equal(seen.length, 3);
  assert.equal(seen[2].lastRound, true);
  assert.doesNotMatch(lastPrompt(seen[0]), /recalled_context/);
});

test('after a failed question, the history still alternates user/model', async () => {
  const broken = { async askModel(): Promise<any> { throw new Error('boom'); }, async search() { return { hits: [] }; } };
  await ask(broken, 'first question', '2026-11-24T09:00:00Z', 'G');
  const { deps, seen } = fakeDeps([say('ok')]);
  await ask(deps, 'second question', '2026-11-24T09:01:00Z', 'G');
  assert.equal(seen[0].chat.length, 1); // both user messages were joined into one
  assert.equal(seen[0].chat[0].role, 'user');
  assert.equal(seen[0].chat[0].parts.length, 2);
});

test('an API error becomes a friendly message', async () => {
  const limited = {
    async askModel(): Promise<any> {
      const error: any = new Error('RESOURCE_EXHAUSTED');
      error.status = 429;
      throw error;
    },
    async search() { return { hits: [] }; },
  };
  const events = await ask(limited, 'hello', '2026-11-25T09:00:00Z', 'F');
  const last = events[events.length - 1];
  assert.equal(last.type, 'error');
  assert.match(last.message, /rate limit or free-tier quota/);
});

test('"what did I ask earlier?" with no day or topic shows the most recent earlier chat', async () => {
  memory.saveMessage('u2', { session: 'old', role: 'user', text: 'Is Neon cheaper than Supabase?', time: '2026-11-20T08:00:00Z' });
  memory.saveMessage('u2', { session: 'old', role: 'assistant', text: 'Neon has a free tier.', time: '2026-11-20T08:00:05Z' });
  const { deps, seen } = fakeDeps([say('ok')]);
  await ask(deps, 'What did I ask you earlier?', '2026-11-20T10:00:00Z', 'new', 'u2');
  assert.match(lastPrompt(seen[0]), /Most recent earlier conversation/);
  assert.match(lastPrompt(seen[0]), /USER: Is Neon cheaper than Supabase/);
});
