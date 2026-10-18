import type { Doc } from "./clean-corpus.js";
// Batch 4: longer realistic documents (PR template with 8+ sentences, design docs, a long answer).
export const CLEAN4: Doc[] = [
{ id: "prl-01", kind: "pr", text: `## Summary

Moves invoice PDF generation out of the request path and into a background job. Generating a PDF takes between 2 and 9 seconds, and the API held the request open the whole time, so large invoices regularly hit the 10-second gateway timeout.

## Changes

- \`POST /invoices/:id/pdf\` now enqueues a job and returns 202 with a job ID.
- A new \`GET /jobs/:id\` endpoint reports the job's status and, when it is done, a signed URL for the PDF.
- The worker renders the PDF with the same template code as before and uploads it to the invoices bucket.
- The web app polls the job endpoint every two seconds and shows a spinner until the PDF is ready.

## Testing

I added unit tests for the job handler and an integration test that runs the whole flow against a local worker. On staging, the largest invoice we have, 1,400 line items, renders in 8.7 seconds and no request times out.

## Rollout

The old synchronous endpoint stays available behind the \`sync_pdf\` flag for one release, in case a customer integration depends on getting the PDF in the response.` },

{ id: "prl-02", kind: "pr", text: `## Context

Search results for users with many saved filters took several seconds to load. Profiling showed the time was spent in \`loadFilters\`, which ran one query per filter.

## Change

\`loadFilters\` now fetches all of a user's filters in one query and builds the filter objects in memory. I also added an index on \`saved_filters (user_id)\`, which the old code did not need because it looked filters up by primary key.

## Results

For a user with 120 saved filters, the search page now loads in 300 ms instead of 4.1 seconds. For users with a handful of filters the difference is too small to measure.

## Notes for reviewers

The migration creates the index concurrently, so it does not lock the table. The query returns filters in creation order, which matches what the old code produced, so the order in the sidebar does not change. Please check the test for the empty case; I was not sure whether a user with no filters should get an empty list or a 404, and went with the empty list.` },

{ id: "dsl-01", kind: "design", text: `# Audit log storage

## Background

The audit log records every administrative action: who did it, when, from which IP address, and what changed. It is stored in the main Postgres database, in a table that has grown to 900 million rows and 600 GB. It is the largest table in the database and the main reason backups take four hours.

Audit data has an unusual access pattern. It is written constantly and almost never read; when it is read, it is usually by a compliance export covering one customer over a date range, or by support looking at the last few days of one account.

## Requirements

Audit records must be kept for seven years, must not be editable by anyone with application access, and must be exportable per customer within a day of a request. Writes must not slow down the actions they record.

## Proposal

Write audit events to a Kinesis stream instead of Postgres. A consumer batches them into Parquet files partitioned by customer and day and writes them to an S3 bucket with Object Lock in compliance mode, which makes the files immutable for the retention period. Athena queries the bucket for exports and for support lookups.

The last 30 days stay in Postgres as well, in a much smaller table, so the support tool's existing queries keep working and stay fast.

## Costs and risks

Storage in S3 costs about a tenth of what the same data costs in Postgres, and removing the table cuts backup time to under an hour. The main risk is losing events between the API and the stream. The API will write to the stream synchronously and fail the action if the write fails, which is the same guarantee the current database write gives.

## Migration

Backfill the existing rows into S3 with a one-off job, verify the counts per customer and day against Postgres, and then drop the old table. The backfill can run at low priority over a week.` },

{ id: "dsl-02", kind: "design", text: `# Replacing the homegrown feature-flag service

## Why now

The flag service was written in 2019 as a small Flask app backed by a single Postgres table. It now serves 40,000 evaluations per second and has caused two outages this year, both because the cache in front of the table expired at the same moment on every pod and the database could not absorb the load.

## Options considered

We could keep the service and fix the cache stampede with jittered expiry and request coalescing. That fixes the outages but leaves us maintaining a service that one engineer understands, with no audit trail for flag changes and no percentage rollouts.

We could adopt a hosted vendor. The two we evaluated both support percentage rollouts, targeting rules and audit logs, and both offer SDKs that evaluate flags locally from a streamed rule set, so a vendor outage does not stop evaluation. The cost is about 30,000 dollars a year at our volume.

We could run an open-source server such as Unleash ourselves. It has the features we need, but we would be operating another stateful service.

## Recommendation

Adopt the hosted vendor with local evaluation. The yearly cost is less than the time we spent on the two outages, and local evaluation removes the flag service from the request path entirely.

## Plan

Wrap the existing client calls behind an interface, add a vendor implementation, and run both side by side for two weeks, logging any evaluation where they disagree. Once the disagreement count is zero, switch reads to the vendor and retire the old service.` },

{ id: "long-01", kind: "chat", text: `**Cause:** the worker reads \`MAX_BATCH\` as a string, so \`"500" > 100\` compares as strings and the batch-size guard never triggers.

**Fix:** parse it with \`int()\` when loading the config, and validate it at startup so a bad value fails fast.

**Workaround until it ships:** set \`MAX_BATCH\` in the Helm values to a number without quotes; YAML then passes it as an integer and the comparison works.

The guard was added in March and has never worked in production, so batches of up to 5,000 rows have been going to the API, which explains the occasional 413 errors in the logs.` },

{ id: "long-02", kind: "incident", text: `# Incident review: login failures on 2 September

## Summary

Between 14:05 and 14:47 UTC, about 30% of login attempts failed with "invalid session". Users who were already logged in were not affected. The cause was a configuration change that pointed half of the auth pods at a Redis instance that did not have the session data.

## Detection

The login error-rate alert fired at 14:09. The on-call engineer saw that the errors came only from some pods, which pointed at a configuration difference, but it took until 14:40 to find it, because the change had been applied by an automated rollout that did not post to the deploy channel.

## Root cause

A platform change replaced the Redis connection string in the shared config map with a reference to a new managed Redis cluster. Only pods that restarted after the change picked up the new value. The new cluster was empty, so sessions created on old pods could not be found by new pods.

## Fix

We reverted the config map and restarted the auth pods, and logins recovered by 14:47. The new Redis cluster will be populated by dual-writing sessions for a day before any pod reads from it.

## Follow-up

Automated rollouts will post to the deploy channel. Config map changes that affect the auth service will need a review from the identity team.` },
];
