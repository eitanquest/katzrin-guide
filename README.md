# Katzrin Guide — bilingual relocation chatbot

A Hebrew/English chatbot that helps families and businesses decide to move to **Katzrin (קצרין)**, Golan Heights. It answers from a local knowledge base (`knowledge-base.md`) and is hardened so it **can't be abused for off-topic token usage**.

## Quick start

```bash
cd katzrin-chatbot
npm install
cp .env.example .env        # then paste your ANTHROPIC_API_KEY into .env
npm start                   # → http://localhost:3000
```

Open http://localhost:3000 and chat in Hebrew or English.

## How it works

- **Backend** (`server.js`, Node/Express) holds the API key — it's **never** exposed to the browser.
- The large knowledge base is loaded once into the system prompt with **prompt caching**, so repeat questions are ~10× cheaper on input tokens.
- **Frontend** (`public/`) is a static, RTL-aware chat UI.

## Anti-abuse / token-cost guardrails (defense in depth)

Layers run cheapest-first, so abuse is stopped before it spends answer-model tokens:

| Layer | What it does | Where |
|------|---------------|-------|
| Security headers + body cap | Helmet; JSON body limited to 16 KB | `server.js` |
| Per-IP rate limits | 20 requests / 5 min **and** 150 / day per IP | `RL_*` env vars |
| Global daily budget | Circuit breaker: total requests/day across everyone (default 3000) | `GLOBAL_DAILY_BUDGET` |
| Input cap | Messages over 1200 chars rejected | `MAX_INPUT_CHARS` |
| History cap | Only last 8 turns / 8000 chars sent → bounded tokens per request | `MAX_HISTORY_*` |
| **Topic gate** | A cheap **Haiku** classifier decides on-topic vs. not. Off-topic messages get a canned refusal and **never reach the expensive answer model.** | `isOnTopic()` |
| Strict system prompt | Scope-locked + prompt-injection resistant ("ignore previous instructions", role-play, hypotheticals all refused) | `SYSTEM_INSTRUCTIONS` |
| Output cap | Answers limited to 1024 tokens | `MAX_OUTPUT_TOKENS` |

Result: a user trying to use it as a free general-purpose LLM (coding, essays, other cities) is stopped at the Haiku gate for a tiny fraction of a cent, and the per-IP + global limits cap total spend regardless.

## Cost notes

- Default answer model is `claude-opus-4-8` (highest quality). For a public bot, set `ANSWER_MODEL=claude-sonnet-4-6` (or `claude-haiku-4-5`) in `.env` to cut cost — the knowledge base is small enough that Sonnet/Haiku answer it well.
- Prompt caching means the ~42 KB knowledge base is billed at full price only on the first request in each ~5-minute window, then at ~10% on cache reads.

## Updating the knowledge base

Edit `knowledge-base.md` (or repoint `KB_PATH`) and restart. The bot only states facts from this file — keep it current.

## Deploying

Any Node host works (Railway, Render, Fly, a VPS). Set `ANTHROPIC_API_KEY` (and any overrides) as environment variables, run `npm start`. `app.set("trust proxy", 1)` is already set for correct client IPs behind a proxy. Put it behind HTTPS.
