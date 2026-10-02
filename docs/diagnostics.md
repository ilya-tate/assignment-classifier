# Diagnose scraping and inference

Restart `npm start`, reload the unpacked extension, refresh Canvas, and retry Sync with the popup kept open. No credentials or model switch is needed. Inference uses the configured open-weight model.

## Where to look

- Server terminal: one JSON event per batch/request stage.
- `sync-logs/inference-<batch UUID>.jsonl`: incremental inference events, saved even if the batch fails or the popup closes.
- `sync-logs/sync-<time>.json`: combined scrape and inference summary; the popup displays the path. Its `inferenceJobId` matches the JSONL batch ID.
- Canvas tab DevTools console: `[Canvas request]` for each API request, including failed requests. Popup DevTools console shows the inference job ID/path and errors.

`SYNC_LOG_DIR` optionally overrides the directory. Both log formats contain timings, counts, statuses and generated request/batch IDs. Newly saved reports omit course/assignment names, file names, descriptions, attachment contents, raw model output, tokens, and arbitrary browser fields. Canvas API numeric path IDs are replaced with `:id`; query strings are not stored. Older reports from previous versions may still contain names. Logs stay local and are gitignored; remove unneeded files manually.

## Reading an inference trace

Events: `batch_started` → `assignment_started` → `snowflake_request` → `snowflake_headers` → `snowflake_body` → `model_parsed` → `assignment_finished` → `batch_finished`.

Each assignment is numbered by its index in the submitted batch. `queueMs` measures time waiting for a worker; `headersMs` shows time until Snowflake responds; `responseMs` includes reading the body. `ms` on the finished event is total per-assignment time. Request/response byte sizes and token counts help spot large inputs or excessive generation. `finishReason`, `contentChars`, `fenced`, `parseStatus`, and `errorCode` distinguish formatting problems without saving student text. `requestId` can be used when investigating the corresponding request with Snowflake.

| Code | Meaning |
| --- | --- |
| MODEL_JSON_INVALID | Model content could not be parsed as JSON |
| MODEL_SCHEMA_INVALID | JSON parsed, but minutes/reason violated the contract |
| EMPTY_CONTENT | Completion content was missing or empty |
| OUTPUT_TRUNCATED | Snowflake reported the output token limit was reached |
| CONTENT_FILTERED | Snowflake reported a content-filter stop |
| HTTP_JSON_INVALID / HTTP_ENVELOPE_INVALID | API response body was not the expected JSON envelope |
| HTTP_400 / HTTP_401 / HTTP_429, etc. | Snowflake rejected the request; correlate the logged request ID |
| REQUEST_TIMEOUT / NETWORK_ERROR | Request exceeded 45 seconds or failed in transport |
| CANCELLED | Work stopped after cancellation, deadline, or another assignment failure |

One complete Markdown JSON fence is now accepted. Surrounding prose, malformed objects and invalid values still fail; there is no heuristic object extraction or mock fallback. The prompt explicitly requests only JSON, uses temperature 0, and caps generation at 512 tokens. No automatic paid retries are made.

## Scrape timing

Reports retain every API request (up to 10,000), not just the slowest 15: bucket, page, HTTP status, bytes, total duration, time to response headers, body download and JSON parsing. Failures preserve available partial diagnostics; progress messages provide a fallback if the injected collector stops responding. Course timing separates fetching lists from processing/filtering. Linked-document content downloads remain a separate optional phase; `READ_FILES` is off by default.

## Batch behavior

The previous code serialized all assignments behind one 60-second browser request. At two seconds each, 46 assignments would take about 92 seconds before overhead. The extension now starts an in-memory job and polls every second using short requests, with three concurrent model calls. The popup displays completed/total and elapsed time. The batch limit is 10 minutes, each Snowflake call is bounded at 45 seconds, and jobs stop after about 60–70 seconds without a poll (for example, after closing the popup). Failure cancels active HTTP requests and stops queued work. This bounds client work; provider-side billing after an abort is not guaranteed to stop.

Results are returned as a complete ordered batch; partial results are not displayed as a successful sync. Job results are retained in memory for 15 minutes after the last poll and disappear on restart. `POST /api/estimate-jobs` starts work; `GET /api/estimate-jobs/<id>` reports status/results; `DELETE` cancels. The old `POST /api/estimate` remains for direct API callers and tests, with the same concurrency/logging. Only one batch can run at a time.

Validation uses mocked Snowflake responses and mock Canvas, including a 46-assignment batch, malformed/fenced/truncated responses, cancellation, ordered results, log redaction and scrape failures. A real browser/Canvas/Snowflake run is still required to measure actual latency and the model's output behavior.

References: [Snowflake response fields](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api), [Chrome worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

## Grouped inference

`INFERENCE_BATCH_SIZE=1|5|10` sets the maximum assignments per model call. Reports expose `batchSize`, `groupCount`, `requests`, `retries`, `promptTokens` and `completionTokens`. Group request events carry `groupIndex`; single-assignment groups also carry `index`. Per-assignment start/finish events carry both. `model_parsed.missingItems` counts absent/invalid estimates. `item_retry.localIndex` identifies a retry within its group without logging Canvas IDs. `group_fallback` records whole-group parsing/truncation/ID errors. Unknown or duplicate IDs use `MODEL_IDS_INVALID`.

Group timings include single-item fallback time; adding all assignment durations is not wall-clock time. `requests` includes failed calls and fallback attempts, while token totals include only usage metadata actually returned by the provider. Missing usage fields contribute zero, so totals may be incomplete. Mock mode has no provider requests or token usage. See [batch comparison](batching.md).
