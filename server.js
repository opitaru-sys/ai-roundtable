require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ─── Agent definitions ────────────────────────────────────────────────────────

const AGENTS = {
  claudeAnalyst: {
    id: 'claude-analyst',
    name: 'Claude Analyst',
    model: 'claude',
    persona: `You are Claude Analyst. You think in frameworks and data. When given a question, identify the core variables, name the tradeoffs clearly, and recommend a direction. Be decisive — hedging is not analysis. 3-5 sentences max.`
  },
  claudeChallenger: {
    id: 'claude-challenger',
    name: 'Claude Challenger',
    model: 'claude',
    persona: `You are Claude Challenger. Your job is to stress-test every idea on the table. Find the assumption nobody questioned, the risk nobody priced in, the simpler alternative nobody considered. Don't be contrarian for its own sake — be useful. 3-5 sentences max.`
  },
  gamingStrategist: {
    id: 'gaming-strategist',
    name: 'Gaming Strategist',
    model: 'claude',
    persona: `You are Gaming Strategist, a specialist in the gaming and esports industry, in-game advertising, creator ecosystems, and gamer audience behavior. You evaluate every question through the lens of: how does this actually play out in the gaming world? Reference real platform dynamics, player psychology, and brand-to-gamer trust when relevant. You work at the intersection of insights and go-to-market strategy. 3-5 sentences max.`
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    model: 'gemini',
    persona: `You are Gemini. You're the outside perspective in this room — bring information, analogies, or angles from outside the gaming/advertising bubble when useful. Agree or push back on the others explicitly by name. 3-5 sentences max.`
  }
};

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(persona, userMessage) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: persona,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  const data = await resp.json();
  if (!data.content) throw new Error(data.error?.message || 'Claude API error');
  return data.content.map(b => b.text || '').join('');
}

// ─── Gemini API call ──────────────────────────────────────────────────────────

async function callGemini(persona, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const MAX_RETRIES = 4;
  let delay = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: persona }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }]
      })
    });

    if (resp.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error('Gemini rate limit exceeded — please wait a moment and try again');
      console.warn(`[Gemini] 429 rate limit — retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(delay);
      delay *= 2;
      continue;
    }

    const data = await resp.json();
    if (!data.candidates) throw new Error(data.error?.message || 'Gemini API error');
    return data.candidates[0].content.parts.map(p => p.text || '').join('');
  }
}

// ─── Route: single agent turn ─────────────────────────────────────────────────

app.post('/api/turn', async (req, res) => {
  const { agentId, topic, history } = req.body;

  const agent = Object.values(AGENTS).find(a => a.id === agentId);
  if (!agent) return res.status(400).json({ error: 'Unknown agent' });

  const isFirstTurn = history.length === 0 || history[history.length - 1]?.agent === 'User';
  if (isFirstTurn) {
    const cleanTopic = topic.replace(/\n/g, ' '); // Keep log on a single line
    const label = history.length === 0 ? '🚀 NEW DEBATE' : '➡️ FOLLOW-UP';
    console.log(`[${new Date().toLocaleTimeString()}] ${label}: "${cleanTopic}"`);
  }

  const contextMsg = history.length === 0
    ? `The topic is: "${topic}"\n\nGive your opening perspective.`
    : `The topic is: "${topic}"\n\nDebate so far:\n\n${history.map(h => `${h.agent}: ${h.text}`).join('\n\n')}\n\nNow give your response. Build on or challenge what others said.`;

  try {
    let reply;
    if (agent.model === 'gemini') {
      reply = await callGemini(agent.persona, contextMsg);
    } else {
      reply = await callClaude(agent.persona, contextMsg);
    }
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: synthesis ─────────────────────────────────────────────────────────

app.post('/api/synthesize', async (req, res) => {
  const { topic, history } = req.body;

  const prompt = `You are a neutral synthesis engine. Below is a multi-agent debate on the topic: "${topic}"

${history.map(h => `${h.agent}: ${h.text}`).join('\n\n')}

Write a concise synthesis (4-6 sentences) that captures:
1. Where the agents agreed
2. Where they disagreed and why
3. The most defensible conclusion overall`;

  try {
    const synthesis = await callClaude(
      'You are a neutral synthesis engine. Be concise, balanced, and decisive.',
      prompt
    );
    res.json({ synthesis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: summarize a completed round ───────────────────────────────────────

app.post('/api/summarize', async (req, res) => {
  const { topic, roundNumber, messages } = req.body;

  const prompt = `You are a debate summarizer. Compress the following Round ${roundNumber} exchanges on the topic "${topic}" into 3-5 tight bullet points that capture each agent's core position and any key disagreements. Be terse — this summary replaces the full transcript for future rounds.

${messages.map(m => `${m.agent}: ${m.text}`).join('\n\n')}`;

  try {
    const summary = await callClaude(
      'You are a concise debate summarizer. Output only bullet points, no preamble.',
      prompt
    );
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Future: Google OAuth routes (placeholder) ────────────────────────────────
// app.get('/auth/google', ...)
// app.get('/auth/google/callback', ...)
// app.get('/api/drive/search', ...)
// app.get('/api/notebooklm/query', ...)

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nAI Roundtable running at http://localhost:${PORT}\n`);
});
