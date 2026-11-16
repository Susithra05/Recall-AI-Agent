# Design

**Main idea.** The example questions are all about *time*: "since Monday", "what did I ask on 3 November", "is it still correct today". Searching the web is the easy part. What matters is knowing today's date, knowing what was said before, and being honest when something is missing. So the design is built around dates and memory, with one search tool inside it.

## How it works

Each question has three steps. Only step 2 uses the AI model (Gemini).

1. **Prepare context in plain code** (`dates.ts`, `memory.ts`). The prompt gets today's date in the user's time zone. The `chrono-node` library turns "Monday", "last Tuesday" or "3 November" into real dates. Every message is saved to a file per user, together with the web pages each answer used. If the user talks about the past, code finds the messages from those days and earlier questions with matching keywords. If nothing is saved for a day, the prompt says "No stored messages on Tuesday 3 November", so the model does not invent anything.
2. **One model, one tool** (`agent.ts`). The tool is `web_search(query, topic, since)`. The model can ask for many searches at the same time, one per product. It gets at most two rounds of searching, then must answer. The limit is 14 searches per question. The answer streams to the browser while it is written.
3. **Save.** Every search result gets an id like `[s12]`, unique for the user. The model cites these ids in the answer and the page turns them into links. The cited pages are saved with the answer. This is the baseline for "has it changed?": what I said, when, and from which pages.

The system prompt contains the rules: when to search, how to search (separate queries, `since` for news, a separate query for the current price page, because an old unchanged page never matches a date filter), and how to check for changes (compare with the baseline, then say Changed / No change found / Can't tell for each item, and "found nothing dated after D", never "nothing changed").

## Why this way

- **Memory is not a tool.** The task allows one tool. A memory tool would also cost an extra model call each time. Looking things up in code is free and easy to test.
- **Dates are done by a library, not the model.** Models often get weekdays wrong.
- **Speed:** streaming with a live status line, searches in parallel, a fixed system prompt that Gemini can cache, basic search depth with 6 results, a 2-minute search cache, and no extra planner or checker model calls. Gemini retries (429, server errors) happen only before any text was shown.
- **Correctness:** every number or claim must come from a search result or saved context and be cited. Search results are treated as untrusted text.
- **Testable without keys:** the model and the search are passed in, so the tests (`npm test`) use fakes for both.

## Things I considered and did not do

- **Gemini's built-in Google Search.** It hides the search step: no `since` filter and no citation ids to build the baseline on.
- **An agent framework (LangChain etc.).** The loop is about 40 lines, and I wanted to control streaming, limits and cancelling.
- **A second "checker" model.** It adds seconds to each answer. The prompt rules get most of the benefit.
- **Embeddings for memory.** Date plus keyword is more predictable here, and embeddings cannot understand "Monday".
- **Summarising old chats with the model.** Summaries lose exactly the details (prices, plan names) we need to compare.

## Limits

Search results are short snippets, so a price inside a table can be missed. One browser is one anonymous user, with no login. "Last Tuesday" said on a Wednesday is unclear, so the agent says which date it assumed. If Tavily rejects the date filter, the search runs without it and the model is told.

## With another week

1. An evaluation script: replay example questions with a fake clock (`ALLOW_NOW_OVERRIDE=1`) and saved history, and check dates, citations and verdicts.
2. Save structured facts (`product, plan, price, date`) so "changed?" compares values instead of text.
3. Fetch the vendor's pricing page when snippets do not show the price.
4. A database (SQLite) instead of files, summaries for long chats, and logins.
5. A small fast model for simple messages, and starting obvious searches earlier.
