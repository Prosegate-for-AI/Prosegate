import type { Doc } from "./clean-corpus.js";
// Round-2 clean corpus, part 4: formats Claude produces often that parts 1-3 under-sample.
export const NEW_EXTRA: Doc[] = [
{ id: "n-x-bold-chat", kind: "chat", text: `The deploy failed because the migration and the app started at the same time. The app checks the schema version on boot and exits if it is behind, so the new pods crashed while the migration was still running.

Run the migration as a **pre-deploy job** instead of an init container in every pod. The job runs once, and the rollout waits for it. This also stops two pods from running the same migration at once.

Keep the version check in the app. It is what turned a silent schema mismatch into a clear crash. Make sure the job has the **same image tag** as the deployment.` },
{ id: "n-x-labels-chat", kind: "chat", text: `**Short answer:** yes, upgrading to 3.2 is safe for your setup.

The breaking changes in 3.x are the removal of the XML config format and the new default for connection timeouts. You use the YAML config, and you already set the timeout explicitly, so neither affects you.

**One thing to check:** the 3.x client logs at INFO by default instead of WARN. If your log pipeline bills by volume, set the level back to WARN in the config before you deploy.` },
{ id: "n-x-alert", kind: "code", text: `To rotate the database password without downtime, create the new user first and switch the app over before you drop the old one.

> [!NOTE]
> The app reads the password from the secret on start, so each pod picks up the new value when it restarts.

1. Create \`app_v2\` with the same grants as \`app\`.
2. Update the secret to the \`app_v2\` credentials.
3. Restart the deployment and wait for every pod to be ready.
4. Drop the \`app\` user once the connection count for it reaches zero.

Step 4 is the only one you cannot undo, so check \`pg_stat_activity\` before running it.` },
{ id: "n-x-table", kind: "chat", text: `Here is how the three queues compare for your workload of about 2,000 messages a second with a few large payloads.

| | SQS | RabbitMQ | Kafka |
|---|---|---|---|
| Ordering | per group (FIFO) | per queue | per partition |
| Max message | 256 KB | no hard limit | 1 MB default |
| Ops burden | none | moderate | high |

Your largest payloads are about 2 MB, so with SQS you would store them in S3 and send a pointer, which the extended client library does for you. Given that you have no one to run a broker, I would pick SQS and accept the pointer pattern for the large messages.` },
{ id: "n-x-review", kind: "code", text: `Two things in this diff, one of which should block the merge.

The new \`retry\` decorator catches \`Exception\`, which includes \`KeyboardInterrupt\` in older code paths that re-raise it wrapped, and it retries on validation errors that will fail the same way every time. Catch the transport errors you mean, \`httpx.TransportError\` and \`httpx.HTTPStatusError\` for 5xx, and let everything else through.

Smaller point: \`backoff=2\` reads as two seconds, but the decorator treats it as a multiplier. Renaming it to \`backoff_factor\` would match the \`urllib3\` name people already know.` },
{ id: "n-x-commit-trailer", kind: "pr", text: `Handle empty pages in the paginated sync

The partner API sometimes returns an empty page with a next cursor
when records are deleted between requests. The sync loop treated an
empty page as the end and stopped early, so later records were never
fetched. Follow the cursor until the API returns no cursor, whatever
the page size.

Adds a test with a fake API that returns an empty middle page.

Co-Authored-By: Claude <noreply@anthropic.com>` },
{ id: "n-x-status", kind: "email", text: `Hi everyone,

Here is this week's status for the billing migration.

Done: the invoice generator now runs on the new service for all tenants on monthly plans, which is 82% of invoices. Totals matched the old system for every invoice in the comparison run.

Next: annual plans move next Tuesday. They have proration rules the monthly plans do not, so we are running the comparison for two weeks of historical data first.

Risk: the tax provider's sandbox has been unreliable, and if it stays down we will test against production in read-only mode instead, which needs sign-off from finance.

Lena` },
{ id: "n-x-headed-answer", kind: "chat", text: `## Cause

The cache key includes the full URL, query string included, and your analytics links add a different \`utm_\` parameter to each campaign. Every campaign link is a cache miss, so the origin served 70% of the homepage traffic yesterday.

## Fix

Strip the \`utm_\` parameters from the cache key in the CDN config. The analytics script reads them from the browser's URL, not from the server, so the pages do not need them. After the change the hit rate for the homepage should go back to where it was before the campaign, about 95%.` },
];
