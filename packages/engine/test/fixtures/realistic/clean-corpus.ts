// Realistic agent replies a careful human editor would accept as clean.
// Watched constructs appear at the frequency they appear in good engineering prose, not more.
export interface Doc { id: string; kind: string; text: string }

export const CLEAN: Doc[] = [
{ id: "pr-01", kind: "pr", text: `Fix race in session refresh

The refresh handler read the token expiry before taking the lock, so two requests arriving within the same millisecond could both decide the token had expired and both call the identity provider. The second call invalidated the first token, and the first request then failed with a 401.

This change moves the expiry check inside the lock and adds a test that fires 50 concurrent refreshes against a fake provider. Before the fix the test failed on roughly one run in five; after it, 500 consecutive runs passed.

No config changes. The lock is per session, so throughput for different sessions is unaffected.` },

{ id: "pr-02", kind: "pr", text: `Add retry with jitter to the webhook sender

- Retry 5xx and connection resets up to 4 times, with exponential backoff starting at 200 ms and full jitter.
- Do not retry 4xx responses; they are logged and dropped as before.
- Record each attempt in the \`webhook_attempts\` table so support can see why a delivery failed.
- Add \`WEBHOOK_MAX_ATTEMPTS\` to the config, defaulting to 5.

Tested against the staging receiver with a fault injector returning 503 on half of the requests. All 2,000 test deliveries arrived; the median added latency was 340 ms.` },

{ id: "pr-03", kind: "pr", text: `Remove the legacy CSV export path

The CSV exporter in \`reports/legacy_export.py\` has had no callers since the reporting service moved to Parquet in March. Grafana shows zero requests to \`/export/csv\` over the last 90 days, and the two internal scripts that used it were migrated in #4121.

This PR deletes the module, its tests and the route. It also drops the \`pandas\` pin that only this module needed, which shrinks the image by 48 MB.

If anyone still needs CSV, \`parquet-tools csv\` converts the new files in one command.` },

{ id: "pr-04", kind: "pr", text: `Bump the Postgres driver to 3.2 and fix the timestamp regression

Upgrading psycopg from 3.1 to 3.2 changed how naive datetimes are bound: 3.2 sends them as \`timestamp\` instead of \`timestamptz\`, so rows written from the worker were stored in local time. The fix makes every datetime we bind timezone-aware at the repository layer.

Changes:

1. \`db/bind.py\`: convert naive datetimes to UTC before binding, and raise in tests if a naive value reaches the driver.
2. \`worker/jobs.py\`: replace the three \`datetime.now()\` calls with \`datetime.now(tz=UTC)\`.
3. A migration that corrects the 1,812 rows written between the deploy and the rollback, using the audit log to recover the original offset.

The migration is idempotent and runs in under a second on a production snapshot.` },

{ id: "pr-05", kind: "pr", text: `Cache the feature-flag lookup per request

Every call to \`flags.enabled()\` hit Redis, and the checkout page makes 31 of them. This change reads all flags for the tenant once at the start of the request and serves later lookups from that snapshot.

A flag flipped mid-request now takes effect on the next request instead of partway through, which is the behaviour the product team asked for in the incident review.

p95 latency for \`/checkout\` drops from 410 ms to 290 ms in the load test. Redis operations per checkout drop from 31 to 1.` },

{ id: "design-01", kind: "design", text: `# Tenant isolation for the search index

## Problem

All tenants share one Elasticsearch index, and isolation depends on every query carrying a \`tenant_id\` filter. Two incidents this year were caused by a code path that built a query without it. We want isolation that does not depend on every caller getting the filter right.

## Options

**Index per tenant.** Simple to reason about and trivially isolated. We have 3,400 tenants, though, and most of them have fewer than 1,000 documents; a cluster with that many small indices wastes heap on shard overhead.

**Filtered aliases.** One alias per tenant, each with the tenant filter baked in. Callers query the alias, never the index. Isolation moves from every query to alias creation, which happens in one place. Alias count has no meaningful cost.

**Document-level security.** Requires a Platinum licence we do not have.

## Recommendation

Filtered aliases. The query builder will refuse to target the raw index, and a nightly job will check that every tenant has exactly one alias with the right filter. Migration needs no reindex: we create the aliases, switch the query builder, and then remove read access to the raw index from the application role.` },

{ id: "design-02", kind: "design", text: `# Rate limiting at the edge

We currently rate limit in the API service, after authentication, using a fixed window per API key. This has two weaknesses. Unauthenticated floods still reach the service and consume connection slots, and the fixed window allows a burst of twice the limit at each window boundary.

The proposal is to add a token-bucket limiter in the Envoy layer keyed on client IP for unauthenticated routes, and to replace the fixed window in the service with a sliding-window counter keyed on API key. The Envoy limiter uses the existing global rate-limit service, so no new infrastructure is needed.

Limits start at 20 requests per second per IP for \`/login\` and \`/signup\`, and 600 per minute per key for authenticated routes, which is the current limit. We will run the new limiter in shadow mode for a week, logging what it would have rejected, before enforcing it.

The main risk is customers behind a shared NAT, such as a university, hitting the IP limit on login. The shadow week will tell us how often that happens; if it is common we will raise the limit for known NAT ranges rather than drop the IP limit.` },

{ id: "design-03", kind: "design", text: `## Choosing a queue for the notification service

We need a queue between the API and the notification workers. The workload is about 2 million messages a day with peaks of 400 per second, messages must not be lost, and ordering only matters per user.

SQS meets the durability requirement and needs no operations work. FIFO queues give per-user ordering through message group IDs, at a throughput limit of 3,000 messages per second with batching, which is well above our peak.

RabbitMQ would give us lower latency, but we would have to run and patch it, and nobody on the team has operated it in production.

Kafka fits large fan-out and replay, neither of which we need. The partition count would also have to be planned around users, which is awkward.

I recommend SQS FIFO. The one thing it does not give us is replay, and the notification log in Postgres already covers the cases where we would want it.` },

{ id: "design-04", kind: "design", text: `# Estimating p99 latency from sampled traces

We sample 1% of traces, and the dashboard computes p99 from the sample. For low-traffic endpoints the sample is small enough that the estimate jumps around by hundreds of milliseconds from one hour to the next.

Two changes would help. First, compute the percentile from the histogram metrics that every request records, not from traces; the histograms are exact up to bucket width. Second, where we still need trace-based estimates, use the Harrell-Davis estimator instead of the nearest-rank method. It is a robust estimator for small samples: it weights every order statistic rather than picking one, so a single slow outlier moves it less.

For endpoints with fewer than 200 sampled requests an hour, the dashboard should show the histogram value and grey out the trace-based one.` },

{ id: "chat-01", kind: "chat", text: `The 403 comes from the bucket policy, not from IAM. Your role has \`s3:GetObject\` on the bucket, but the bucket policy has an explicit deny for any request that does not come through the VPC endpoint, and an explicit deny always wins over an allow.

Running the same command from your laptop goes over the public internet, so the condition \`aws:SourceVpce\` does not match and the deny applies. From a pod in the cluster it works because traffic goes through the endpoint.

If you need to read from outside the VPC, add your role's ARN to the \`aws:PrincipalArn\` exception in the deny statement, or use the bastion.` },

{ id: "chat-02", kind: "chat", text: `Yes, you can drop the index, but do it in two steps.

First, check that nothing uses it: \`pg_stat_user_indexes\` shows \`idx_scan = 0\` for \`orders_customer_created_idx\` since the stats were last reset on 2 September, which covers a month of traffic including the quarter-end batch. That is good evidence.

Second, drop it with \`DROP INDEX CONCURRENTLY\` so the table is not locked. A plain \`DROP INDEX\` takes an access exclusive lock and will block writes to \`orders\` until it finishes.

Keep the \`CREATE INDEX\` statement in the migration's down step in case you need it back.` },

{ id: "chat-03", kind: "chat", text: `The test is flaky because it depends on dictionary ordering in the fixture. \`build_payload()\` iterates over \`user.roles\`, which is a set, and the assertion compares the resulting list to a literal. Python randomises set iteration order for strings between interpreter runs unless \`PYTHONHASHSEED\` is fixed, so the list comes out in a different order on some runs.

Sort the roles before building the payload, or compare with \`assertCountEqual\` in the test. I would sort in \`build_payload()\`, because the downstream service also diffs the payload and will report spurious changes otherwise.` },

{ id: "chat-04", kind: "chat", text: `Short answer: it is the connection pool, not the database.

The service has a pool of 10 connections and the slow endpoint holds a connection while it calls the pricing API, which takes up to 2 seconds. Under load all 10 connections end up waiting on pricing, and every other request queues behind them. That is why unrelated endpoints slow down at the same time.

Release the connection before the external call. The handler only needs the database for the lookup at the start and the write at the end, so split it into two short transactions.` },

{ id: "chat-05", kind: "chat", text: `I checked the three places you mentioned.

The cron job in \`ops/cron.yaml\` runs at 02:00 UTC, which is 03:00 in London during winter and 04:00 during summer time, so the "it moved by an hour" report lines up with the clock change on 27 October.

The export script reads the same schedule and has the same behaviour.

The dashboard converts to the viewer's local time, so it looked unchanged to anyone in the US and an hour late to anyone in Europe.

If the job must run at a fixed London time, set \`timeZone: Europe/London\` on the CronJob; Kubernetes has supported that field since 1.27.` },

{ id: "email-01", kind: "email", text: `Hi Priya,

The migration is scheduled for Saturday 14 June from 06:00 to 08:00 UTC. During that window the reporting dashboard will be read-only; the API and the customer app are not affected.

We have rehearsed it twice on a copy of production. Both runs finished in 52 minutes, so the window has an hour of slack. If anything goes wrong we roll back by repointing DNS to the old cluster, which takes about five minutes.

Could you let your team know, and tell me by Thursday if the window clashes with anything on your side?

Thanks,
Sam` },

{ id: "email-02", kind: "email", text: `Hi Marco,

Thanks for sending the logs. The failed uploads all have a file size just over 100 MB, and our upload endpoint rejects anything above that limit with a 413. The client shows that as a generic network error, which is why it looked intermittent.

Two options: we can raise your account's limit to 500 MB today, or your team can switch to the multipart upload endpoint, which has no size limit and resumes after a dropped connection. The second is the better long-term fix if your files keep growing.

Let me know which you prefer and I will set it up.

Best,
Dana` },

{ id: "email-03", kind: "email", text: `Hello team,

A summary of yesterday's planning session, for those who could not attend.

We agreed to ship the billing export in the 3.4 release rather than 3.3. The finance team needs the VAT breakdown in the same file, and adding it to 3.3 would have pushed that release by two weeks.

Ahmed owns the export and will have a draft schema by Friday. Lena will review it with finance on Monday.

The search work stays in 3.3 as planned.

Ivan` },

{ id: "email-04", kind: "email", text: `Hi Jo,

I can't make the Tuesday review; I'm at the customer site all day. Wednesday or Thursday after 14:00 both work for me.

In the meantime I've left comments on the draft. The main one is on the retention section: the doc says we keep raw events for 13 months, but the DPA we signed with Acme says 12, so one of them needs to change before legal sees it.

Thanks,
Rob` },

{ id: "incident-01", kind: "incident", text: `# Incident 2024-031: checkout errors for EU customers

## Summary

From 09:12 to 09:58 UTC on 11 April, 18% of checkout requests from EU customers failed with a 502. No orders were lost; customers saw an error and most retried successfully.

## Cause

A config change at 09:10 reduced the upstream timeout for the payments service from 10 seconds to 1 second. The change was intended for the staging environment only, but the Helm values file it edited is shared between staging and the EU production cluster. Payment authorisations in the EU take longer than in the US because of 3-D Secure, and about a fifth of them exceeded 1 second.

## Timeline

- 09:10 config change merged and deployed
- 09:14 error-rate alert fired
- 09:31 on-call engineer linked the errors to the timeout
- 09:58 change reverted; error rate back to baseline by 10:01

## Follow-up

Split the shared values file so staging changes cannot reach production, and add the payments timeout to the list of settings that need a second reviewer.` },

{ id: "incident-02", kind: "incident", text: `Postmortem: disk full on the primary database

At 03:40 the primary's data volume reached 100% and Postgres stopped accepting writes. The cause was WAL accumulation: a logical replication slot created for a data-warehouse trial in June had no consumer after the trial ended, so Postgres kept every WAL segment since then. The volume had been growing by about 6 GB a day, and the disk alert threshold was set at 95%, which left less than a day of warning at that rate. The alert fired at 21:10 the previous evening but was routed to a channel nobody watches overnight.

We dropped the slot, which freed 410 GB within a minute, and writes resumed at 04:05.

Actions: monitor replication slot lag and alert when any slot falls more than 10 GB behind; route the disk alert to the paging rotation; and add slot cleanup to the checklist for ending a data trial.` },

{ id: "incident-03", kind: "incident", text: `## What happened

The nightly invoice job sent duplicate invoices to 214 customers on 3 May. The job runs in two pods for redundancy and uses a database row as a lock. A schema migration that morning renamed the lock table, and the job's fallback when it cannot find the lock table is to proceed without a lock, so both pods processed the full batch.

## Why it was not caught

The fallback was added two years ago to keep the job running during a different migration and was never removed. No test covers the case where the lock table is missing.

## Fixes

The job now fails if it cannot take the lock. We sent a correction email to the affected customers on 4 May and voided the duplicate invoices in the billing system.` },

{ id: "code-01", kind: "code", text: `The error comes from the generic bound on \`process\`. You declared it as:

\`\`\`rust
fn process<T: Serialize>(item: T) -> Result<(), Error>
\`\`\`

but you call it with \`&record\`, so \`T\` is \`&Record\`. \`Serialize\` is implemented for references to serializable types, so that part compiles. The problem is the \`'static\` requirement that \`tokio::spawn\` adds when you move \`item\` into the task: a borrowed \`&Record\` does not live long enough.

Either clone the record before spawning:

\`\`\`rust
let owned = record.clone();
tokio::spawn(async move { process(owned).await });
\`\`\`

or change \`process\` to take \`Arc<Record>\` if the record is large and you call this often. Cloning is fine for the 200-byte records in your example.` },

{ id: "code-02", kind: "code", text: `Here is why the query is slow and how to fix it.

\`\`\`sql
SELECT * FROM events WHERE lower(email) = 'a@b.com' ORDER BY created_at DESC LIMIT 20;
\`\`\`

The index is on \`email\`, but the query filters on \`lower(email)\`, so Postgres cannot use it and scans all 40 million rows. Create an expression index instead:

\`\`\`sql
CREATE INDEX CONCURRENTLY events_lower_email_created_idx
  ON events (lower(email), created_at DESC);
\`\`\`

With \`created_at\` as the second column the index also satisfies the \`ORDER BY\`, so Postgres reads the first 20 matching entries and stops. On a copy of the table this took the query from 9.2 seconds to 3 ms.

You can drop the old \`events_email_idx\` afterwards if nothing else filters on the raw column; check \`pg_stat_user_indexes\` first.` },

{ id: "code-03", kind: "code", text: `The hook re-renders forever because the dependency array contains an object that is created on every render:

\`\`\`tsx
const options = { pageSize: 50, sort: "name" };
useEffect(() => { fetchUsers(options).then(setUsers); }, [options]);
\`\`\`

\`options\` is a new object each time, so React sees a changed dependency, runs the effect, \`setUsers\` triggers a render, and the cycle repeats.

Move the object out of the component if it never changes, or wrap it in \`useMemo\` if it depends on props:

\`\`\`tsx
const options = useMemo(() => ({ pageSize, sort }), [pageSize, sort]);
\`\`\`

The ESLint rule \`react-hooks/exhaustive-deps\` will not catch this, because the dependency is listed; it only checks that dependencies are present, not that they are stable.` },

{ id: "code-04", kind: "code", text: `The function is quadratic because \`list.remove(x)\` searches the list from the start each time:

\`\`\`python
for item in to_delete:
    items.remove(item)
\`\`\`

With 50,000 items and 20,000 deletions that is about a billion comparisons. Build a set of what to delete and filter once:

\`\`\`python
drop = set(to_delete)
items = [i for i in items if i not in drop]
\`\`\`

This is linear and finishes in about 30 ms on your data. It does change one behaviour: \`remove\` deletes only the first occurrence of a duplicate, while the filter deletes every occurrence. From your description that is what you want, but check whether \`items\` can contain duplicates you meant to keep.` },

{ id: "code-05", kind: "code", text: `The Terraform plan wants to replace the database because \`engine_version\` changed from "14.9" to "14", and the AWS provider treats a change to that attribute as an in-place upgrade only when the new value is higher. "14" is parsed as lower than "14.9", so it plans a replacement.

Set the value back to the exact version the instance runs:

\`\`\`hcl
engine_version = "14.9"
\`\`\`

If you want minor upgrades to happen automatically, keep the exact version in code, set \`auto_minor_version_upgrade = true\`, and add \`engine_version\` to \`lifecycle.ignore_changes\` so Terraform does not fight AWS when it upgrades the instance.

Always read the plan for \`must be replaced\` on stateful resources before you apply.` },

{ id: "explain-01", kind: "chat", text: `Kubernetes kills the pod because the container exceeds its memory limit, not because the node runs out of memory. The limit is 512 MiB, and the JVM sizes its heap from the container's memory by default: with \`-XX:MaxRAMPercentage=75\` the heap can grow to 384 MiB. Metaspace, thread stacks, the code cache and direct buffers sit outside the heap and take the rest. Netty's direct buffers alone reach 150 MiB under load in your heap dump.

Lower \`MaxRAMPercentage\` to 60, cap direct memory with \`-XX:MaxDirectMemorySize=96m\`, or raise the limit to 768 MiB. I would raise the limit: the service is already close at idle, and squeezing the heap will show up as longer GC pauses.` },

{ id: "explain-02", kind: "chat", text: `A Keycloak realm is the unit of isolation: users, clients, roles and identity providers all belong to one realm, and a user in one realm cannot log in to a client in another. You are seeing "client not found" because the frontend is configured for the \`master\` realm while the client was created in the \`app\` realm.

Change the issuer URL in the frontend config from \`/realms/master\` to \`/realms/app\`. Do not create application clients in \`master\`; that realm is for administering Keycloak itself, and anyone with admin rights there can manage every other realm.` },

{ id: "explain-03", kind: "chat", text: `The PDF prints with the table cut off because the page is set to portrait and the table is 1,400 pixels wide. Switch the print stylesheet to landscape orientation for that report:

\`\`\`css
@page report { size: A4 landscape; }
.report { page: report; }
\`\`\`

Chrome and Edge support named pages; Firefox ignores the \`page\` property and prints everything in the default orientation, so if your users print from Firefox you will need to generate the PDF on the server instead. We already do that for invoices with Puppeteer, so the same job could render this report.` },

{ id: "explain-04", kind: "chat", text: `For the bank covenant the relevant number is the leverage ratio, net debt divided by EBITDA over the trailing twelve months. The spreadsheet computes it from the quarterly figures but uses gross debt, which overstates it: cash on the balance sheet of 4.1 million should be subtracted.

With net debt the ratio is 2.6, below the covenant ceiling of 3.0. With gross debt it is 3.2, which is why the model flagged a breach. Fix the formula in cell F14 to subtract the cash line, and the warning goes away.` },

{ id: "explain-05", kind: "chat", text: `The build is slower on CI than on your machine because the CI runners do not keep the Gradle cache between jobs. Each job downloads every dependency and recompiles every module from scratch, which accounts for about 6 of the 9 minutes.

Enable the remote build cache that the platform team runs; the URL is in the internal wiki under "Gradle cache". With it, a job that touches one module only recompiles that module and its dependents. The Android team saw their median build drop from 11 minutes to 3 after turning it on.

You also need to set \`org.gradle.caching=true\` in \`gradle.properties\`, which is off in this repo.` },

{ id: "explain-06", kind: "chat", text: `The two numbers differ because they measure different things. The load balancer reports time from the first byte of the request to the last byte of the response, including the time the client takes to send a large upload. The application reports time from when the framework has the full request to when it hands off the response.

For the upload endpoint, clients on slow connections take several seconds to send a 20 MB file, and all of that shows up in the load balancer's number. The application's p95 of 180 ms is the one to use for server performance; the load balancer's number is the one to use for what users experience.` },

{ id: "explain-07", kind: "chat", text: `The following steps reproduce the bug on a clean checkout:

1. Run \`make seed\` to load the fixture tenants.
2. Log in as \`admin@tenant-b.test\` and open the billing page.
3. Switch the tenant selector to tenant A without reloading.

The page keeps showing tenant B's invoices, because the invoice query is cached by user ID instead of by user and tenant. The fix is to include the tenant in the cache key in \`useInvoices\`. I have a patch ready if you want it in this PR.` },

{ id: "explain-08", kind: "chat", text: `Note that the \`--force\` flag also skips the pre-upgrade hook, so the migration job will not run. That is why the new pods crash with "relation does not exist": they start against the old schema.

Run the upgrade without \`--force\`. If you added it because the previous release was stuck in \`pending-upgrade\`, clear that state with \`helm rollback\` to the last good revision first, then upgrade normally. The hook will run the migrations, and the deployment will wait for the job to finish.` },

{ id: "explain-09", kind: "chat", text: `There are a number of ways to get the commit into the release branch, but cherry-picking is the right one here. The release branch has diverged by 140 commits, so merging main would pull in features that have not been through QA, and rebasing a shared branch would rewrite history that three other people have checked out.

\`\`\`bash
git checkout release/2.8
git cherry-pick -x 4f2a91c
\`\`\`

The \`-x\` flag records the original commit hash in the message, which makes it easy to see later that the fix exists on both branches.` },

{ id: "explain-10", kind: "chat", text: `The service reads its configuration from various sources in a fixed order: built-in defaults, then \`config.yaml\`, then environment variables, then command-line flags. A later source overrides an earlier one, key by key.

Your \`LOG_LEVEL=debug\` environment variable is being overridden by the \`--log-level=info\` flag in the Helm chart's args. Remove the flag from \`values.yaml\` or set the level through the chart's \`logLevel\` value, which feeds the flag, and the environment variable is no longer needed.` },

{ id: "explain-11", kind: "chat", text: `The cache hit rate is fairly low, 38%, because the key includes the full query string and the frontend appends a timestamp parameter to every request to defeat browser caching. Every request therefore has a unique key.

Strip the \`_t\` parameter before computing the key. The CDN supports this with a cache-key policy that ignores named query parameters, so it is a config change, not a code change. The same change on the image CDN last year took its hit rate from 41% to 93%.` },

{ id: "explain-12", kind: "chat", text: `Your regex fails on the second line because \`.\` does not match a newline by default, so \`BEGIN.*END\` cannot span lines. Add the \`s\` flag (\`re.DOTALL\` in Python), or use \`[\\s\\S]*\` if you want the pattern to work the same way in a language without the flag.

Also make the quantifier lazy, \`.*?\`, otherwise a file with two blocks matches from the first \`BEGIN\` to the last \`END\` as one match. Your sample has two blocks, so that would have been the next surprise.` },

{ id: "review-01", kind: "chat", text: `I reviewed the payment retry PR. Two things need to change before it merges, and one is optional.

The retry loop catches every exception, including \`CardDeclined\`. A declined card should not be retried; retrying it three times can trigger the issuer's fraud checks and get the customer's card blocked. Catch only the transient errors: timeouts, connection resets and 5xx responses.

The idempotency key is generated inside the loop, so each retry is a new payment as far as the provider is concerned. Generate it once, before the loop.

Optional: the backoff is a fixed 1 second. Exponential backoff with jitter would spread retries out if the provider has a wider outage.` },

{ id: "review-02", kind: "chat", text: `The migration looks right. It adds the column as nullable, backfills in batches of 10,000 rows, and only then adds the \`NOT NULL\` constraint, so the table is never locked for long.

One problem: the backfill uses \`OFFSET\` for pagination. On a 30-million-row table, later batches have to skip over every earlier row, so the last batches will take minutes each. Paginate on the primary key instead, \`WHERE id > :last_id ORDER BY id LIMIT 10000\`, and each batch costs the same.

The constraint is added with \`NOT VALID\` and then validated, which avoids the full lock. Good.` },

{ id: "status-01", kind: "chat", text: `Status of the search migration as of this morning:

Indexing of the historical documents finished overnight: 41.2 million documents in 7 hours, with 312 failures, all caused by attachments over the 100 MB limit. Those are listed in \`failed.csv\` and I will retry them with text extraction only.

Dual-write has been running for three days with no divergence between the old and new indexes on the hourly comparison job.

The remaining step is switching reads. I would like to do that on Tuesday at 10:00, with the old cluster kept warm for a week in case we need to switch back.` },

{ id: "status-02", kind: "chat", text: `I finished the dependency audit. Of the 212 direct dependencies, 9 have known vulnerabilities. Seven are fixed by a minor version bump and I have opened PRs for them. The other two need attention:

- \`xml2js\` 0.4 has a prototype pollution issue fixed only in 0.5, which changes the default parsing options. The two places we use it pass explicit options, so the upgrade should be safe, but it needs a test run against the partner feed.
- \`request\` is deprecated and will not be patched. It is used only by the legacy importer; replacing it with \`undici\` is about a day's work.

Nothing on the list is reachable from unauthenticated endpoints.` },

{ id: "howto-01", kind: "chat", text: `To rotate the signing key without logging everyone out, publish the new key before you start signing with it.

1. Generate the new key pair and add its public key to the JWKS endpoint alongside the current one.
2. Wait for longer than the JWKS cache lifetime, which is 10 minutes for our services, so every verifier has fetched both keys.
3. Switch the issuer to sign with the new key.
4. After the longest token lifetime has passed (24 hours for refresh tokens), remove the old public key from the JWKS.

If you swap keys in one step, every service that has the old JWKS cached will reject new tokens until its cache expires.` },

{ id: "howto-02", kind: "chat", text: `You can restore a single table from the nightly backup without touching the rest of the database.

\`\`\`bash
pg_restore --list backup.dump | grep 'TABLE DATA public invoices' > invoices.list
pg_restore -d staging_restore -L invoices.list backup.dump
\`\`\`

Restore into a scratch database first, not production. Then copy the rows you need with \`INSERT ... SELECT\` over \`dblink\`, or dump just those rows with \`COPY\` and load them. Restoring straight into production would replace the whole table, including the rows written since the backup.` },

{ id: "summary-01", kind: "chat", text: `I read through the three RFCs on the event schema. They agree on the envelope fields and disagree on two points.

RFC 12 puts the tenant ID in the envelope; RFC 14 puts it in the payload so that the envelope stays tenant-agnostic. RFC 15 does not address it. The envelope is the better place, because the router needs the tenant to pick a partition and should not have to parse payloads.

RFC 12 and 15 version the schema with an integer; RFC 14 uses semver. Consumers only need to know whether they can read an event, which an integer major version answers. I would go with the integer.` },

{ id: "summary-02", kind: "chat", text: `The benchmark results are in \`bench/results-0611.json\`. In summary: the new allocator is faster for small objects and slower for large ones.

For allocations under 256 bytes, which are 94% of allocations in the production trace, it is 22% faster on average. For allocations over 64 KB it is 9% slower, because it does not keep a free list for that size class and goes to the OS each time. Overall the trace replays 15% faster.

If the large-allocation regression matters, adding a size class for 64 KB to 1 MB would likely close most of it; that is a small change.` },

{ id: "onboard-01", kind: "chat", text: `Welcome to the team. Your first week is mostly setup and reading, so you can take it at your own pace.

The repo README covers the local environment; it takes about an hour if Docker is already installed. After that, read the architecture doc in \`docs/architecture.md\`, which is short and up to date as of last month.

Your onboarding ticket is PLAT-2211, a small bug in the CLI's \`--json\` output. It touches the command parser and the output formatter, which are the two parts of the codebase you will work in most. Ask in #platform-help if you get stuck; someone usually answers within the hour.` },

{ id: "answer-01", kind: "chat", text: `It depends on whether the column is ever null in the existing data. If it is, adding \`NOT NULL\` will fail on the first null row, and you need to backfill a value first. If it is not, you can add the constraint directly, but on Postgres 12 and later add it as a \`CHECK (col IS NOT NULL) NOT VALID\` constraint, validate it, and then set \`NOT NULL\`; Postgres uses the validated check to skip the full table scan.

Run \`SELECT count(*) FROM accounts WHERE region IS NULL\` to find out which case you are in.` },

{ id: "answer-02", kind: "chat", text: `Yes, the change is safe to deploy during business hours. It only adds a new endpoint and a new table; nothing existing reads the table yet, and the migration creates it without touching other tables.

The one thing to check is the feature flag. The endpoint is behind \`billing_v2\`, which is off for every tenant in production, so customers will not see it until we turn the flag on. I confirmed that in the flag dashboard a few minutes ago.` },

{ id: "answer-03", kind: "chat", text: `The memory grows because the LRU cache has no size limit: \`@lru_cache\` with \`maxsize=None\` keeps every result forever, and the function is called with a new timestamp argument on every request, so nothing is ever reused.

Either drop the timestamp from the arguments if it does not affect the result, or set \`maxsize=1024\`. Looking at the function, the timestamp is only used for logging, so removing it from the signature fixes both the leak and the zero hit rate.` },

{ id: "answer-04", kind: "chat", text: `The deploy failed at the image pull step. The new tag, \`2.14.0\`, exists in the staging registry but was never pushed to production, because the release pipeline's promote stage was skipped: the pipeline was started with \`SKIP_PROMOTE=true\` left over from Friday's hotfix.

Rerun the promote stage for 2.14.0, then retry the deploy. To stop this happening again, I can make the pipeline fail when \`SKIP_PROMOTE\` is set on a run that targets production.` },

{ id: "answer-05", kind: "chat", text: `You are right that the docs and the code disagree. The docs say the timeout is 30 seconds, but \`client.py\` sets it to 300, and the change was made deliberately in 2022 to support large report exports. The docs were never updated.

I have opened a PR that updates the docs to 300 seconds and explains why it is that high. If 300 is too long for interactive calls, the better fix is a separate timeout for the export endpoint, and I can do that next.` },
];
