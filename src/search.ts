// Web search using the Tavily API (https://tavily.com)

export interface SearchArgs { query: string; topic?: string; since?: string } // since = "2026-11-09": only newer results
export interface Hit { title: string; url: string; published?: string; snippet: string }
export interface SearchResult { hits: Hit[]; note?: string } // note = a warning for the model

// Remember results for 2 minutes so the same query is not searched twice
const cache = new Map<string, { time: number; result: SearchResult }>();

async function callTavily(body: any): Promise<any> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.TAVILY_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000), // give up after 10 seconds
  });
  if (!response.ok) throw Object.assign(new Error('Search failed with status ' + response.status), { status: response.status });
  return response.json();
}

// Try once more if the network failed or the server had a problem
async function callWithRetry(body: any): Promise<any> {
  try {
    return await callTavily(body);
  } catch (error: any) {
    if (error.status && error.status < 500 && error.status !== 429) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return callTavily(body);
  }
}

export async function search(args: SearchArgs): Promise<SearchResult> {
  // ignore a "since" that is not a real past date
  let since = args.since;
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Date.parse(since) > Date.now())) since = undefined;
  const topic = args.topic === 'news' ? 'news' : 'general';

  const key = JSON.stringify([args.query, topic, since]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < 2 * 60 * 1000) return cached.result;

  const body: any = { query: args.query.slice(0, 300), search_depth: 'basic', max_results: 6, include_answer: false, topic };
  if (topic === 'news') {
    // news search looks back a number of days, so work out how many days back "since" is
    body.days = since ? Math.ceil((Date.now() - Date.parse(since)) / 86400000) + 1 : 30;
  } else if (since) {
    body.start_date = since;
  }

  let data: any;
  let note: string | undefined;
  try {
    data = await callWithRetry(body);
  } catch (error: any) {
    if (!body.start_date || (error.status !== 400 && error.status !== 422)) throw error;
    // the date filter was not accepted: search without it and tell the model
    delete body.start_date;
    note = 'The date filter was not accepted, so these results are NOT filtered to after ' + since + '. Check each result date.';
    data = await callWithRetry(body);
  }

  const hits: Hit[] = [];
  for (const r of data.results || []) {
    if (!r.url || hits.some((h) => h.url === r.url)) continue;
    const time = Date.parse(r.published_date);
    const published = isNaN(time) ? undefined : new Date(time).toISOString().slice(0, 10);
    if (since && published && published < since) continue; // too old
    const snippet = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    hits.push({ title: String(r.title || r.url).slice(0, 160), url: r.url, published, snippet });
  }

  const result = { hits, note };
  cache.set(key, { time: Date.now(), result });
  return result;
}
