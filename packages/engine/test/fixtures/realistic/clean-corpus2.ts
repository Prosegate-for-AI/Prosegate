import type { Doc } from "./clean-corpus.js";
// Batch 2: realistic clean replies with the shapes the structure, triad and repetition rules look at.
export const CLEAN2: Doc[] = [
{ id: "pr-t1", kind: "pr", text: `## Summary

Adds pagination to \`GET /v2/projects\`. The endpoint returned every project in one response, which timed out for the three tenants with more than 20,000 projects.

## Changes

- Accept \`page_size\` (default 100, max 500) and \`cursor\` query parameters.
- Return \`next_cursor\` in the response body; it is null on the last page.
- Order by \`(created_at, id)\` so the cursor is stable when projects share a timestamp.

## Testing

Unit tests cover the first page, a middle page, the last page and an invalid cursor. I also ran the endpoint against a copy of the largest tenant: each page returns in under 80 ms.` },

{ id: "pr-t2", kind: "pr", text: `## What

Switch the image resizer from ImageMagick to libvips.

## Why

ImageMagick uses about 900 MB of memory to resize a 40-megapixel photo, and the resizer pods are limited to 1 GB, so large uploads get OOM-killed. libvips streams the image and peaks at 120 MB for the same file.

## How

The resizer calls \`sharp\`, which wraps libvips. Output quality settings are mapped one to one, and a visual diff of 500 sample images shows no difference a reviewer could see at 100% zoom.

## Risk

\`sharp\` ships prebuilt binaries for linux-x64 and arm64 only. Our build images are x64, so this is fine today.` },

{ id: "pr-t3", kind: "pr", text: `Upgrade Node from 18 to 20 across all services

Node 18 reaches end of life in April. This PR updates the base image, the \`.nvmrc\` files and the CI matrix.

Changes:

- Base image \`node:18-alpine\` replaced by \`node:20-alpine\` in all 14 Dockerfiles.
- \`engines.node\` in every \`package.json\` set to \`>=20\`.
- Removed the \`--experimental-fetch\` flag from the worker, since fetch is stable in 20.
- Replaced the deprecated \`url.parse\` calls in the gateway with \`new URL()\`.
- Bumped \`@types/node\` to 20.11 and fixed the four type errors it surfaced.

All services pass CI on 20. I deployed the gateway and the worker to staging yesterday and they have run without errors since.` },

{ id: "pr-t4", kind: "pr", text: `Fix: lint, test, and build steps ran on every push to docs/

The CI workflow had no path filter, so a typo fix in the docs ran the full pipeline, which takes 14 minutes. This adds \`paths-ignore\` for \`docs/**\` and \`*.md\` to the lint, test and build jobs, and keeps the link checker running for docs changes.

Docs-only PRs now finish in under a minute. Code PRs are unaffected; I checked that a change touching both \`src/\` and \`docs/\` still runs everything.` },

{ id: "pr-t5", kind: "pr", text: `Add GET, PUT, and DELETE handlers for saved filters

Saved filters could be created but not read back, changed or removed, so the UI kept them in local storage instead. This adds the missing handlers.

Each handler checks that the filter belongs to the caller's workspace and returns 404 otherwise, so one workspace cannot probe for another's filter IDs. PUT replaces the whole filter; there is no partial update, because the UI always sends the full object.

Tests cover each handler for the owner, a member of another workspace and an anonymous caller.` },

{ id: "chat-b1", kind: "chat", text: `**Short answer:** use \`git revert\`, not \`git reset\`, because the commit is already on the shared branch.

\`git reset --hard HEAD~1\` would remove the commit locally, but you would then have to force-push, and anyone who pulled since would end up with the commit again when they push. \`git revert <sha>\` adds a new commit that undoes the change, which everyone can pull normally.

If the commit included a secret, reverting is not enough: the secret stays in history. Rotate it first, then decide whether rewriting history is worth the disruption.` },

{ id: "chat-b2", kind: "chat", text: `The three settings that matter here are \`work_mem\`, \`shared_buffers\` and \`effective_cache_size\`.

\`work_mem\` is per sort or hash operation, not per connection, so a complex query can use several multiples of it. With 200 connections, setting it to 256 MB can exhaust memory under load. Keep it at 16 MB globally and raise it per session for the reporting queries.

\`shared_buffers\` at 25% of RAM is the usual starting point; you are at 8 GB on a 64 GB box, which is fine.

\`effective_cache_size\` does not allocate anything. It tells the planner how much the OS is likely caching, and 48 GB is a reasonable value for your machine.` },

{ id: "chat-b3", kind: "chat", text: `The container starts, prints nothing, and exits with code 0 because the entrypoint script runs the server in the background and then reaches the end of the script.

\`\`\`bash
#!/bin/sh
node server.js &
\`\`\`

When the script exits, the container exits, and the background process goes with it. Remove the \`&\` and use \`exec\` so the server becomes PID 1 and receives signals from Docker:

\`\`\`bash
#!/bin/sh
exec node server.js
\`\`\`

With \`exec\`, \`docker stop\` sends SIGTERM to Node directly, so the graceful shutdown handler you already have will run.` },

{ id: "chat-b4", kind: "chat", text: `The cache is keyed by tenant ID, so each tenant gets its own cache entries. When a tenant's plan changes, the billing service publishes an event, and the cache consumer deletes that tenant's entries.

The bug is in the consumer. It deletes entries for the tenant ID in the event, but the event carries the billing account ID, which differs from the tenant ID for the 40 tenants that were merged last year. Those tenants keep stale plan data until the entries expire after 24 hours.

Map the billing account ID to the tenant ID in the consumer before deleting. The mapping table already exists in the billing schema.` },

{ id: "chat-b5", kind: "chat", text: `The service needs read access to the bucket and write access to the queue. The bucket policy grants read access to the service's role. The queue policy grants write access to the same role.

What is missing is the KMS key policy. Both the bucket and the queue are encrypted with the same customer-managed key, and the key policy does not list the role, so every read from the bucket and every write to the queue fails with an access-denied error from KMS, not from S3 or SQS.

Add the role to the key policy with \`kms:Decrypt\` and \`kms:GenerateDataKey\`.` },

{ id: "chat-b6", kind: "chat", text: `To answer your question directly: the upgrade does not require downtime.

The new version reads both the old and the new config format, so you can roll it out pod by pod while the old config is still in place. Once every pod runs the new version, migrate the config, and then remove the old format in the following release.

So the order is: deploy, migrate the config, then clean up in the next release. None of those steps requires downtime.` },

{ id: "chat-b7", kind: "chat", text: `The p95 went up after the deploy because the new version logs every request body at info level. The bodies average 30 KB, and the logging call is synchronous, so each request now waits for a 30 KB write to stdout.

Move body logging to debug level, or log only the first 1 KB. Either change brings p95 back to where it was; I tried the debug-level change on one staging pod and p95 dropped from 340 ms to 120 ms.

The log volume also explains the jump in the logging bill this week.` },

{ id: "chat-b8", kind: "chat", text: `You need the \`ReadWriteMany\` access mode because three pods on different nodes mount the same volume. The default storage class, \`gp3\`, only supports \`ReadWriteOnce\`, which allows one node at a time; the second pod stays in \`ContainerCreating\` with a multi-attach error.

Use the \`efs-sc\` storage class, which supports \`ReadWriteMany\`. EFS is slower than EBS for small random writes, so if the pods write a lot of small files, consider giving each pod its own volume and syncing through object storage instead.` },

{ id: "chat-b9", kind: "chat", text: `The import fails for rows with a comma inside a quoted field, such as \`"Smith, John"\`. The script splits each line on commas with \`line.split(",")\`, so that row gets one column too many and the type check on the next column fails.

Use the \`csv\` module instead of splitting by hand; it handles quoted fields, escaped quotes and embedded newlines:

\`\`\`python
import csv
with open(path, newline="") as f:
    for row in csv.reader(f):
        ...
\`\`\`

The \`newline=""\` argument matters on Windows, where the file has CRLF line endings.` },

{ id: "chat-b10", kind: "chat", text: `Kafka guarantees order within a partition, not across a topic. Your producer sends events for the same order to different partitions because it does not set a key, so the default partitioner spreads them round-robin, and the consumer sees "shipped" before "paid" when the partitions are read at different speeds.

Set the message key to the order ID. Every event for one order then goes to the same partition and is consumed in the order it was produced. This does not change throughput as long as you have many distinct orders.` },

{ id: "design-b1", kind: "design", text: `# Background job retries

Jobs that fail are retried with a fixed 30-second delay, up to 10 times. This works for transient failures, but a job that fails because of a bug retries 10 times in five minutes and then disappears into the dead-letter table, where nobody looks.

## Proposal

Retry with exponential backoff, starting at 30 seconds and doubling up to a ceiling of one hour, for at most 8 attempts. That spreads retries over about four hours, long enough to ride out a provider outage.

After the last attempt, move the job to the dead-letter table and post a message to the owning team's channel with the job type, the error and a link to the job.

## Not in scope

Per-job-type retry policies. Only two job types have asked for one, and both are happy with the new default.` },

{ id: "design-b2", kind: "design", text: `# Moving sessions out of the application database

Sessions live in the \`sessions\` table in the main Postgres database. The table takes 4,000 writes a second at peak, which is a third of all writes to the database, and most of them only update \`last_seen_at\`.

We propose moving sessions to Redis. Session reads become a single \`GET\`, writes become a \`SET\` with a TTL, and expiry happens without a cleanup job.

The cost is durability: if Redis loses data, users are logged out. We would run Redis with AOF persistence and a replica, which limits loss to about a second of writes, and losing a second of \`last_seen_at\` updates is harmless.

The migration reads from Redis first and falls back to Postgres for a week, so no user is logged out by the switch.` },

{ id: "email-b1", kind: "email", text: `Hi Tom,

Following up on the outage on Tuesday. The root cause was an expired TLS certificate on the internal API gateway. The certificate was issued manually two years ago, outside the automated renewal, and nobody had a reminder for it.

We have moved the certificate to automated renewal and added an alert for any certificate within 14 days of expiry, across all our domains. A scan found two more manual certificates, and both are now automated.

Your team does not need to do anything. I am happy to go through the details on a call if useful.

Regards,
Nina` },

{ id: "email-b2", kind: "email", text: `Hi all,

The office network will be down on Saturday from 08:00 to 12:00 while the switches are replaced. VPN access to production is not affected, because it terminates in the data centre, not in the office.

If you plan to work from the office that morning, bring a phone you can tether to, or work from home.

Thanks,
IT` },

{ id: "incident-b1", kind: "incident", text: `Summary: for 26 minutes on Monday, password reset emails were not delivered.

The email provider rotated its API key format, and our sender rejected the new key in the config because the validation regex expected the old prefix. The sender logged the error and kept running, so nothing alerted. Support noticed when customers began reporting missing emails.

We removed the prefix check, since the provider's API validates the key anyway, and added an alert on the rate of failed sends. The 312 reset emails that failed were re-sent automatically once the fix was deployed.` },

{ id: "status-b1", kind: "chat", text: `Done. I updated the three services, ran the tests, and deployed to staging.

The billing service needed one extra change: its health check called an endpoint that the new client library renamed, so I updated the path. The other two needed no changes beyond the version bump.

Staging has been healthy for an hour. I have not deployed to production; tell me when you want that, or I can schedule it for the Thursday window.` },

{ id: "status-b2", kind: "chat", text: `I looked at the slow test suite. The integration tests take 11 minutes, and 7 of those are spent starting and stopping the database container, which happens once per test file.

Starting the container once per run and truncating tables between files brings the suite to 4 minutes on my machine. The tests still pass in random order, so they do not depend on each other's data.

The change is in \`tests/conftest.py\` and touches no tests. I can open the PR now if that approach works for you.` },

{ id: "explain-b1", kind: "chat", text: `A process in uninterruptible sleep, state \`D\` in \`ps\`, is waiting on I/O inside the kernel and cannot be killed, not even with \`SIGKILL\`, until the I/O completes. Yours are waiting on the NFS mount: the NFS server went away, and the mount uses the \`hard\` option, so the kernel retries forever.

You can remount with \`soft,timeo=100\` so operations fail after a timeout instead of hanging, at the cost of applications seeing I/O errors during an outage. For a cache directory that is usually the better trade.` },

{ id: "explain-b2", kind: "chat", text: `Stack traces from the minified bundle are useless without source maps, and the error tracker only has source maps for the release it was told about. The build uploads the maps with the release name set to the Git SHA, but the frontend reports errors with the release name from \`package.json\`, which is \`1.0.0\` for every build.

Set the release in the frontend's error-tracker init to the same Git SHA that the build uses; the build already injects it as \`process.env.GIT_SHA\`. New errors will then resolve to source lines.` },

{ id: "explain-b3", kind: "chat", text: `Read replicas lag because replication is asynchronous: the primary commits and returns, and the replica applies the change shortly after. Your replica lag is usually under 50 ms, but it reaches several seconds during the nightly batch job, which writes 2 million rows in one transaction.

The user saw stale data because the app read from the replica right after a write. For the pages where a user expects to see their own change, read from the primary for a few seconds after a write; the session already records the time of the user's last write, so the router can use that.` },

{ id: "explain-b4", kind: "chat", text: `The certificate is valid, but the chain is incomplete. The server sends only the leaf certificate and not the intermediate, and browsers fill the gap from their cache or by fetching it, so they accept it. \`curl\` and most server-side HTTP clients do not fetch missing intermediates, so they fail with "unable to get local issuer certificate".

Configure the server with the full chain file, leaf first and then the intermediate. With nginx that means pointing \`ssl_certificate\` at \`fullchain.pem\` instead of \`cert.pem\`.` },

{ id: "explain-b5", kind: "chat", text: `Feature flags are evaluated on the client, so the flag service sends the full rule set to every browser. That is why the "internal beta" rule, which lists employee email addresses, is visible in the network tab.

Move evaluation for that flag to the server: the server evaluates it with the user's context and sends the browser only the result. The flag SDK supports this per flag with the \`serverSide: true\` option. Rules that only depend on non-sensitive attributes, such as the app version, can stay on the client.` },

{ id: "explain-b6", kind: "chat", text: `Your Docker build reinstalls every dependency on each change because the \`COPY . .\` line comes before \`npm ci\`. Any file change invalidates that layer and every layer after it.

Copy the lockfile first, install, and then copy the rest:

\`\`\`dockerfile
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
\`\`\`

Now the install layer is only rebuilt when the lockfile changes. On this repo that takes a rebuild after a source change from 3 minutes to 20 seconds.` },

{ id: "howto-b1", kind: "chat", text: `To find which query is holding the lock, join \`pg_locks\` with \`pg_stat_activity\`:

\`\`\`sql
SELECT a.pid, a.state, a.query_start, a.query
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'orders'::regclass AND l.granted;
\`\`\`

The row with the oldest \`query_start\` and state \`idle in transaction\` is usually the culprit: a session that opened a transaction, touched the table and never committed. You can end it with \`SELECT pg_terminate_backend(pid)\`, then find the code path that left the transaction open. Setting \`idle_in_transaction_session_timeout\` to a few minutes stops this from recurring.` },

{ id: "review-b1", kind: "chat", text: `The change is correct, but the test does not test it. It mocks \`fetch_rates\` to return a fixed rate and then asserts the converted amount, so it would pass with or without the rounding fix.

Add a case where the rate produces a half-cent, such as 1.005 for 100 units, and assert that the result rounds half to even, which is what the finance team specified. That case fails on main and passes on this branch, which is the evidence the reviewer needs.` },

{ id: "answer-b1", kind: "chat", text: `Use a partial index. The query only ever filters for \`status = 'pending'\`, and pending rows are about 0.1% of the table, so a full index on \`status\` stores millions of entries you never read.

\`\`\`sql
CREATE INDEX CONCURRENTLY jobs_pending_idx ON jobs (created_at) WHERE status = 'pending';
\`\`\`

The index stays small, fits in memory, and covers the \`ORDER BY created_at\` too. Postgres uses it as long as the query repeats the \`status = 'pending'\` condition exactly.` },

{ id: "answer-b2", kind: "chat", text: `No, the timeout does not apply to the retries as a whole. Each attempt gets its own 5-second timeout, so with three retries and the backoff delays a call can take up to about 22 seconds before it fails.

If the caller needs an overall deadline, pass one through the context: the client checks the context before each attempt and gives up when the deadline has passed. The checkout handler already creates a context with a 10-second deadline, so it is enough to pass that context to the client instead of \`context.Background()\`.` },
];
