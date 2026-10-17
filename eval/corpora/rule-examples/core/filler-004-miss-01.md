# Stale prices on the checkout page

## Impact

On 9 October between 14:05 and 14:52 UTC, the checkout page showed prices that were up to six hours old for about 11 percent of visitors. Most of the affected prices were lower than the current ones, because a regional sale had ended at noon. Orders placed during the window were charged the current price, not the one displayed, so customers saw a mismatch on the confirmation page. Support received 214 contacts about it. Finance estimates that 38 customers abandoned a cart after seeing the higher price at confirmation, although we cannot confirm that figure from our own data.

No order was charged the wrong amount. We checked every order in the window against the price service, and all of them matched the price at the moment of purchase. The fault was in what we showed, not in what we billed.

## Timeline

The first stale price was served at 14:05, minutes after a cache node in the eu-west region was restarted by an automatic kernel update. The restarted node came back with its warm-up flag unset, so it served whatever it found on disk instead of asking the price service. What it found on disk was a snapshot from 08:00.

The first customer report reached support at 14:17. Support tagged it as a display bug and routed it to the web team, who spent the next 20 minutes looking for a rendering fault in the frontend. Nothing was wrong there. At 14:38 an engineer on the platform team noticed that the cache hit rate for eu-west had jumped to 100 percent, which is impossible straight after a restart, and asked about the warm-up flag.

The node was drained at 14:46 and its disk snapshot was deleted. Fresh prices reached all visitors at 14:52, when the cache refilled from the price service.

In summary, detection took 12 minutes from the first stale price to the first report, diagnosis took 21 minutes after that, and the fix took 14 minutes. The slowest part was the diagnosis, because the first report was misrouted.

## Causes

Three things combined. First, the cache node served from disk when its warm-up flag was unset, and nothing checked the age of what it served. Second, the restart was triggered by an automatic kernel update that bypassed our change calendar, so nobody on the team knew a restart was due. Third, the alert on cache hit rate fires only below 60 percent, so a rate of 100 percent looked healthy.

The warm-up flag is set by a startup script that reads it from a parameter store. The parameter store call timed out during the restart because the network was not yet up, and the script treated the timeout as "flag not set" instead of retrying. That default was written years ago for a single region setup, where serving from disk was the right fallback.

We had no test for this path. The restart drill in staging runs with the parameter store reachable, so it never exercised the timeout. The drill also restarts one node at a time during working hours, whereas the real restart came from a patch run that touched the node without warning.

The misrouting of the first report is a separate and smaller cause. Our support runbook sends anything that mentions prices to the web team, since most price complaints are rendering bugs. That rule is right nine times out of ten, and on this occasion it cost us 20 minutes.

## What went well

The price service stayed healthy throughout, which let us check every affected order afterwards and rule out wrong charges within an hour. Draining a node is documented in the runbook and took eight minutes from decision to completion. Support also kept a shared log of contacts with order numbers, so Finance could match complaints to carts without asking for a data export.

We reviewed the six other cache nodes the same day. Four had the same startup script and the same default, and none had restarted recently, which is the only reason they were not affected. We patched all four before the next maintenance run.

## Changes

We have made four changes since the incident. The startup script now retries the parameter store call for up to two minutes and refuses to join the pool if the flag is still unknown. A cache entry now carries the time it was fetched, and the node drops any entry older than 30 minutes instead of serving it. Alerting now also covers hit rates above 98 percent, which no healthy node should reach. The support runbook now sends price complaints to the platform team first when more than three arrive within ten minutes.

Two changes remain open. The kernel update policy still allows unannounced restarts, and the platform team will move it onto the change calendar by 30 October. We also want a synthetic check that compares a sample of displayed prices against the price service every minute, which would have caught this incident at 14:06. Dana owns that work and expects a first version in two weeks.
