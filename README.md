# Assignment Planner · Sunhacks 2026

Shared Chrome/Edge Manifest V3 scaffold for Canvas assignment collection, Snowflake effort inference, and a popup showing deadlines and recommended start times. No dependencies or build step. Requires Node 22+.

## Run locally

1. Run `npm start` from the repository (mock inference is the default).
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose Load unpacked, and select the `extension/` folder.
3. Open the extension and click **Load demo**. It sends synthetic assignments to the local server and shows clearly labeled mock estimates.
4. Open your signed-in HTTPS Canvas tab, then click **Sync Canvas & estimate**. This sends assignment titles, descriptions, points, submission types, and deadlines to the local API; Snowflake mode forwards relevant text to Snowflake. Up to 100 pending assignments are supported per request.
5. Click **Clear data** to remove cached assignments. Reload the extension after code changes.

No install command is needed. `npm test` runs contract/API/provider tests. `npm run eval` runs synthetic effort fixtures and writes ignored `harness/results.json`. Fixture ranges are smoke checks, not measured student completion times or accuracy benchmarks.

If npm is unavailable, use `node --env-file-if-exists=.env server/index.js`, `node --test`, and `node --env-file-if-exists=.env harness/evaluate.js` directly.

## Enable Snowflake

Fill in just `SNOWFLAKE_ACCOUNT_URL` and `SNOWFLAKE_TOKEN` in `.env`, then restart `npm start`. A local `.env` has been prepared in this workspace; teammates cloning the repository should first copy `.env.example` to `.env`. The token is a Snowflake Programmatic Access Token (PAT). Inference switches automatically from demo to Snowflake when credentials are supplied. The default model is `snowflake-llama-3.3-70b`; `SNOWFLAKE_MODEL` remains an optional override if your account restricts that model. Your account/token must have Cortex access; see the [Snowflake setup documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api). Live requests and evaluation in Snowflake mode incur model usage. Set `INFERENCE_PROVIDER=mock` when you want an offline demo or evaluation even with credentials configured. `.env` and its local variants are ignored; `.env.example` is tracked. Credentials stay on the server and must never enter the extension or git.

## Team entry points

| Area | Files |
| --- | --- |
| Canvas collector | `extension/canvas.js` |
| Browser coordination | `extension/background.js` |
| Assignment frontend | `extension/popup.*` |
| Data validation and planning | `shared/contracts.js` |
| Snowflake adapter and prompt | `server/inference.js`, `server/prompt.js` |
| Model evaluation | `harness/fixtures.json`, `harness/evaluate.js` |
| Shared agent instructions | `AGENTS.md` |

Read [architecture and contracts](docs/architecture.md) before changing interfaces. The model harness includes a versioned prompt, synthetic evaluation cases, mock/live providers, and shared instructions for coding agents. The current planner subtracts estimated active work plus 25% from the deadline; it does not resolve overlapping assignments or account for your schedule. Live Canvas and Snowflake integration must be verified with your own accounts.
