# Fix retry storm in the webhook worker

This change stops the webhook worker from retrying failed deliveries in a tight loop. The old code re-queued a failed job immediately, so one bad endpoint could saturate the queue within seconds.

## What changed

- Added exponential backoff with jitter in `src/queue/retry.ts`, capped at 15 minutes.
- Moved the attempt counter into the job payload so restarts no longer reset it.
- **Breaking:** the `retryDelayMs` option is gone; see https://example.com/docs/retries for the migration.

## Test plan

- [x] Unit tests for the backoff schedule.
- [ ] Soak test against a dead endpoint for one hour.

```bash
pnpm test --filter worker
```

Closes #482. Thanks to @maria for the repro.
