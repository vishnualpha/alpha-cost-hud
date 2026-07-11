# Alpha Cost HUD

An always-on-top desktop widget that shows what your LLM usage actually costs —
your local coding agents, your providers, all in one place. Built with
[Tauri](https://tauri.app) (Rust + web), it's ~6 MB and sips memory, so you can
leave it running all day.

> Your keys and data never leave your device. It reads local logs and calls
> provider APIs directly from your machine — nothing is sent anywhere.

## What it shows

A compact carousel that auto-advances through:

- **Today / Week / Month** — total spend + tokens across every source you connect
- **By provider** — spend per provider (OpenAI, Anthropic, OpenRouter, …)
- **Top models** — your heaviest models, aggregated across all sources
- **Local coding agents** — **Claude Code** and **Codex** cost, read straight
  from disk (`~/.claude`, `~/.codex`). Zero setup, no API key. Because these are
  usually flat-fee subscriptions, the number is shown as *API-equivalent value*
  (what the tokens would cost at pay-as-you-go rates).
- **Savings** — what smarter routing could save

### Where the numbers come from

| Source | How | Needs |
|---|---|---|
| Claude Code | reads `~/.claude/projects/**/*.jsonl` token usage | nothing |
| Codex | reads `~/.codex/sessions/**/rollout-*.jsonl` | nothing |
| OpenRouter | `GET /api/v1/credits` | any API key |
| OpenAI | `GET /v1/organization/costs` | **admin** key (`sk-admin-…`) |
| Anthropic | `GET /v1/organizations/cost_report` | **admin** key (`sk-ant-admin-…`) |
| Alpha gateway | `GET /v1/metrics/fleet` | account login |

**Why some providers need an admin key:** a normal API key lets you *make* calls
but can't *read* your past spend — that's the provider's own limitation, not
ours. OpenAI and Anthropic only expose cost to an org admin key. The reliable,
zero-setup sources are your **local agents**, which log every request to disk.

## Privacy

- **API keys** are stored in your **OS keychain** (encrypted), never on disk in
  plaintext, never transmitted anywhere except directly to the provider you
  entered them for.
- **Local agent data** is read from files already on your machine and never
  leaves it.
- Non-secret settings (gateway URL, chosen workspace, preferences) live in a
  local config file.

This is open source specifically so you can verify all of the above.

## Install

Download the latest `.dmg` from
[Releases](https://github.com/vishnualpha/alpha-cost-hud/releases), drag the app
to Applications, and open it. The build is currently unsigned, so the first
launch needs **right-click → Open** to get past Gatekeeper.

## Build from source

Requires [Node](https://nodejs.org) and the
[Rust toolchain](https://rustup.rs) (Tauri prerequisites:
https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce a release build + installer
```

## About Alpha

Alpha ([thealpha.ai](https://thealpha.ai)) is an AI gateway that routes your LLM
traffic through one endpoint — turning every request into a **trace you own**
(the dataset behind evals, fine-tuning, and cheaper routing) while cutting cost
as a byproduct. This HUD works fully standalone; connecting Alpha adds realized
savings and a fleet view.

## License

[MIT](./LICENSE)
