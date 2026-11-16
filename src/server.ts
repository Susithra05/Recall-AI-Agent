import express from 'express';
import { fileURLToPath } from 'node:url';
import { runTurn } from './agent';
import type { AgentEvent } from './agent';
import { sessionMessages } from './memory';

// Load the keys from the .env file (if there is one)
try { process.loadEnvFile(); } catch { /* no .env file: use normal environment variables */ }

const missing = ['GEMINI_API_KEY', 'TAVILY_API_KEY'].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('Missing ' + missing.join(' and ') + '. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)))); // the web page

const textOrAnon = (value: unknown) => (typeof value === 'string' && value ? value : 'anon');

// The browser sends a message and gets the answer back piece by piece (server-sent events)
app.post('/api/chat', async (req, res) => {
  const { userId, sessionId, message, tz, now } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > 8000) {
    res.status(400).json({ error: 'message is required (max 8000 characters)' });
    return;
  }

  // For testing only: with ALLOW_NOW_OVERRIDE=1 a request can pretend it is another time
  let clock = new Date();
  if (process.env.ALLOW_NOW_OVERRIDE === '1' && typeof now === 'string' && !isNaN(Date.parse(now))) clock = new Date(now);

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });

  // If the browser disconnects, stop the work
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const send = (event: AgentEvent) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n'); };

  await runTurn({ userId: textOrAnon(userId), sessionId: textOrAnon(sessionId), text: message.trim(), tz, now: clock, emit: send, signal: controller.signal });
  res.end();
});

// Used by the page to show the chat again after a reload
app.get('/api/history', (req, res) => {
  const messages = sessionMessages(textOrAnon(req.query.userId), textOrAnon(req.query.sessionId), 100);
  res.json({ messages: messages.map((m) => ({ role: m.role, text: m.text, sources: m.sources })) });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log('Agent ready on http://localhost:' + port));
