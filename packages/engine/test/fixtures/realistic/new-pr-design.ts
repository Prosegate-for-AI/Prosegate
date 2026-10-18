import type { Doc } from "./clean-corpus.js";
// Round-2 clean corpus, part 1: PR bodies in five templates (3 each) and design docs (8).
export const NEW_PR_DESIGN: Doc[] = [
// ---- PR: Claude Code default (## Summary bullets, ## Test plan checklist, footer)
{ id: "n-prcc-1", kind: "pr", text: `## Summary
- Replace the hand-rolled CSV writer in \`reports/export.py\` with the standard library \`csv\` module
- Quote fields that contain commas, quotes or newlines, which the old writer emitted raw
- Add a regression test built from the three customer files that broke last week
- Stream rows to the response instead of building the whole file in memory

## Test plan
- [x] \`pytest tests/reports\` passes locally
- [x] Exported the three failing customer reports and opened them in Excel and LibreOffice
- [ ] Check memory on the 400k-row export in staging after deploy

🤖 Generated with [Claude Code](https://claude.com/claude-code)` },
{ id: "n-prcc-2", kind: "pr", text: `## Summary
- Add a \`--dry-run\` flag to \`bin/rotate-keys\` that prints the keys it would rotate and exits
- Refuse to run without \`--dry-run\` when \`APP_ENV\` is \`production\` and no \`--confirm\` is given
- Log each rotated key ID (never the key) to the audit stream

The script rotated every tenant's signing key in staging on Tuesday because someone ran it to check what it would do. This makes the safe path the default.

## Test plan
- [x] Unit tests for flag parsing and the production guard
- [x] Ran \`--dry-run\` against staging and compared the output with the key table
- [ ] Run a real rotation for the internal tenant after merge

🤖 Generated with [Claude Code](https://claude.com/claude-code)` },
{ id: "n-prcc-3", kind: "pr", text: `## Summary
- Bump \`axios\` from 0.27 to 1.7 across the three frontend packages
- Update the interceptor in \`api/client.ts\`, since 1.x passes \`InternalAxiosRequestConfig\` to request interceptors
- Drop the \`transformResponse\` workaround for JSON dates; the API now returns ISO strings and the components parse them

## Test plan
- [x] Type check and unit tests pass in all three packages
- [x] Clicked through login, the invoice list and the settings page against staging
- [x] Confirmed the 401 refresh flow still retries the original request once

🤖 Generated with [Claude Code](https://claude.com/claude-code)` },
// ---- PR: conventional-commit style, hard-wrapped
{ id: "n-prcv-1", kind: "pr", text: `fix(billing): round proration to the cent before summing

Proration was computed per day in floating point and summed, then
rounded once at the end. For plans billed in yen, which has no minor
unit, the sum drifted by one yen on roughly 3% of mid-cycle upgrades,
and the invoice total no longer matched the line items.

Round each daily amount to the currency's minor unit first, then sum.
Totals now match line items for every invoice in the March backfill.

Refs: BILL-2291` },
{ id: "n-prcv-2", kind: "pr", text: `feat(search): add prefix matching for SKU queries

Support staff search by the first few characters of a SKU, which the
full-text index ignored because it tokenises on word boundaries. Add a
separate \`sku_prefix\` edge n-gram field (2 to 12 characters) and query
it when the input looks like a SKU (letters, digits and dashes only).

The index grows by about 9% on the production snapshot. Query latency
at p95 is unchanged at 38 ms.

BREAKING CHANGE: the \`/search\` response now includes \`match_field\`,
which strict clients that reject unknown keys must allow.` },
{ id: "n-prcv-3", kind: "pr", text: `chore(ci): cache the Gradle wrapper and dependencies

Every Android job downloaded the wrapper and about 600 MB of
dependencies from scratch, which is most of the 11-minute build. Cache
\`~/.gradle/wrapper\` and \`~/.gradle/caches\` keyed on the lockfile hash
and the wrapper properties.

Warm builds now take 4 minutes. A cold build after a lockfile change
takes the same 11 minutes as before, which is expected.` },
// ---- PR: What / Why / How
{ id: "n-prwwh-1", kind: "pr", text: `### What
Moves thumbnail generation out of the upload request and into the existing image worker.

### Why
Uploading a 40 MB RAW file holds the request open for up to 25 seconds while three thumbnail sizes are generated, and the load balancer kills requests at 30 seconds. Support has 14 tickets this month from photographers whose uploads failed on large files.

### How
The upload handler now stores the original, enqueues a \`thumbnail\` job and returns 201 with \`thumbnails: "pending"\`. The worker generates the sizes and patches the record. The gallery shows a placeholder until the thumbnails exist and polls every three seconds for at most a minute.` },
{ id: "n-prwwh-2", kind: "pr", text: `### What
Adds a per-tenant rate limit of 600 requests a minute to the public API, enforced at the gateway.

### Why
One tenant's integration retried in a tight loop on Sunday and pushed the shared database to 95% CPU for forty minutes. The other tenants on that cluster saw timeouts. We had no limit below the global one.

### How
The gateway plugin keeps a sliding-window counter per API key in Redis. Over the limit it returns 429 with a \`Retry-After\` header. Limits live in the tenant settings table, so support can raise one without a deploy. The default is high enough that none of the top 50 tenants would have been limited last month.` },
{ id: "n-prwwh-3", kind: "pr", text: `### What
Deletes the \`legacy_reports\` module and its routes.

### Why
Nothing has called these routes since the reporting rewrite shipped in June; the access logs for the last 90 days show zero requests outside our own health checks. The module pins an old version of \`pandas\` that blocks the Python 3.12 upgrade.

### How
Removed the module, its tests, the three routes and the nightly job that warmed its cache. The health check no longer probes \`/legacy/reports/ping\`. The tables it read stay; dropping them is a separate change once finance confirms they no longer need the archive.` },
// ---- PR: Changes / Testing / Notes
{ id: "n-prctn-1", kind: "pr", text: `**Changes**

- The retry wrapper for outbound webhooks now uses exponential backoff with jitter instead of a fixed five-second delay.
- Retries stop after eight attempts, about 21 minutes in total, and the delivery is marked \`failed\` with the last status code.
- The dashboard shows failed deliveries with a button to resend.

**Testing**

Added unit tests for the backoff schedule and an integration test against a stub endpoint that fails the first five calls. Ran the stub against staging for an hour with 200 deliveries a minute.

**Notes**

Customers whose endpoints were down for more than a few minutes used to receive a burst of retries when they came back. With jitter the retries spread out, so the first successful delivery may arrive up to a minute later than before.` },
{ id: "n-prctn-2", kind: "pr", text: `**Changes**

- Switch the session store from in-process memory to Redis.
- Read the Redis URL from \`SESSION_REDIS_URL\`; the app refuses to start in production without it.
- Remove the sticky-session setting from the load balancer config.

**Testing**

Logged in on one pod, killed it, and confirmed the next request on another pod kept the session. The auth test suite passes with Redis from the compose file.

**Notes**

Everyone will be logged out once when this deploys, since existing sessions live in pod memory. I'd ship it on Monday morning and post in the support channel first.` },
{ id: "n-prctn-3", kind: "pr", text: `**Changes**

- Add a \`created_at\` index on \`audit_events\`.
- Paginate the audit log page by cursor instead of offset.

**Testing**

The audit page for our largest tenant (31 million events) took 9 seconds to load page 200 and now takes 60 ms for any page. Ran \`EXPLAIN ANALYZE\` before and after; the plan now uses the index scan.

**Notes**

The index is created \`CONCURRENTLY\` in its own migration, so it does not lock the table. On the production snapshot it took 14 minutes to build.` },
// ---- PR: plain prose
{ id: "n-prplain-1", kind: "pr", text: `This fixes the timezone bug in the weekly digest. The digest job ran at 08:00 UTC and selected "last week" with \`date_trunc('week', now())\`, so for users in Auckland and Sydney the digest arrived on Monday afternoon and covered a week that, for them, ended a day earlier than they expected.

The job now runs hourly and sends each user's digest at 08:00 in their own timezone, computing the week boundaries in that timezone. Users without a timezone keep the UTC schedule.

I checked it against the six bug reports by replaying their accounts in staging; each now gets the digest at 08:00 local time with the expected date range.` },
{ id: "n-prplain-2", kind: "pr", text: `The mobile app sends the device locale as \`en_US\`, while the web app sends \`en-US\`, and the translation service only understood the second form, so every mobile user fell back to English. This normalises the locale at the API edge, accepting both forms and storing the BCP 47 one.

I also added a test with the twelve locale strings we have seen in production logs over the last month, including \`zh_Hant_TW\` and \`pt_BR\`.

No migration is needed. Existing records already use the hyphenated form because only the web app wrote them until now.` },
{ id: "n-prplain-3", kind: "pr", text: `Upgrade Postgres from 13 to 16 on the analytics replica only. The primary stays on 13 until the replica has run for two weeks without problems.

The replica is rebuilt from a fresh base backup rather than upgraded in place with \`pg_upgrade\`, because it is small enough (380 GB) to rebuild in about three hours and that avoids the extension version checks. The dashboards point at it through the same DNS name, so nothing else changes.

Two of the scheduled reports used \`to_char\` with a format that 16 treats differently; they are updated here and their output is identical to the current reports on last month's data.` },
// ---- Design docs
{ id: "n-dd-1", kind: "design", text: `# Offline mode for the field app

## Problem

Inspectors lose signal in basements and plant rooms, which is where most inspections happen. The app currently needs a connection to load a checklist and to save each answer, so inspectors write on paper and type it up later. About a third of the inspections in the last quarter were entered more than a day after the visit.

## Proposal

Download the checklists for the day's assigned sites when the app opens on Wi-Fi, and store answers locally in SQLite. Each answer carries a client-generated ID and a timestamp. When the device is online, a sync job sends the queued answers in order; the server accepts them idempotently by ID.

## Conflicts

Two inspectors rarely work the same site on the same day, so the server keeps the later answer by timestamp and records the earlier one in the history. We will log every conflict and revisit this if they turn out to be common.

## Out of scope

Photos stay online-only for the first release. They are large, and the storage limits on older devices need their own design.` },
{ id: "n-dd-2", kind: "design", text: `# Moving scheduled jobs from cron to the job queue

## Context

Thirty-one jobs run from a crontab on a single VM. When that VM was replaced in August, nine jobs did not run for two days because the new crontab was copied from an old backup. Nobody noticed until finance asked about the missing invoices.

## Decision

Define each schedule in code next to the job, and let the queue's scheduler enqueue the job at the scheduled time. The scheduler runs on every worker, takes a lock per schedule tick in Redis, and enqueues once. A job that misses its tick because every worker was down runs once when a worker returns, not once per missed tick.

## Consequences

Schedules are reviewed in pull requests and deployed with the code, so they cannot drift from what is in the repository. The VM can be deleted. Alerts move from "the cron email did not arrive" to the queue's failed-job metric, which already pages.

## Alternatives considered

Kubernetes CronJobs would also work, but most of these jobs need the application's code and settings, and starting a pod for a ten-second job costs more than the job itself.` },
{ id: "n-dd-3", kind: "design", text: `# Tenant data export

Customers on the enterprise plan can ask for a full export of their data, and today an engineer runs a script by hand, which takes half a day for large tenants and has twice included another tenant's rows because of a missing filter.

The export will run as a background job started from the admin console. It reads each table through the same tenant-scoped repository layer the application uses, so the tenant filter is applied in one place rather than in every query of a script. Output is one newline-delimited JSON file per table, compressed and written to a bucket with a signed link that expires after seven days.

Large tenants have up to 200 million rows in the events table. The job reads in pages of 10,000 by primary key and checkpoints the last key, so it can resume after a worker restart instead of starting over.

We will test the tenant filter by running the export for a tenant created in the test suite and asserting that every row in every file carries its ID. That test runs in CI on every change to the repository layer.` },
{ id: "n-dd-4", kind: "design", text: `## Summary

Replace the polling loop in the order status page with server-sent events.

## Background

The order page polls \`/orders/:id/status\` every two seconds while an order is in progress. At peak there are about 4,000 open order pages, which is 2,000 requests a second for a value that changes perhaps five times per order. The endpoint is a fifth of our API traffic.

## Design

The API exposes \`/orders/:id/events\` as an SSE stream. When the order service updates an order, it publishes to a Redis channel named after the order. The API process holding the stream subscribes to that channel and forwards each update. The browser's \`EventSource\` reconnects on its own after a dropped connection and sends the last event ID, and the API replays anything newer from the order's history.

## Risks

Each open stream holds a connection on the API pods. At 4,000 streams across six pods that is well under the file-descriptor limit, but the load balancer's idle timeout of 60 seconds would cut quiet streams, so the API sends a comment line every 20 seconds.` },
{ id: "n-dd-5", kind: "design", text: `# Feature flags: evaluation on the client

Flags are evaluated on the server today, and the web app fetches the evaluated set on page load. That works for page-level flags, but the growth team wants flags that change behaviour within a single-page session and experiments that target attributes the server does not know, such as viewport size.

We propose shipping the flag rules for a tenant to the browser and evaluating them there with the vendor's SDK. The rules include targeting conditions but no user data, so exposing them is acceptable for every flag we have today. Flags whose rules name specific customers stay server-evaluated; the SDK supports marking them so they are never sent to the client.

This adds about 14 KB to the initial bundle, compressed. Evaluation takes under a millisecond per flag on a mid-range phone, measured with the 60 flags we have now.

The risk is that someone later writes a rule containing data we do not want public. The admin console will refuse to save a client-side flag whose rules contain an email address or an account ID, and the review checklist for new flags will say why.` },
{ id: "n-dd-6", kind: "design", text: `# Search ranking for the help centre

## Goal

Readers who search the help centre should find the article that answers their question in the top three results. Today that happens for 54% of searches that end in a click, measured over September.

## Approach

Keep the existing full-text index and add two signals at query time. The first is the click-through rate of each article for the query's terms over the last 90 days, smoothed so new articles are not buried. The second is a boost for articles updated in the last six months, because the support team reports that stale articles about the old billing pages are the most common wrong answer.

## Measurement

Run the new ranking for half of the searches for two weeks. The primary metric is the share of searches whose first click is in the top three; the secondary metric is the share of searches followed by a support ticket within an hour. We stop early if tickets rise by more than 5%.

## Not doing

We considered an embedding-based search. It may come later, but it needs a vector store we do not run, and the click signal alone may close most of the gap.` },
{ id: "n-dd-7", kind: "design", text: `# Retention policy for application logs

Application logs are kept for 400 days in the hot tier of the log store, which costs about $9,000 a month and grows with traffic. Almost every query in the last year looked at the last 14 days; the rest were audits that needed specific fields from older logs.

We will keep 30 days in the hot tier, then move logs to object storage in compressed Parquet, partitioned by day and service, and keep them there for 400 days in total. Queries on archived logs go through the warehouse's external tables, which take minutes rather than seconds but cost little when idle.

Audit-relevant events (logins, permission changes, data exports) already go to the audit table and are not affected.

The saving is about $7,000 a month at current volume. The cost is that an incident older than 30 days needs a warehouse query instead of the log search UI. Security and support signed off on that trade in the review on 3 October.` },
{ id: "n-dd-8", kind: "design", text: `# Splitting the notifications service

## Why now

The notifications service sends email, SMS and push from one process and one queue. A slow SMS provider in September backed up the queue for two hours, and password-reset emails waited behind marketing pushes. Separating the channels is the smallest change that stops one provider from delaying another.

## Plan

Each channel gets its own queue and its own worker deployment, scaled independently. The API that enqueues notifications stays the same; it routes by channel. Password resets and login codes go to a priority queue per channel that workers drain first.

## Migration

Deploy the new workers alongside the old one, route one channel at a time by a flag, and watch delivery latency for a day before moving the next. The old worker is deleted when all three channels have moved.

## Open question

Whether to keep a single provider per channel or add a fallback SMS provider. That depends on the contract renewal in January and is not needed for this split.` },
];
