# Choosing an effort-estimation model

Recommendation as of October 2, 2026: use open-weight models only: start with `llama3.1-8b` and compare `llama4-maverick` if the smaller model misses the target. There is no proprietary-model fallback. This is a hypothesis about fit, not a measured accuracy ranking. Confirm access in your account/region. The previous `snowflake-llama-3.3-70b` default is deprecated and must be replaced.

## Cost comparison

Snowflake's Service Consumption Table lists the following Cortex Inference rates in **AI credits per million tokens**, not dollars:

| Model | Input | Output | Suggested use |
| --- | ---: | ---: | --- |
| llama3.1-8b | 0.11 | 0.11 | Initial 8B default to validate |
| llama4-maverick | 0.12 | 0.485 | Larger open-weight comparison |

For 1,000 input tokens and 200 billed output tokens, per 1,000 assignments this is approximately 0.132 and 0.217 AI credits respectively. Multiply by your account's AI-credit price to estimate dollars. Excludes caching, retries and additional output/reasoning tokens; use actual billed usage for measurements. Cortex Chat Completions does not expose a weight-quantization selector: changing quantization would require a separate serving approach and benchmarking.

Sources: [Snowflake Service Consumption Table, Tables 6(b) and 6(c)](https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf), [Cortex REST model availability and API fields](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api), [model deprecations](https://docs.snowflake.com/en/release-notes/bcr-bundles/un-bundled/bcr-june-model-deprecations).

Llama weights are available under Meta's community licenses; open-weight does not imply unrestricted licensing. Do not replace the deprecated model with `llama3.1-70b` for a new account: it entered legacy status in August 2026 and new accounts cannot start using it. [Meta model information](https://ai.meta.com/blog/meta-llama-3-1/), [Snowflake August lifecycle notice](https://docs.snowflake.com/en/release-notes/bcr-bundles/un-bundled/bcr-august-model-deprecations).

## Define the accuracy target

Measure `abs(predictedMinutes - actualMinutes) / actualMinutes <= 0.25`. Proposed meaning of "most": at least 80% of held-out assignments meet this criterion. A 60-minute assignment passes with a prediction between 45 and 75 minutes. Track signed errors too: underestimates are more disruptive to planning. Do not include the planner's 25% scheduling buffer in the raw estimation accuracy metric.

Collect at least 100 representative completed assignments as an initial pilot, with active work minutes excluding breaks. Include quizzes, reading, essays, labs, and programming tasks, and record task size and student familiarity. Only provide information available before completion to the model. Use separate calibration and held-out sets, split by student and/or time according to the deployment goal, and keep repeated or near-identical assignments together to avoid leakage. Report hit rate by assignment type, absolute percentage error, JSON validity, latency, and measured billed usage. A pilot's hit rate is uncertain; report its sample size and an interval before claiming production accuracy.

Descriptions alone omit reading speed, prior knowledge, attachment requirements and individual pace. Collect actual-time feedback and learn a per-student/type adjustment from past work. Compare every model with a simple task-type median baseline. Select the cheapest candidate that meets the held-out target; buy a larger model only if measured gains justify it. Self-reported model confidence is not calibrated evidence.

Current `npm run eval` fixtures are synthetic smoke checks with broad ranges. They cannot establish a ±25% completion-time claim. Keep real student records out of committed fixtures; any live comparison sends assignment content to Snowflake and consumes inference usage.
