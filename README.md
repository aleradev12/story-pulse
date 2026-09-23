# Story Pulse

**English** | [Русская версия](README.ru.md)

Story Pulse is a Telegram pre-MVP for a collaborative detective story. Players contribute ideas, ask questions about the published clues, and accuse a suspect. An OpenAI-compatible Sber AI API moderates and groups contributions, writes the next chapter, and produces the final reveal.

> This is an early prototype for controlled testing. It currently runs as one Node.js process, stores state in a local JSON file, and uses Telegram long polling.

## Core product loop

1. The admin opens a round with `/open`.
2. Players read the current chapter and send a free-text idea or choose a quick option. The bot evaluates it and returns a personal “shadow branch”; it does not promise the idea will enter canon.
3. Players can ask clue-based questions with `/ask` and review shared clues with `/clues`.
4. The admin closes the round with `/close`. The model groups accepted ideas, explains community influence, and generates the next chapter.
5. After the story's configured rounds, a separate model call locks a solution. Players submit a final accusation with `/accuse` and the admin publishes the reveal with `/finish`.

The current sample story is in [`story.json`](story.json). Prompt templates are kept separately in [`src/prompts.json`](src/prompts.json); request construction and canon serialization are in `src/prompts.js`.

## Requirements

- Node.js 20.6 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A numeric Telegram user ID for the admin
- Sber AI API credentials and endpoint issued for your team: API key, Base URL, and a model ID available from that endpoint's `GET /models`

Never commit `.env`, API keys, Telegram tokens, or `data/state.json`.

## Configure and run

```sh
npm install
cp .env.example .env
```

Fill in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=...
SBER_API_KEY=...
ADMIN_TELEGRAM_ID=...
SBER_BASE_URL=... # exact Base URL supplied by Sber500
SBER_MODEL=...    # model ID returned by GET /models
```

The application calls `{SBER_BASE_URL}/chat/completions` with a Bearer token and JSON response format. Set the base URL and model exactly as supplied/advertised by the service; they are not guessed or hard-coded.

```sh
npm run check
npm start
```

`npm start` uses Node's `--env-file=.env` support. Keep the environment file private. `AUTO_SCHEDULE` is disabled by default; use the admin commands for a manual test. Scheduling can be enabled with `AUTO_SCHEDULE=true`, `OPEN_HOUR`, `REMINDER_HOUR`, `CLOSE_HOUR`, and `TIME_ZONE` in `.env`.

## Telegram commands

### Players

- `/start` — join the test
- `/story` — show the current chapter and options
- Send ordinary text — submit an idea during an open round
- `/ask <question>` — ask about the investigation
- `/clues` — list published clues
- `/accuse <suspect> — <reason>` — submit a final accusation when enabled
- `/help` — show short help

### Admin

The ID configured as `ADMIN_TELEGRAM_ID` can use:

- `/open` and `/close` — open/close a round
- `/status` — inspect current participation counts and story state
- `/broadcast <text>` — message active participants
- `/finish` — publish the final reveal
- `/reset CONFIRM` — reset story progress while retaining participant records

## Architecture

```text
Telegram users
     │ Telegram Bot API (long polling)
     ▼
src/index.js ─────── src/prompts.js ─────── src/prompts.json
     │                         │
     │                         └── builds role messages from templates + current canon
     ├── src/llm.js ─────────── Sber OpenAI-compatible /chat/completions API
     ├── story.json ─────────── world, characters, initial chapter and clues
     └── data/state.json ────── participants, round state, contributions, clues and history
```

The app is a single-process bot. `src/store.js` loads the story and persists the complete state to `data/state.json` using a temporary file and atomic rename. The JSON store is suitable only for a small prototype; it is not a concurrent or horizontally scalable database. The LLM integration has bounded retries for network failures. Logs currently go to process stdout/stderr; durable structured logs, metrics, DAU tracking, and export are not implemented yet.

## Deployment

The bot uses Telegram long polling, so it does not require an inbound public HTTP endpoint or webhook. It must run continuously on an internet-connected host, such as a VPS or managed container platform, rather than a developer's localhost. Provide environment variables through the host's secret store, mount/persist `data/`, configure restart-on-failure, and restrict access to state and logs. Do not expose `.env` or `data/state.json` publicly.

This repository does not yet include a deployment manifest or configuration for a hosted environment. Before a public launch, add health monitoring, backups, durable storage, secret management, structured logs/metrics, rate limiting, and privacy/retention controls.

## Validation and scaling work

`npm run check` performs Node syntax checks. The repository does **not** yet contain a load-test report or evidence of 10 RPS, TPM/TPS, or stress testing. Those numbers must be measured against the issued Sber endpoint and the deployed service; do not infer them from local syntax checks.

A useful next scaling step is to record, at minimum, daily active users, interactions by type, LLM request latency/token usage/cost, and errors. For a minimal export, use timestamped JSON Lines or CSV with identifiers minimized and retention defined. Avoid logging raw user content or credentials by default.

### LLM cost per DAU

Estimate cost from real provider prices and measured usage rather than hard-coded assumptions:

```text
cost_per_DAU_per_day = Σ(model input tokens × input price + model output tokens × output price)
                        across that user's average daily requests
```

Measure prompt and completion tokens per product-loop action (idea moderation, question, round close, final reveal), then multiply by expected action frequency. Image generation is not currently implemented. Provider prices/model availability are supplied outside this repository and can change.

## Privacy and current limitations

- The state file contains Telegram IDs, names, contributions, and questions. Treat it as personal data; do not publish it.
- One story and one process; JSON-file persistence is not appropriate for high traffic or multiple replicas.
- Text-only interaction; no voice, image, or PDF features.
- Operational metrics, dashboards, load-test results, and automated deployment setup are not yet included.
- LLM moderation does not replace human oversight.

For the Russian documentation, see [README.ru.md](README.ru.md).
