import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import type { Content, Part } from '@google/genai';
import * as memory from './memory';
import { search } from './search';
import type { SearchArgs, SearchResult } from './search';
import { SYSTEM, SEARCH_TOOL, turnPrompt } from './prompt';
import { findDates, checkTz, stamp } from './dates';

// Messages we send to the browser while the answer is being made
export type AgentEvent =
  | { type: 'status'; text: string } // "Searching: ..."
  | { type: 'source'; source: memory.Source } // a page that was found
  | { type: 'text'; text: string } // a piece of the answer
  | { type: 'done'; sources: memory.Source[] } // finished, with the pages the answer cites
  | { type: 'error'; message: string };

const MAX_SEARCH_ROUNDS = 2; // the model may search in 2 rounds, then it must answer
const MAX_SEARCHES = 14; // searches allowed for one question

// ---------- Talking to Gemini ----------

export interface ToolCall { id?: string; name: string; args: Record<string, unknown> } // a search the model wants
export interface ModelReply {
  calls: ToolCall[]; // searches the model asked for (empty if it just answered)
  content: Content; // the model message exactly as received (Gemini needs it sent back)
  finishReason?: string;
}

let gemini: GoogleGenAI | undefined;

// Sends the chat to Gemini. Answer text goes to onText while it streams in.
export async function askGemini(contents: Content[], forceAnswer: boolean, onText: (text: string) => void, signal: AbortSignal): Promise<ModelReply> {
  if (!gemini) gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const mode = forceAnswer ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO; // NONE = may not search
  const config: any = {
    systemInstruction: SYSTEM,
    tools: [{ functionDeclarations: [SEARCH_TOOL] }],
    toolConfig: { functionCallingConfig: { mode } },
    maxOutputTokens: 3000,
    abortSignal: signal,
  };
  const level = (process.env.THINKING_LEVEL || '').toUpperCase(); // optional: LOW makes answers faster
  if (level) config.thinkingConfig = { thinkingLevel: level };

  // Try up to 3 times, because free plans often answer 429 (too many requests)
  for (let attempt = 1; ; attempt++) {
    let textSent = false;
    try {
      const stream = await gemini.models.generateContentStream({ model: process.env.MODEL || 'gemini-flash-latest', contents, config });
      const parts: Part[] = [];
      const calls: ToolCall[] = [];
      let finishReason: string | undefined;
      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = String(candidate.finishReason);
        for (const part of candidate?.content?.parts || []) {
          parts.push(part);
          if (part.functionCall?.name) {
            calls.push({ id: part.functionCall.id, name: part.functionCall.name, args: part.functionCall.args || {} });
          } else if (part.text && !part.thought) {
            textSent = true;
            onText(part.text);
          }
        }
      }
      return { calls, content: { role: 'model', parts }, finishReason };
    } catch (error: any) {
      const worthRetrying = !error.status || error.status === 429 || error.status >= 500;
      if (!worthRetrying || textSent || signal.aborted || attempt === 3) throw error; // text already shown would be repeated
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

// ---------- One question from the user ----------

// The two outside things the agent uses. The tests replace them with fakes.
export interface Deps {
  askModel: typeof askGemini;
  search: (args: SearchArgs) => Promise<SearchResult>;
}
const realDeps: Deps = { askModel: askGemini, search };

export interface TurnInput {
  userId: string;
  sessionId: string;
  text: string;
  tz?: string;
  now: Date;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
}

// Add text to the chat. Same role as the last message? Join them, because Gemini wants user/model turns to alternate.
function addToChat(chat: Content[], role: string, text: string) {
  const last = chat[chat.length - 1];
  if (last && last.role === role) last.parts!.push({ text });
  else chat.push({ role, parts: [{ text }] });
}

function friendlyError(error: any): string {
  const status = error.status;
  const message: string = error.message || '';
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(message))) return 'The Gemini API key was rejected. Check GEMINI_API_KEY in .env.';
  if (status === 404) return 'Model not found. Check MODEL in .env.';
  if (status === 429) return 'Gemini rate limit or free-tier quota reached. Wait a minute and try again.';
  if (status === 500 || status === 503) return 'The model is overloaded. Try again in a moment.';
  if (!status && /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) return 'Could not reach the Gemini API. Check your network connection.';
  return (message || 'Something went wrong.').slice(0, 200);
}

export async function runTurn(input: TurnInput, deps: Deps = realDeps): Promise<void> {
  const { userId, sessionId, emit, signal } = input;
  const tz = checkTz(input.tz);

  try {
    // ----- Step 1: get the context ready (no AI used here) -----
    const dates = findDates(input.text, input.now, tz); // "Monday" -> a real date
    const recalled = memory.recall(userId, input.text, dates, sessionId, tz); // old chats
    const history = memory.sessionMessages(userId, sessionId);
    let nextSourceId = memory.nextSourceId(userId);
    memory.saveMessage(userId, { session: sessionId, role: 'user', text: input.text, time: input.now.toISOString() });

    // The chat: earlier messages of this session, then the new message with its extra info
    const chat: Content[] = [];
    for (const m of history) {
      if (m.role === 'user') {
        addToChat(chat, 'user', '<sent>' + stamp(m.time, tz) + '</sent>\n' + m.text);
      } else {
        const used = m.sources && m.sources.length > 0 ? '\n<sources_used>' + memory.sourceList(m.sources) + '</sources_used>' : '';
        addToChat(chat, 'model', m.text + used);
      }
    }
    addToChat(chat, 'user', turnPrompt(input.text, input.now, tz, dates, recalled));

    // ----- Step 2: let the model search and answer -----
    const foundSources = new Map<number, memory.Source>();
    let searchCount = 0;
    let answer = '';
    let finishReason: string | undefined;

    // Runs one search the model asked for and returns the result in Gemini's format
    async function runSearch(call: ToolCall): Promise<Part> {
      const reply = (ok: boolean, text: string): Part => ({ functionResponse: { id: call.id, name: call.name, response: ok ? { result: text } : { error: text } } });
      const query = typeof call.args.query === 'string' ? call.args.query.trim() : '';
      if (call.name !== 'web_search' || !query) return reply(false, 'Unknown tool or missing query.');
      if (++searchCount > MAX_SEARCHES) return reply(false, 'No searches left for this question. Answer with what you have.');

      const args: SearchArgs = {
        query,
        topic: typeof call.args.topic === 'string' ? call.args.topic : undefined,
        since: typeof call.args.since === 'string' ? call.args.since : undefined,
      };
      emit({ type: 'status', text: 'Searching: ' + query + (args.since ? ' (since ' + args.since + ')' : '') });

      try {
        const result = await deps.search(args);
        let text = 'Results for "' + query + '"' + (args.since ? ' since ' + args.since : '');
        if (result.note) text += '\nNOTE: ' + result.note;
        if (result.hits.length === 0) text += '\n\nNo results. Try other keywords, or drop the "since" filter.';
        for (const hit of result.hits) {
          const source: memory.Source = { id: nextSourceId++, title: hit.title, url: hit.url, published: hit.published };
          foundSources.set(source.id, source);
          emit({ type: 'source', source });
          text += `\n\n[s${source.id}] ${hit.title} | ${memory.hostOf(hit.url)} | ${hit.published ? 'published ' + hit.published : 'date unknown'}\n${hit.snippet}`;
        }
        return reply(true, text);
      } catch (error: any) {
        if (signal.aborted) throw error;
        return reply(false, 'Search failed: ' + error.message + '. Tell the user if this affects the answer.');
      }
    }

    for (let round = 0; round <= MAX_SEARCH_ROUNDS; round++) {
      const lastRound = round === MAX_SEARCH_ROUNDS; // no searching on the last round
      emit({ type: 'status', text: round === 0 ? 'Thinking' : 'Reading results' });
      const reply = await deps.askModel(chat, lastRound, (piece) => { answer += piece; emit({ type: 'text', text: piece }); }, signal);
      finishReason = reply.finishReason;
      if (reply.calls.length === 0 || lastRound) break; // the model gave its answer

      chat.push(reply.content); // the model's search requests
      chat.push({ role: 'user', parts: await Promise.all(reply.calls.map(runSearch)) }); // all searches at the same time
    }

    // ----- Step 3: save the answer with the pages it used -----
    answer = answer.trim();
    if (!answer) throw new Error('The model returned no answer' + (finishReason ? ' (' + finishReason + ')' : '') + '. Try rephrasing.');

    // The answer cites pages like [s12]. Find those pages (they can be from an older chat too).
    const cited: memory.Source[] = [];
    for (const match of answer.matchAll(/\[s(\d+)\]/g)) {
      const id = Number(match[1]);
      const source = foundSources.get(id) || memory.findSource(userId, id);
      if (source && !cited.includes(source)) cited.push(source);
    }

    // These pages are what we compare against if the user later asks "is this still true?"
    const toSave = cited.length > 0 ? cited : [...foundSources.values()].slice(0, 6);
    memory.saveMessage(userId, { session: sessionId, role: 'assistant', text: answer, time: input.now.toISOString(), sources: toSave });
    emit({ type: 'done', sources: cited });
  } catch (error: any) {
    if (!signal.aborted) emit({ type: 'error', message: friendlyError(error) }); // if aborted, the user left
  }
}
