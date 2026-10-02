# Live Snowflake batch evaluation — October 2, 2026

Measured against the configured open-weight `llama3.1-8b` model, prompt `effort-v4`, temperature 0, three concurrent requests, using only synthetic fixtures. No browser or live Canvas test was performed. Credentials and raw model content are absent from reports/logs.

## Ordinary tasks

One 46-assignment run per mode, with identical shuffled inputs, using three distinct synthetic assignments (quiz, 1500-word essay, programming project) repeated to reach 46. There were no retries or invalid delivered estimates in this cohort. These are single-run measurements, not confidence intervals or representative production data.

| Batch size | Wall time | Requests | Input tokens | Output tokens | Delivered estimates | Within ±25% of singleton |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 32.38 s | 46 | 8,554 | 2,901 | 46/46 | 46/46 (100.0%) |
| 5 | 15.57 s | 10 | 3,793 | 1,647 | 46/46 | 10/46 (21.7%) |
| 10 | 18.10 s | 5 | 2,864 | 1,681 | 46/46 | 23/46 (50.0%) |

Size 5 ran about 2.08 times faster than size 1; size 10 ran about 1.79 times faster. Total reported tokens fell from 11,455 to 5,440 (52.5% fewer) and 4,545 (60.3% fewer), respectively. Tokens are provider-reported usage, not account billing or dollar charges. Wall time includes model calls and evaluator overhead, but excludes final trace flush and browser polling. The earlier aborted diagnostic run is excluded from these totals.

Agreement with singleton estimates is **not accuracy**: a singleton estimate can itself be wrong. The same quiz ranged from 20 to 100 minutes in mode 5. Essay estimates were 480 minutes in singleton mode, 480–1,500 in mode 5, and 720 in mode 10. Programming project estimates were 240 in singleton mode, 240–720 in mode 5, and 240–480 in mode 10. These differences appeared without adversarial fixtures, so injection alone does not explain them. Neighboring assignments, positions and multi-item prompting are plausible causes; this evaluation does not isolate them experimentally.

Broad smoke ranges passed for 31/46, 21/46 and 30/46 delivered estimates, respectively. Those hand-written ranges are not observed completion times. In particular, all essay estimates exceeded the current fixture's broad range in every mode. This flags a disagreement with a synthetic expectation, not a demonstrated real-world prediction error.

## Stress cohort

Three repetitions of 46 assignments, drawing from five distinct fixtures, including prompt injection in description and attachment text. The same shuffle was used across modes within each repetition; mode order rotated between repetitions. Counts below total all three runs; time is the median per run.

| Batch size | Median time | Requests | Singleton fallback attempts | Delivered estimates | Broad smoke checks passed |
| --- | --- | --- | --- | --- | --- |
| 1 | 28.09 s | 138 | 0 | 111/138 | 84/138 |
| 5 | 17.01 s | 43 | 13 | 73/138 | 61/138 |
| 10 | 15.17 s | 25 | 10 | 42/138 | 31/138 |

The description-injection fixture failed schema validation on all 27 singleton attempts. Grouped runs sometimes delivered schema-valid but unusual estimates, including 999 minutes for this fixture. Group fallback also failed on some adversarial items. Because the adapter returns a group atomically, one unrecovered item suppresses the other group estimates: delivered-count failures do **not** mean every item produced malformed JSON. Likewise, the production job still fails atomically if any group fails. The stress cohort would therefore fail a full production sync in every mode.

Raw model output was not stored, so a schema failure cannot distinguish all semantic causes. The invalid estimates are caught by contract validation. The test does not establish prompt-injection robustness just because a numerical result satisfies the contract.

## Decision and remaining evidence

The evaluation recommendation was to keep the default at 1. For the demo, the user subsequently chose a default of 5; this changes the demo configuration, not the evaluation findings. Size 5 was fastest in the ordinary run and is a useful optimization candidate, but neither grouped mode maintained singleton consistency. Size 10 used the fewest tokens and was more consistent than 5 in this ordinary run, yet it was slower; one run cannot establish a reliable ranking. These results do not establish that singleton estimates are more accurate.

Actual ±25% prediction accuracy is unavailable: the user confirmed there are no recorded active completion times. The evaluator explicitly records this missing evidence rather than deriving accuracy from fixture ranges, model self-confidence or singleton agreement. Future labeled evaluation should compare `abs(predicted - actual) / actual <= 0.25` on held-out tasks, counting failed predictions as misses and reporting results by task type. `harness/batch-evaluation.js` includes tested metrics for positive actual-minute labels, but no labels were invented for this run.

The evaluator now retains model failures and continues later groups, saves checkpoints, records request/token/retry totals, and preserves metadata traces under ignored `sync-logs/evaluation/`. Auth, rate-limit, configuration and network failures stop queued work. This change affects evaluation only; production failure semantics are unchanged. The final full suite passes 47 tests, and all five mock smoke fixtures pass. Offline comparison was also run successfully; it is separate from these live measurements.

Reproduce (paid inference):

```sh
npm run eval:batch -- --live
npm run eval:batch -- --live --clean --repeats=1
```

Detailed ignored results: `harness/batch-live-stress.json` and `harness/batch-live-ordinary.json`. The latest run is also in `harness/batch-results.json`. Each run contains per-case estimates/error codes, per-fixture statistics, token totals and metadata trace paths. Only synthetic cases are saved.
