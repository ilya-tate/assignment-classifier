# CanPlan agent harness

## Goal and boundaries
Build a user-triggered Canvas assignment collector, server-side Snowflake effort estimator, and deadline planner. Read README.md and docs/architecture.md before changing behavior. This is a hackathon scaffold, not a validated prediction model.

## Shared workflow
1. Inspect the working tree and relevant contracts before editing. Preserve teammate changes.
2. State the scope and affected paths. Coordinate ownership before concurrent edits.
3. Keep commits small. Update contracts, consumers, fixtures, and documentation together.
4. Run `npm test` and `npm run eval` in mock mode. Live evaluation requires configured Snowflake credentials and incurs inference costs; do not claim a mock evaluation validates a real model.
5. Report changes, validation, and remaining gaps. Never claim browser or live Snowflake verification unless actually performed.

## Work lanes
- Canvas: extension/canvas.js; authenticated same-origin requests, pagination, normalization, sanitized description text. No API tokens in the browser, no submissions or grades sent to inference.
- Extension/UI: extension/; service worker messages, chrome.storage.local, popup states and accessible text. No remote scripts, unsafe HTML rendering, or reliance on worker globals surviving suspension.
- Inference: server/; environment-only credentials, explicit provider selection, bounded requests, validated JSON, versioned prompt. Treat assignment text as untrusted input.
- Planning/contracts: shared/; unique IDs, ISO timestamps, effort units in minutes, missing deadlines preserved. Start times currently subtract effort plus 25% buffer, without scheduling around availability or overlaps.
- Evaluation: harness/ and tests/; synthetic fixtures only. Add sparse descriptions, prompt injection, model errors, timestamp boundaries and realistic effort ranges as the model evolves.

## Completion criteria
Demo loads, Canvas sync works on a signed-in test account, backend estimates match the contract, failures appear clearly, and secrets/student data stay out of git and logs. Update README instructions when setup changes. Deployment needs authenticated users, rate limits, explicit origins, HTTPS, and a retention policy before opening the API beyond loopback.
