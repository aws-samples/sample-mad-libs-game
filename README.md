# Madlibs Client

A web client for a live, multiplayer Madlibs game. Each player is assigned one blank
per round, submits a single word for it, and sees the finished story once the round
closes.

This repository contains **only the client**. It connects to an existing game server
over a small REST contract and holds no game state of its own.

```
 ┌──────────────────┐                ┌───────────────────────┐
 │ madlibs-client   │   /game/hello  │  game server          │
 │  browser         │───────────────▶│  rounds, players,     │
 │    ↓ /api/*      │   /game/submit │  submissions          │
 │  API server ─────┼───────────────▶│  shared display       │
 └──────────────────┘                └───────────────────────┘
```

## Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Running the app](#running-the-app)
- [Project layout](#project-layout)
- [Development](#development)
- [Security](#security)
- [License](#license)

## How it works

A round has two phases: `collecting`, while words are being submitted, and `results`,
when the completed story is revealed everywhere at once.

1. **Join.** The player enters a join code, a display name, and the game server
   address. The API server checks the address is a reachable game server and that it
   accepts the join code. It stores nothing.
2. **Play.** The browser polls once per second for the current round, the player's
   assigned blank, and game statistics.
3. **Submit.** One word per player per round. The first submission wins a blank, and a
   second attempt is rejected.
4. **Reveal.** When the round closes, the story comes back with every blank filled —
   including stand-ins for any blank nobody claimed.

The API server is a real server-side process, not a static host: it proxies the game
server and reports whether this client is running locally or deployed.

**It is stateless, on purpose.** The browser keeps the player's credentials — join
code, display name, player key, game server address — and sends them with every call,
so no request depends on state an earlier one left behind. The word history lives in
`localStorage` for the same reason. Nothing here needs a session store, and adding one
(a `Map`, an in-process cache) would break the app as soon as it runs on more than one
host or restarts.

## Prerequisites

- **Node.js 22** or later
- **pnpm 10** — this workspace is pnpm-only and will refuse `npm install`
- **The URL of a running game server.** This client neither includes nor mocks one.

## Configuration

Every variable is optional; the defaults are enough to run the app locally.

| Variable | Default | Description |
| --- | --- | --- |
| `GAME_SERVER_URL` | none | Game server address used to prefill the join form. No trailing slash. |
| `PORT` | `8090` API, `25232` web | Port for the service being started. |
| `BASE_PATH` | `/` | Base path the web client is served under. |
| `API_SERVER_URL` | `http://localhost:8090` | Where the web dev server proxies `/api`. |
| `AWS_REGION` | none | Region reported to the game server. Set automatically on AWS. |

```bash
cp .env.example .env
# GAME_SERVER_URL=https://example.cloudfront.net
```

`GAME_SERVER_URL` is a default, not a lock: it prefills the join form and can be
overridden in the UI without a restart. Leave it unset — or as the
`<PASTE_GAME_SERVER_URL_HERE>` placeholder — and the field simply starts empty.

Nothing contacts the game server until **Join** is pressed.

## Running the app

Two services behind one origin: the web client on `/` and the API server on `/api`.

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/madlibs-client run dev
```

## Project layout

```
artifacts/
  madlibs-client/          React + Vite + Tailwind browser client
    src/App.tsx            join screen, game screen, error screen
  api-server/              Express 5 API server
    src/routes/madlibs.ts  game-server proxy
    src/routes/health.ts   liveness probe
lib/
  api-spec/openapi.yaml    source of truth for the internal API contract
  api-client-react/        generated React Query hooks (orval)
  api-zod/                 generated Zod schemas, shared by client and server
```

## Development

```bash
pnpm typecheck      # tsc across every workspace project
pnpm build          # typecheck, then build all packages
```

The internal API between the browser and the API server is generated from
`lib/api-spec/openapi.yaml`. Change the spec, then regenerate:

```bash
pnpm --filter @workspace/api-spec run codegen
```

Conventions worth knowing before making changes:

- **Do not construct API payloads by hand.** Import the generated hooks from
  `@workspace/api-client-react` and the schemas from `@workspace/api-zod`.
- **Regenerate rather than edit** anything under a `generated/` directory.
- There is no database, and no server-side session. All game state belongs to the game
  server; anything per-player lives in the browser and travels with each request.
- `pnpm-workspace.yaml` enforces a minimum npm release age as a supply-chain
  safeguard. Leave it enabled.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
