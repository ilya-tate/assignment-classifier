# DigitalOcean App Platform (private, single-user)

1. Reload the unpacked extension. Open **Server settings** and copy the displayed `chrome-extension://...` allowed origin.
2. Generate a private access key: `openssl rand -hex 32`. Keep it outside git.
3. Review, commit and push the deployment code to your GitHub branch. Existing uncommitted work must also be included if required by these files.
4. DigitalOcean → **Create App** → select that repository and branch. Choose **Web Service**, source directory `/`, no custom build command, run command `npm start`, HTTP port `8080`, HTTP health-check path `/health`, one instance, 512 MiB (increase if monitoring shows pressure). Route `/` to the service. Keep autoscaling off.
5. Set these component environment variables with **runtime** scope before deploying:

   | Key | Value | Encrypt? |
   | --- | --- | --- |
   | `HOST` | `0.0.0.0` | No |
   | `NODE_ENV` | `production` | No |
   | `API_ACCESS_KEY` | Key from step 2 | Yes |
   | `ALLOWED_ORIGINS` | Origin from step 1 | No |
   | `INFERENCE_PROVIDER` | `mock` initially | No |
   | `INFERENCE_BATCH_SIZE` | `1` | No |

6. Deploy. Verify `curl -fsS https://YOUR-APP.ondigitalocean.app/health` returns `{"ok":true,"provider":"mock"}`.
7. In extension **Server settings**, enter the app's HTTPS origin and access key, click **Save**, and allow access to that domain. Reopen the popup and **Load demo**.
8. For real estimates, set `INFERENCE_PROVIDER=snowflake`, `SNOWFLAKE_ACCOUNT_URL` to your account URL, and encrypted runtime `SNOWFLAKE_TOKEN` to your PAT. Redeploy, then **Sync Canvas & estimate** from your signed-in Canvas tab. Calls incur Snowflake usage.

## Access, limits, and retention

This is one private user identity: everyone with the key can read the latest assignments and poll/cancel any job. Do not distribute one key to unrelated users. Multi-user hosting needs separate identities and per-user data/jobs; it is not implemented.

Hosted mode is enabled by a non-loopback `HOST`. It refuses startup without a 32-character access key and explicit extension origins. All data/API routes require bearer authentication; only `/health` and CORS preflight are public. DigitalOcean provides the external HTTPS endpoint; the container listens on HTTP internally. Do not expose this listener directly over public HTTP.

Defaults are 240 authenticated requests/minute and 6 estimate starts/hour, globally for this identity. Optional `API_REQUESTS_PER_MINUTE` and `API_ESTIMATES_PER_HOUR` accept positive integers. Limits reset on process restart. One batch runs at a time. Keep one instance: job state and limits are in memory. Restarts/deployments lose jobs; rerun Sync.

Hosted mode never writes diagnostic files and ignores `SYNC_LOG_DIR`. Sanitized inference metadata goes to platform stdout; no assignment text, tokens, or credentials are logged. Sync reports are accepted but discarded. Latest assignment data and job results expire 15 minutes after creation (cleanup runs every 10 seconds), or immediately on process termination. Unpolled running jobs cancel after about 60–70 seconds; batches stop after 10 minutes. Browser assignments/documents remain until **Clear data** or extension removal; Clear data preserves server settings. To forget the access key, save localhost with an empty key. Snowflake receives text for inference; its provider policies apply separately.

No hosted deployment, browser permission flow, signed-in Canvas sync, or live Snowflake verification is implied by automated mock tests.

References: [DigitalOcean Node buildpack](https://docs.digitalocean.com/products/app-platform/reference/buildpacks/nodejs/), [port configuration](https://docs.digitalocean.com/support/how-to-troubleshoot-apps-in-app-platform/), [health checks](https://docs.digitalocean.com/products/app-platform/how-to/manage-health-checks/).
