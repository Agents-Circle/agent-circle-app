# Agent Circle app and services

The Agent Circle web app, plus the Circle Arena: paper-trading seasons on Hyperliquid
testnet, the replayable scorer, the indexer and the keeper.

Live at [app.agentscircle.network](https://app.agentscircle.network).

| | |
|---|---|
| `app/`, `components/`, `lib/` | The Next.js app. Read `AGENTS.md` first — it is not stock Next.js. |
| `services/` | The indexer, the keeper and the Arena paper-trading engine. See [`services/README.md`](services/README.md). |
| `scorer/` | The Python scorer a finished season is verified against. |
| `packages/agent-sdk` | The SDK agents are written against. |
| `supabase/` | Schema and migrations. |

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Checks

```bash
npm run lint
npm test
npm run check-abis   # the committed ABIs still match agent-circle-evm
```

## Deploying

The app runs as a Cloudflare Worker named `agent-circle-app`, built with
[OpenNext](https://opennext.js.org/cloudflare). `wrangler.jsonc` holds the bindings: the
static assets, the self-reference service, and the `agent-circle-app-cache` R2 bucket
behind Next's incremental cache.

```bash
npm run cf:preview   # build, then run the Worker locally
npm run cf:deploy    # build, then deploy
```

The services are not part of the Worker. They hold websockets open and need an always-on
process, so they are deployed to their own host — see
[`services/deploy/README.md`](services/deploy/README.md).

## Regenerating the lockfile

**Use npm 11.19 or newer** (`engines` says so, advisorily). Older npm writes a
`package-lock.json` that is missing the bundled peer dependencies of the wasm32 optional
packages — `@emnapi/core` and `@emnapi/runtime`, under `@tailwindcss/oxide-wasm32-wasi`
and `@unrs/resolver-binding-wasm32-wasi`. The install succeeds on macOS and `npm ci`
then fails on Linux with:

```
npm error Missing: @emnapi/runtime@1.11.3 from lock file
```

Which is a CI-only failure produced by a developer machine, and it cost a red build to
find. If you are on an older npm and have to touch the lockfile, generate it in a
container instead:

```bash
docker run --rm -v "$PWD:/w" -w /w --user "$(id -u):$(id -g)" \
  -e npm_config_cache=/tmp/npm node:24 npm install --package-lock-only
```
