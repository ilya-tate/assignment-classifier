# Inference batching

Set `INFERENCE_BATCH_SIZE=1`, `5`, or `10` in `.env` and restart `npm start`. The demo default is 5; all modes use the same open-weight model selected by `SNOWFLAKE_MODEL`. Both the synchronous estimate API and polled job API use this setting. The extension needs no change, and progress still counts completed assignments.

Three workers process groups. Each group has at most the selected item count and a conservative 16,000-byte serialized input budget, including descriptions and attachments. UTF-8 bytes bound text tokens conservatively without a tokenizer; this is a packing budget, not an exact token count or a model context guarantee. A larger individual assignment is sent on its own and remains subject to provider limits. The output cap is 512 tokens times the number of items, up to 5,120. A final singleton uses the original single-item prompt.

The versioned multi-item prompt asks for an array with local numeric IDs, independent estimates and short reasons. IDs do not expose Canvas identifiers. Output ordering does not matter. Estimates are validated against the existing minutes/reason contract. Missing or invalid items receive one single-item retry, retaining valid estimates. Duplicate or unknown IDs invalidate the mapping; malformed, truncated or ambiguously mapped groups fall back to single-item attempts. A single retry failure fails the job. HTTP/auth/rate-limit/network errors are not retried, and cancellation stops fallback requests. Worst case per group: one grouped request plus one single attempt per item. No mock substitution occurs in Snowflake mode.

The existing job failure behavior remains: failed jobs cancel outstanding work and do not return a partial planned assignment list. Diagnostics survive. Within a successfully recovered group, valid estimates are never re-requested. Group durations include fallback time; request and token counters count provider calls once rather than multiplying by group size. Usage totals can be incomplete when the provider omits usage metadata.

## Offline comparison

Run:

```sh
npm test
INFERENCE_PROVIDER=mock npm run eval
npm run eval:batch
```

The comparison uses 46 synthetic assignments drawn from the effort fixtures, three runs per mode, and three concurrent workers. A fake HTTP provider exercises the real Snowflake request/parse path, returns reversed results to test ID mapping, and uses the demo heuristic for estimates. Simulated latency is 40 ms per request plus 2 ms per result; simulated token counts approximate UTF-8 bytes divided by four. These assumptions illustrate overhead amortization and do not reproduce a real model. Results are written to ignored `harness/batch-results.json`.

Example run on October 2, 2026:

| Maximum group size | Requests per run | Median wall time | Input token approximation | Output token approximation | Synthetic range checks |
| --- | --- | --- | --- | --- | --- |
| 1 | 46 | 685 ms | 11,434 | 1,398 | 46/46 |
| 5 | 10 | 195 ms | 5,350 | 1,506 | 46/46 |
| 10 | 5 | 122 ms | 4,161 | 1,504 | 46/46 |

Every simulated estimate matched the singleton baseline, with zero retries. Group outputs incur ID/array overhead, so output tokens need not decrease. The fixture ranges are smoke checks, not measured student times or evidence of ±25% accuracy. Simulation does not demonstrate live JSON reliability or speedups.

The test suite additionally exercises missing/invalid estimates, duplicate/unknown IDs, fenced JSON/prose rejection, truncation, bounded fallback, HTTP failures, cancellation, oversized/Unicode inputs, stable order, group concurrency, API configuration and metadata-only logs.

## Live comparison

With Snowflake configured, explicitly run:

```sh
npm run eval:batch -- --live
```

This incurs inference costs: 183 initial requests across all three modes and repetitions, plus bounded fallback attempts. Only synthetic assignments are sent. Real wall times and provider-reported token counts replace simulation assumptions. Live mode requires Snowflake provider selection and does not fall back to simulation on failure. It reports retries, range checks, and equality to one singleton baseline; equality is a consistency check, not accuracy. Model/schema failures are retained and the evaluator continues through later groups. Auth, rate-limit, network and configuration failures stop the comparison to avoid further paid requests. This evaluator behavior is separate from production jobs, which still fail atomically. Results are saved after each run, and metadata traces persist under ignored `sync-logs/evaluation/`.

For a model-quality comparison, collect consented, labeled active completion times and measure the percentage of estimates within ±25% on the same held-out assignments for each batch size. Repeat with shuffled assignment order to detect cross-item influence. Choose group size using real latency, tokens per successful estimate, recovery rate and labeled accuracy. Start at 5 for a live experiment; keep 1 available until live evidence supports switching the default.

The evaluator shuffles the same assignments for each mode within a repetition and rotates mode order between repetitions. Summary request/token/valid-result counts now total all repetitions; median time is per repetition. `singletonAgreement` compares estimates within ±25% of singleton estimates, only where both modes delivered valid results. This measures agreement, not accuracy, and excludes failed groups. `perFixture` records delivered prediction ranges and counts. Failure rates are group-level delivery outcomes: a failed single-item fallback can suppress otherwise-valid estimates in that group.

Use `--clean` to exclude the two injection fixtures, and `--repeats=1` for one repetition:

```sh
npm run eval:batch -- --live --clean --repeats=1
```

Separate ignored artifacts are retained as `harness/batch-live-stress.json`, `harness/batch-live-ordinary.json` and their simulated equivalents. `harness/batch-results.json` always contains the most recent run. The ordinary cohort has only three distinct tasks repeated to reach 46, so it still does not represent real Canvas assignments or establish statistical confidence. Live findings are recorded in [the evaluation report](live-evaluation.md).
