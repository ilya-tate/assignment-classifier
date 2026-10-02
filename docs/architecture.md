# Architecture and team contracts

User click → active Canvas tab → paginated courses/assignments API → normalized assignment → extension service worker → loopback API → mock or Snowflake Cortex → validated estimate → local browser cache → popup planner.

The extension uses activeTab and scripting to work with custom Canvas domains without permanent access to every website. Canvas credentials stay in the signed-in tab. Sync is a read operation and is explicit. An API-based collector is more stable than DOM selectors; rendered-page scraping can be a separate adapter if institution settings block API access.

POST /api/estimate takes `{assignments: Assignment[]}` and returns `{assignments: PlannedAssignment[]}`. Assignment fields: unique string id, title, course, plain-text description (12,000 characters max), ISO dueAt or null, nonnegative points, and string[] submissionTypes. Maximum batch is 100. Extra fields, including URLs, are discarded at the server boundary. Estimate fields: integer estimatedMinutes (5–10,080), reason, provider; planner adds ISO startAt or null. Errors use `{error: string}` with HTTP 400/413/415 for invalid requests or 502 for inference failure.

Snowflake uses Cortex's OpenAI-compatible chat completions endpoint with a server-held personal access token. Select a model enabled for your account and region. Model output must be plain JSON; invalid output fails the request rather than silently substituting mock estimates. No persistence in Snowflake is implemented: assignment content is sent for inference only.

The server binds to loopback. Default CORS allows extension origins for local development; ALLOWED_ORIGINS can pin one extension ID. CORS is not authentication. Do not expose this server to a network without adding authentication and rate limits. No assignment payloads or credentials are logged. Browser data persists until Clear data or extension removal.

Known limits: large sequential Snowflake batches can exceed the extension's 60-second deadline; start with demo-sized batches. Popup closure can interrupt the UI flow. No availability calendar, conflict resolution, attachments, personalized pace, actual-time feedback, institution-wide Canvas validation, or production deployment is included.

References: [Chrome service workers](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers), [Canvas assignments API](https://developerdocs.instructure.com/services/canvas/resources/assignments), [Snowflake Cortex REST API](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api).
