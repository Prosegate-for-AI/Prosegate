# Webhook delivery retries

## Background

Our webhook service posts event payloads to customer endpoints. Today it makes a single attempt with a ten second timeout and then drops the event. Support fielded eleven tickets last quarter from customers who lost events while their own service was deploying, and two of those customers have asked for a delivery guarantee in writing.

The current design has no queue between the event stream and the sender. A worker picks up an event, sends it once, and acknowledges it to the stream whether or not the customer answered. That keeps latency low, which matters at the 4000 events per second we send at peak. It also means that an endpoint that is down for thirty seconds loses every event we would have sent in that window.

This document proposes a retry policy and the changes needed to support it. It does not cover per-customer rate limits, which are tracked separately.

## Proposal

Failed deliveries go to a retry queue instead of being dropped. A delivery counts as failed when the endpoint returns a 5xx status, a 429, or nothing at all within the timeout. Any other 4xx status means the customer rejected the payload on purpose, so we do not retry it. We record it and move on.

Retries follow an exponential schedule with jitter. The delays are 10 seconds, 1 minute, 5 minutes, 30 minutes, 2 hours and 8 hours. After the sixth retry the event moves to a dead-letter table that customers can browse and replay from the dashboard. Jitter is plus or minus 20 percent of the delay, which spreads the load when a large customer comes back online and every queued event falls due at once.

Each attempt carries the same event id and a header with the attempt number, so customers can deduplicate. We will document that delivery is at least once, never exactly once, and that order is not preserved across retries.

Timeouts stay at ten seconds for the first attempt and drop to five seconds for retries, because a retry that waits ten seconds holds a worker for twice as long without much chance of success. Retries must not starve first attempts either, so they run on a separate worker pool that is capped at a quarter of all workers.

## Alternatives considered

We looked at three other designs. The first was a fixed interval of one minute for a day. It is simple, but it hammers a struggling endpoint at a constant rate, and it gives no relief during the long outages that account for most of the lost events in the tickets.

The second was to hand retries to a managed queue service and let it own the schedule. That removes code we would otherwise write. However, the service caps delay at fifteen minutes, which is far too short for the overnight outages customers describe. We would still need our own scheduler for the long tail, so the managed queue adds a dependency without removing any work.

The third was to leave delivery alone and offer a replay API only. Replay puts the burden on the customer to notice a gap and request the missing range. Two of the customers who complained said they found their gaps during month-end reconciliation, so replay by itself does not fix their problem. We will ship replay anyway, because the dead-letter table needs it.

## Implementation

The retry queue is a table in the existing primary database, not a new system. Each row holds the event id, the endpoint, the attempt number and the next due time. A scheduler process polls for due rows every second with an indexed query and a `FOR UPDATE SKIP LOCKED` clause, so several scheduler instances can run without handing the same row to two workers.

We sized the table from last quarter's failure rate. About 0.6 percent of attempts fail at present, which at peak volume puts roughly 24 rows per second into the queue. With a six step schedule the steady state holds around two million rows, well inside what the database handles today. A load test on a staging copy ran for six hours at three times that rate and kept the poll query under 15 ms.

The sender changes are small. On failure, the worker writes the retry row in the same transaction that records the attempt, so a crash between the two cannot lose an event. On success it deletes any pending row for that event. The whole feature sits behind a flag that is enabled per customer, so we can begin with the two customers who asked for it.

Dead-letter handling needs one new dashboard page and one API endpoint. The page lists failed events with the last status code and the last response body, truncated to 1 KB. Replay re-enqueues the event with the attempt counter reset to zero.

Observability needs a few additions. We emit one metric per attempt, labelled with the attempt number and the outcome, and one gauge for queue depth per endpoint. The webhook team's dashboard gains two panels, retries per hour and time to first success. The second panel is the one customers care about, since it shows how long an event waits before they receive it.

## Risks and rollout

The main risk is amplification. If a large customer's endpoint fails for hours, we will hold up to six copies of each event in the queue and send them as it recovers. Jitter helps. We also add a per-endpoint cap of 20 requests in flight, so one recovering customer cannot starve the others.

A second risk is the database. The queue shares a primary with the application, and a runaway retry loop could slow unrelated queries. We will alert when the queue depth passes five million rows, and we will keep a switch that pauses the scheduler without touching the sender.

A third risk is customer behaviour. Some endpoints treat any request as a signal to do work, and a retried event could trigger a duplicate side effect. The event id header and the documentation are our only defence, so we will ask the two pilot customers to confirm that they deduplicate before we enable retries on their accounts.

Rollout takes three weeks. In week one the flag is on for our own test account. In week two we enable the two customers who asked, and we watch queue depth and the dead-letter rate every day. In week three we open it to everyone on a paid plan and publish the delivery guarantees in the documentation.

If the dead-letter rate for enabled customers is above 2 percent after week two, we stop and revisit the schedule before going wider.
