# Can Plan · Sunhacks 2026

Shared Chrome/Edge Manifest V3 scaffold for Canvas assignment collection, Snowflake effort inference, and a full-page planner showing deadlines and recommended start times. No dependencies or build step. Requires Node 22+.

## Run locally

1. Run `npm start` from the repository (mock inference is the default).
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose Load unpacked, and select the `extension/` folder.
3. Click the Can Plan toolbar icon. The planner opens as a full browser tab (clicking the icon again reuses that tab; the extension files keep the `popup.*` names). To try it without Canvas, turn on **Developer mode** in **Advanced options** and click **Load demo** in the dev toolbar. It sends 15 synthetic assignments across 6 courses (`extension/demo-data.js`, dates relative to now) to the local server and shows clearly labeled mock estimates. The set includes past-due work inside and beyond the default 14-day Catch Up window, work due within hours and more than 30 days out, an undated assignment, and sparse descriptions, so you can try the assignment range controls.
4. On your signed-in HTTPS Canvas tab, click the toolbar icon. The icon is greyed out on other sites; it lights up on Canvas pages (hosts containing "canvas", `*.instructure.com`, your saved Canvas address, and the mock Canvas). The planner opens (or comes to the front) and syncs automatically; a progress bar in the header shows what it is doing, and the header shows when it last synced. Afterwards the button reads **Resync**; clicking the icon on Canvas again also re-syncs. After the first sync the extension remembers your Canvas address, so **Sync** also works from anywhere: it uses an open Canvas tab, or opens Canvas in a background tab, reads it, and closes it. The first time it needs a tab you didn't click, Chrome asks to allow access to your Canvas site (once). If you are signed out, that tab is brought to the front so you can sign in.
5. Open http://localhost:8787 to see the last synced assignments as JSON (`course`, `title`, `description`, `dueDate`, `attachments`), grouped into `catchUp` and `upcoming`. It is held in memory only and cleared when the server restarts.
6. **Clear data** (dev toolbar) removes cached assignments and saved documents. Reload the extension after code changes.

## End-to-end demo with mock Canvas

To try a real Sync without a Canvas account, run a mock Canvas that serves the same API endpoints the collector scrapes:

1. In a second terminal, run `npm run mock-canvas` (port 8790; `MOCK_CANVAS_PORT` changes it). Keep `npm start` running too.
2. Open http://localhost:8790. Opening the page signs you in as a demo student.
3. Click the toolbar icon from that tab, then click **Sync Canvas & estimate** in the planner tab.

The mock Canvas (`harness/mock-canvas.js`) has 10 courses. Six are current and hold the Load demo assignments plus submitted, graded, pending-review and excused work that should be skipped. Four should be skipped entirely: one past its term end, one concluded, one not on the dashboard, and one stale. It mimics Canvas's session cookie, `while(1);` JSON prefix, Link-header pagination, submissions, dashboard cards, and file endpoints (two assignments link files for `READ_FILES` mode). **Capstone 1** mimics a heavy real capstone: over 200 old graded notes (3 pages if listed unfiltered), long HTML instructions, and large rubrics, with an added 1.2 s per request. `MOCK_CANVAS_DELAY_MS` (default 150) and `MOCK_CANVAS_SLOW_MS` (default 1200) adjust the latency. Use **Sign out** on the mock page to see the signed-out error. The extension accepts plain `http` only for `localhost` and `127.0.0.1`; real Canvas must be HTTPS.

## What Sync includes

- **Courses:** only current ones. A course is skipped if it is not on your Canvas dashboard, Canvas marks it concluded, its course or term end date has passed, or its latest due date is more than about 6 months old. Courses with no dates at all are kept.
- **Requests:** for each current course, Sync asks Canvas only for open work, using three parallel requests (`bucket=future`, `overdue`, `undated`; no `overdue` when Catch Up is off). Finished past assignments are never downloaded, which keeps courses with long histories fast. Rubrics are still included.
- **Assignments:** unsubmitted ones only (submitted, graded, pending review, and excused are skipped), within the date range set in **Advanced options**:
  - **Date range:** defaults to the current half of the year (January–May or June–December); switch to custom dates if needed.
  - **Late assignments** (past due, not submitted) are on by default and shown under Catch Up; they count from the start of the range.
  - Assignments with no due date are shown by default; 0-point (optional or ungraded) work can be hidden; individual courses can be hidden after a sync.
  - Settings are remembered (Clear data keeps them). Narrowing filters the list immediately; widening the range or turning late work on needs a new Sync.
- **Priority flags:** late assignments get a red **Late** flag; assignments due today or tomorrow get an amber **Due soon** flag (Advanced options → Priority: today, today or tomorrow, within 3 days, or off). Counts appear above the list.
- **Week view** (default): seven day columns; each assignment is a bar showing course and title, spanning the days to work on it and ending on its due day. Days needed = estimate plus 25% at the daily pace set in Advanced options (default 2 hours per assignment per day). Late work starts today; red and amber bars mark late and due-soon work. Click a bar for details (days only, no times). Arrows move between weeks. Assignments with no due date appear only in List view. On narrow screens the week turns sideways (days as rows). **List view** shows the cards.
- **Cards:** click a card to expand it for start-by, estimate, points, submission type, the full description, and the estimate's reasoning. Expand all / Collapse all are above the list.
- **Developer mode** (Advanced options): shows a dev toolbar with Load demo, Clear data, server status, a link to the synced JSON, the latest sync report path, a switch to read linked files during sync, and the detailed sync log (per-course progress and skip counts). Outside dev mode the header shows only a progress bar with a one-word label.
- **Layout:** works from phone width up; on narrow or portrait screens the header and tabs stay pinned while the list scrolls.
- **Planner sections:** **Catch Up** lists past-due work oldest first; **Upcoming** lists the rest soonest first, with undated work last. Start times subtract the estimate plus a 25% buffer from the deadline.
- **Status line:** after a sync it lists the courses kept and how many courses and assignments were skipped. Skipped course names are logged to the planner tab's console (F12 or right-click → Inspect).
- **Linked files:** not read by default. File handling is planned for the AI step.

## Settings

Most options live in the planner's Advanced options tab (see above). These are the remaining switches:

| Setting | File | Default | Effect |
| --- | --- | --- | --- |
| Read linked files | Dev toolbar | off | When on, sync reads files linked from descriptions: text/code files (up to 100 KB, 5 per assignment, 8,000 characters) go to the model as `attachments`; documents (PDF, DOCX, PPTX, XLSX, DOC, PPT, RTF, ODT up to 25 MB) are saved once each in the extension's IndexedDB, never sent anywhere, and shown as download links on each card. Skipped files are logged to the popup console. |
| `STALE_MS` | `extension/canvas.js` | ~6 months | A course whose latest due date is older than this is treated as over. |

Reload the extension after changing any setting.

## Troubleshooting

- **"Cannot reach the local server" / errors on `chrome://extensions`:** the server is not running. Run `npm start` and keep that terminal open. Errors listed on the extensions page persist until you click **Clear all**.
- **Changes have no effect:** reload the extension on `chrome://extensions`, then refresh the Canvas tab and click the toolbar icon again.
- **"Click the Can Plan icon while on your Canvas page once" / "Allow access to …":** the extension doesn't know your Canvas address yet, or Chrome's access prompt was declined. Click the icon on a Canvas tab, or enter the address under Advanced options → Canvas, then Sync and allow access when asked.
- **Finding bottlenecks:** every sync, including failed or stalled ones, writes a report to `sync-logs/sync-<time>.json` (gitignored; the path is shown in the status line). It contains each phase's duration (reading Canvas, server check, estimating), per-course timing (pages of assignments, time to list them, total), the 15 slowest Canvas API requests, server-side estimate timing (count, average and slowest per assignment), and a timestamped timeline of the progress lines. Reports stay on your machine: they include course names, counts, and the progress lines (which name assignments), but no descriptions or credentials. Set `SYNC_LOG_DIR` to write elsewhere.
- **Sync seems stuck:** the live progress list shows which course and assignment is being read. Sync fails with a message after 2 minutes without progress, and the list stays visible to show where it stopped.
- **Old courses still appear:** they are probably on your dashboard (favorited) with no end dates and recent activity. Unfavorite them in Canvas or report the course so detection can be tightened.
- **"Found N assignments; the server accepts at most 100":** narrow the date range in Advanced options (custom dates, or turn off late assignments) and sync again.

No install command is needed. `npm test` runs contract/API/provider tests, Canvas collector tests against a mocked Canvas (filtering, attachments, document dedupe), end-to-end collector runs against the mock Canvas server over HTTP, and demo data checks. `npm run eval` runs synthetic effort fixtures and writes ignored `harness/results.json`. Fixture ranges are smoke checks, not measured student completion times or accuracy benchmarks.

If npm is unavailable, use `node --env-file-if-exists=.env server/index.js`, `node --test`, and `node --env-file-if-exists=.env harness/evaluate.js` directly.

## Enable Snowflake

Copy `.env.example` to `.env` (if you don't have one yet), fill in just `SNOWFLAKE_ACCOUNT_URL` and `SNOWFLAKE_TOKEN`, then restart `npm start`. Without `.env`, the server runs in mock mode. The token is a Snowflake Programmatic Access Token (PAT). Inference switches automatically from demo to Snowflake when credentials are supplied. The default model is `llama3.1-8b`; `SNOWFLAKE_MODEL` remains an optional override if your account restricts that model. Your account/token must have Cortex access; see the [Snowflake setup documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api). Live requests and evaluation in Snowflake mode incur model usage. Set `INFERENCE_PROVIDER=mock` when you want an offline demo or evaluation even with credentials configured. `.env` and its local variants are ignored; `.env.example` is tracked. Credentials stay on the server and must never enter the extension or git.

## Team entry points

| Area | Files |
| --- | --- |
| Canvas collector, course filtering, attachment reader | `extension/canvas.js` |
| Browser coordination | `extension/background.js` |
| Saved documents (IndexedDB) | `extension/files-db.js` |
| Planner page (full tab), live progress, settings | `extension/popup.*` |
| Data validation and planning | `shared/contracts.js` |
| Local API and JSON view | `server/index.js` |
| Snowflake adapter and prompt | `server/inference.js`, `server/prompt.js` |
| Model evaluation | `harness/fixtures.json`, `harness/evaluate.js` |
| Demo data and mock Canvas | `extension/demo-data.js`, `harness/mock-canvas.js` |
| Shared agent instructions | `AGENTS.md` |

Read [architecture and contracts](docs/architecture.md) before changing interfaces. The model harness includes a versioned prompt, synthetic evaluation cases, mock/live providers, and shared instructions for coding agents. The current planner subtracts estimated active work plus 25% from the deadline; it does not resolve overlapping assignments or account for your schedule. Live Canvas and Snowflake integration must be verified with your own accounts.

For model costs and the proposed ±25% accuracy validation plan, see [model selection](docs/model-selection.md).
