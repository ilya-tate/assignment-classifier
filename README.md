# Assignment Planner · Sunhacks 2026

Shared Chrome/Edge Manifest V3 scaffold for Canvas assignment collection, Snowflake effort inference, and a popup showing deadlines and recommended start times. No dependencies or build step. Requires Node 22+.

## Run locally

1. Run `npm start` from the repository (mock inference is the default).
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose Load unpacked, and select the `extension/` folder.
3. Open the extension and click **Load demo**. It sends synthetic assignments to the local server and shows clearly labeled mock estimates.
4. Open your signed-in HTTPS Canvas tab, then click **Sync Canvas & estimate**. Keep the popup open while it runs; it shows a live line per course. This sends assignment titles, descriptions, points, submission types, and deadlines to the local API; Snowflake mode forwards relevant text to Snowflake. Up to 100 assignments are supported per sync.
5. Open http://localhost:8787 to see the last synced assignments as JSON (`course`, `title`, `description`, `dueDate`, `attachments`), grouped into `catchUp` and `upcoming`. It is held in memory only and cleared when the server restarts.
6. Click **Clear data** to remove cached assignments and saved documents. Reload the extension after code changes.

## What Sync includes

- **Courses:** only current ones. A course is skipped if it is not on your Canvas dashboard, Canvas marks it concluded, its course or term end date has passed, or its latest due date is more than about 6 months old. Courses with no dates at all are kept.
- **Assignments:** unsubmitted ones only (submitted, graded, pending review, and excused are skipped). Past-due work is kept for 14 days; anything older is skipped. Undated assignments are kept.
- **Popup sections:** **Catch Up** lists past-due work oldest first; **Upcoming** lists the rest soonest first, with undated work last. Start times subtract the estimate plus a 25% buffer from the deadline.
- **Status line:** after a sync it lists the courses kept and how many courses and assignments were skipped. Skipped course names are logged to the popup console (right-click the popup → Inspect).
- **Linked files:** not read by default. File handling is planned for the AI step.

## Settings

| Setting | File | Default | Effect |
| --- | --- | --- | --- |
| `OVERDUE_DAYS` | `extension/popup.js` | `14` | How many days past due an unsubmitted assignment stays in Catch Up. `0` drops all past-due work. |
| `READ_FILES` | `extension/popup.js` | `false` | When `true`, sync reads files linked from descriptions: text/code files (up to 100 KB, 5 per assignment, 8,000 characters) go to the model as `attachments`; documents (PDF, DOCX, PPTX, XLSX, DOC, PPT, RTF, ODT up to 25 MB) are saved once each in the extension's IndexedDB, never sent anywhere, and shown as download links on each card. Skipped files are logged to the popup console. |
| `STALE_MS` | `extension/canvas.js` | ~6 months | A course whose latest due date is older than this is treated as over. |

Reload the extension after changing any setting.

## Troubleshooting

- **"Cannot reach the local server" / errors on `chrome://extensions`:** the server is not running. Run `npm start` and keep that terminal open. Errors listed on the extensions page persist until you click **Clear all**.
- **Changes have no effect:** reload the extension on `chrome://extensions`, then refresh the Canvas tab.
- **Sync seems stuck:** the live progress list shows which course and assignment is being read. Sync fails with a message after 2 minutes without progress, and the list stays visible to show where it stopped.
- **Old courses still appear:** they are probably on your dashboard (favorited) with no end dates and recent activity. Unfavorite them in Canvas or report the course so detection can be tightened.
- **"Found N assignments; the server accepts at most 100":** lower `OVERDUE_DAYS`.

No install command is needed. `npm test` runs contract/API/provider tests and Canvas collector tests against a mocked Canvas (filtering, attachments, document dedupe). `npm run eval` runs synthetic effort fixtures and writes ignored `harness/results.json`. Fixture ranges are smoke checks, not measured student completion times or accuracy benchmarks.

If npm is unavailable, use `node --env-file-if-exists=.env server/index.js`, `node --test`, and `node --env-file-if-exists=.env harness/evaluate.js` directly.

## Enable Snowflake

Copy `.env.example` to `.env` (if you don't have one yet), fill in just `SNOWFLAKE_ACCOUNT_URL` and `SNOWFLAKE_TOKEN`, then restart `npm start`. Without `.env`, the server runs in mock mode. The token is a Snowflake Programmatic Access Token (PAT). Inference switches automatically from demo to Snowflake when credentials are supplied. The default model is `llama3.1-8b`; `SNOWFLAKE_MODEL` remains an optional override if your account restricts that model. Your account/token must have Cortex access; see the [Snowflake setup documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api). Live requests and evaluation in Snowflake mode incur model usage. Set `INFERENCE_PROVIDER=mock` when you want an offline demo or evaluation even with credentials configured. `.env` and its local variants are ignored; `.env.example` is tracked. Credentials stay on the server and must never enter the extension or git.

## Team entry points

| Area | Files |
| --- | --- |
| Canvas collector, course filtering, attachment reader | `extension/canvas.js` |
| Browser coordination | `extension/background.js` |
| Saved documents (IndexedDB) | `extension/files-db.js` |
| Assignment frontend, live progress, settings | `extension/popup.*` |
| Data validation and planning | `shared/contracts.js` |
| Local API and JSON view | `server/index.js` |
| Snowflake adapter and prompt | `server/inference.js`, `server/prompt.js` |
| Model evaluation | `harness/fixtures.json`, `harness/evaluate.js` |
| Shared agent instructions | `AGENTS.md` |

Read [architecture and contracts](docs/architecture.md) before changing interfaces. The model harness includes a versioned prompt, synthetic evaluation cases, mock/live providers, and shared instructions for coding agents. The current planner subtracts estimated active work plus 25% from the deadline; it does not resolve overlapping assignments or account for your schedule. Live Canvas and Snowflake integration must be verified with your own accounts.

For model costs and the proposed ±25% accuracy validation plan, see [model selection](docs/model-selection.md).
