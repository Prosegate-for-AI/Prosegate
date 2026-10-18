import type { Doc } from "./clean-corpus.js";
// Round-2 clean corpus, part 2: incident write-ups (8) and emails (10).
export const NEW_INC_EMAIL: Doc[] = [
{ id: "n-inc-1", kind: "incident", text: `# Incident: checkout errors, 14 October

## Summary

From 13:05 to 13:47 UTC about 18% of checkout attempts failed with a 502. The cause was a connection pool limit on the payments proxy that a config change halved.

## Timeline

- 12:58 A change to the proxy's Helm values lowered \`maxConnections\` from 200 to 100 while renaming the key.
- 13:05 Error rate on \`/checkout/confirm\` rises above 5% and the on-call is paged.
- 13:31 The on-call finds pool exhaustion warnings in the proxy logs.
- 13:44 The change is reverted.
- 13:47 Error rate returns to its normal 0.2%.

## What went wrong

The rename moved the value under a new key, and the chart's default for the new key is 100. The diff showed the key change but not that the effective value changed.

## Follow-ups

- Render the chart in CI and post the effective values diff on every change to the proxy's values file.
- Alert on pool saturation above 80%, which would have fired twenty minutes before the errors began.` },
{ id: "n-inc-2", kind: "incident", text: `Postmortem: duplicate SMS messages on 9 October

Between 07:10 and 08:25 about 3,200 customers received the same appointment reminder two to four times. No reminders were lost.

The SMS worker acknowledges a job only after the provider's API returns. On the morning of the 9th the provider's API slowed to 40 seconds per call, longer than the queue's 30-second visibility timeout, so the queue handed the same job to another worker while the first was still waiting. Both calls eventually succeeded.

We raised the visibility timeout to five minutes and added an idempotency key, the reminder ID, to each provider call; the provider drops a second message with the same key within 24 hours. Either change alone would have prevented the duplicates.

Support sent an apology to the affected customers that afternoon. We are also adding an alert on provider latency above 10 seconds, so a slowdown is visible before it causes duplicates.` },
{ id: "n-inc-3", kind: "incident", text: `## What happened

On Saturday at 02:14 the nightly database backup filled the disk on the primary, and Postgres stopped accepting writes for 26 minutes until the on-call engineer deleted the partial backup file.

## Why

The backup job writes a local dump before uploading it. The database has grown 40% since the disk was sized, and the dump plus the WAL archive no longer fit alongside the data directory. The disk usage alert was set at 90%, and the dump took the disk from 71% to 100% in eleven minutes, between two alert evaluations.

## Changes

The backup now streams directly to object storage with \`pg_dump | zstd | aws s3 cp -\`, so nothing is written to the local disk. We added 500 GB to the volume as a margin and an alert on the rate of disk growth, which catches a fast fill even when the absolute level is still low.

## Impact

Writes failed for 26 minutes in the quietest hour of the week. About 300 API requests returned 500. No data was lost.` },
{ id: "n-inc-4", kind: "incident", text: `Incident summary for the 2 October search outage

Search returned empty results for every query from 10:20 to 11:05. Nothing else was affected.

The cause was an index alias swap. The reindex job builds a new index and moves the \`products\` alias to it when it finishes. On the 2nd the job finished early because the source query failed after 40 seconds and returned no rows, and the job treated an empty result as a completed build. The alias moved to an empty index.

The fix has two parts. The job now compares the new index's document count with the old one and refuses to swap if it is less than 95%. And the source query's timeout, which was 40 seconds, is now ten minutes, matching how long the full query takes on a busy day.

We restored service by pointing the alias back to the previous index, which still existed because the job keeps the last two.` },
{ id: "n-inc-5", kind: "incident", text: `### Customer impact

Between 16:40 and 18:15 on 30 September, users in the EU region could not upload files larger than 8 MB. Smaller uploads worked. About 1,100 uploads failed.

### Root cause

A new WAF rule set, rolled out to the EU edge that afternoon, inspected request bodies up to 8 MB and rejected larger bodies outright instead of passing them uninspected. The US edge had not received the rule set yet, which is why only EU users were affected.

### Detection

A customer reported it through support at 17:55. Our upload error alert did not fire because it measures the error rate across all regions, and EU uploads over 8 MB are a small share of the total.

### Remediation

We set the rule set to pass oversized bodies uninspected, which is the vendor's recommended setting for upload paths, and split the upload error alert by region.` },
{ id: "n-inc-6", kind: "incident", text: `Short write-up of yesterday's deploy rollback.

The 15:00 deploy of the API failed its canary check after six minutes: p99 latency on the canary pods was 2.4 seconds against 300 ms on the rest. The pipeline rolled the canary back on its own and no customer traffic beyond the 5% canary share was affected.

The slow path was a new ORM eager-load on the account endpoint that pulled every invoice for accounts with long histories. Our largest account has 41,000 invoices. The test fixtures have at most twenty, so the tests were fast.

The query now loads only the latest invoice, which is all the endpoint returns, and we added a fixture account with 50,000 invoices to the performance suite. The deploy went out at 17:30 without problems.` },
{ id: "n-inc-7", kind: "incident", text: `# Post-incident review: expired TLS certificate on the status page

The status page served an expired certificate for three hours on 5 October, so browsers showed a warning to anyone checking whether we were up. The main application was not affected.

The status page is hosted separately and its certificate was issued by hand two years ago, outside the automated renewal that covers our other domains. The renewal reminder went to the inbox of an engineer who left in March.

We moved the status page domain into the same automated issuance as the rest, and added a check that fails if any certificate on our domains expires within 21 days. The check runs daily from outside our network, because the status page is meant to work when our network does not.

We also searched for other hand-issued certificates and found one more, on the old documentation domain, which now redirects to the new one.` },
{ id: "n-inc-8", kind: "incident", text: `## Incident: stale prices on product pages

**Duration:** 11:00 to 15:30 UTC, 21 September

**Impact:** Product pages showed the previous day's prices after the weekly price update. Checkout used the correct prices, so 212 customers saw a different total at checkout than on the product page, and 37 contacted support.

**Cause:** The price update job invalidates the CDN cache by URL. A change to the product URL format two weeks earlier added a locale prefix, and the job still purged the old URLs. The cached pages kept the old prices until their 24-hour TTL expired.

**Fix:** The job now purges by the surrogate key that every product page carries, which does not depend on the URL format. We purged the affected pages by hand at 15:30.

**Follow-up:** Add a check after each price update that fetches ten product pages through the CDN and compares their prices with the database.` },
// ---- Emails
{ id: "n-em-1", kind: "email", text: `Hi Dana,

The contract renewal is due on 1 December, and the vendor has sent a quote that is 18% higher than this year. Most of the increase is the new per-seat charge for read-only users, of whom we have about 140.

Two options: we can accept and keep everyone, or remove read-only seats and give those people the shared dashboard link instead. The second keeps the price flat. Finance prefers the second, and I think it works for everyone except the auditors, who need their own logins.

Could you tell me by Friday which you'd like? I'll reply to the vendor on Monday either way.

Thanks,
Sam` },
{ id: "n-em-2", kind: "email", text: `Hello Mr. Okafor,

Thank you for sending the logs. The failed syncs all happened while your laptop was on the hotel network, which blocks the port our client uses for its background connection. That is why the app showed "offline" even though web pages loaded.

The next release, due on 22 October, falls back to the standard HTTPS port when the usual one is blocked. Until then, connecting through your company VPN will let the sync complete.

I've attached the instructions for checking the sync status from the menu bar, in case it is useful while you are travelling.

Kind regards,
Priya Natarajan
Customer Support` },
{ id: "n-em-3", kind: "email", text: `Team,

Starting next Monday, the on-call rotation moves from weekly to half-week shifts: Monday 09:00 to Thursday 09:00, and Thursday 09:00 to Monday 09:00. Several of you said that a full week of pages, especially one that includes a weekend, was too long.

The schedule for the rest of the quarter is in the on-call calendar. Swaps work as before; post in the channel and update the calendar.

The page volume over the last month averaged nine pages a week, most of them from the disk alert we are fixing this sprint, so the shifts should get quieter too.

Marta` },
{ id: "n-em-4", kind: "email", text: `Hi Jonas,

I reviewed the draft data processing agreement. Two clauses need changes before we can sign.

Section 4.2 requires us to notify you of a breach within 24 hours. Our policy, and the commitment we make to every customer, is 72 hours, which matches the GDPR requirement. We can't commit to a shorter window for one customer without changing our process for all of them.

Section 7 gives you the right to audit our premises on five days' notice. We can offer our current SOC 2 report and a remote audit once a year instead, which is what our other enterprise customers have accepted.

Everything else is fine. If you can accept those two changes, I'll send the signed copy back the same day.

Best,
Ruth` },
{ id: "n-em-5", kind: "email", text: `Hi all,

The office will be closed on Friday 1 November for the building's electrical work. The landlord has confirmed that power will be off from 07:00 to 19:00, so the server room will be shut down on Thursday evening and brought back on Saturday morning.

If you have anything running on the lab machines, please stop it before 18:00 on Thursday. The VPN and everything in the cloud stay up; only the machines in the building are affected.

Sorry for the short notice. The landlord told us yesterday.

Ken` },
{ id: "n-em-6", kind: "email", text: `Subject: Your refund for order 48213

Dear Ms. Laurent,

We've issued a full refund of €84.50 for order 48213 to the card you paid with. It usually appears on your statement within five business days, although some banks take up to ten.

The jacket you returned arrived at our warehouse on 12 October with the tags still attached, so there is no restocking fee. You don't need to do anything else.

We're sorry the size didn't work out. The size chart on the product page was wrong for that style, and we corrected it this week after your message.

Best regards,
Elena
Customer Care` },
{ id: "n-em-7", kind: "email", text: `Hi Chris,

Following up on the interview with Aiko Tanaka on Tuesday. The panel's view is a yes for the senior backend role. Her system design round was the strongest we have seen this year: she found the bottleneck in the ledger design without prompting and proposed partitioning by account, with a clear argument about hot accounts.

The one concern is that she has not managed anyone, and the role includes mentoring two engineers. She was open about that and talked well about how she has helped junior colleagues on her current team.

Can you start the offer process? We'd like to make the offer by the end of next week, since she mentioned another offer with a deadline on the 30th.

Thanks,
Leila` },
{ id: "n-em-8", kind: "email", text: `Hi Tomás,

Thanks for flagging the invoice. You're right that it shows 45 seats while your contract covers 40. Five users were added on 3 September through the self-service invite, which bills at the same rate as contracted seats.

If those five users should not have access, I can remove them and credit the difference on next month's invoice. If you want to keep them, I can add them to the contract at your contracted rate, which is a little lower than the self-service rate, and credit the difference for September.

Let me know which you'd prefer, and I'll sort it out the same day.

Regards,
Ana` },
{ id: "n-em-9", kind: "email", text: `Hello,

I'm writing to ask whether your team would be open to a short call about the API rate limits on the analytics endpoints. We are building a nightly export for about 300 of our clients, and at the documented limit of 10 requests a second it would take around seven hours, which overlaps with our clients' working day in Asia.

We'd like to understand whether a higher limit is possible for scheduled bulk jobs, or whether there is a bulk export endpoint we have missed. Any 30-minute slot next week would work for us.

Thank you,
Hannah Becker
Integration lead, Northfield Analytics` },
{ id: "n-em-10", kind: "email", text: `Hi Raj,

Quick update on the migration. We moved the first 40 tenants to the new cluster last night with no errors, and their p95 response time dropped from 420 ms to 180 ms. The remaining 260 tenants are scheduled in batches of 50 over the next six nights.

One thing to know: tenants on the old API keys need to rotate them before their batch, because the new cluster does not accept the old key format. Support has emailed those 17 tenants, and I've attached the list in case your account managers want to follow up.

I'll send the next update on Thursday.

Mei` },
];
