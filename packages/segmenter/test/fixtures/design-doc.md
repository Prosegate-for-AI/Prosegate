# Rate limiting for the public API

## Context

Every public endpoint currently shares one global limit. A single noisy tenant can therefore starve everyone else, and support has seen three incidents in the last quarter.

## Goals

1. Isolate tenants from each other.
2. Keep p99 added latency under 2 ms.
3. Make limits configurable per plan.

## Proposal

We will use a token bucket per tenant, stored in Redis. Each request costs one token. Buckets refill at the plan rate (e.g. 100 requests per second on the Team plan) up to a burst of twice that.

| Plan | Rate | Burst |
|------|------|-------|
| Free | 10/s | 20 |
| Team | 100/s | 200 |

### Failure mode

If Redis is unreachable we fail open. This trades protection for availability, which Dr. Okafor argued is the right call for a read-heavy API.

## Open questions

- Should webhooks count against the limit?
- Do we expose remaining tokens in a header?
