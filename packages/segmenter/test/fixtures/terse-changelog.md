## Summary

- Added retry logic with exponential backoff to the webhook worker
- Moved attempt counter into job payload
- Fixed flaky test in queue suite
- Removed unused retryDelayMs option
- Updated docs for migration
- Bumped vitest to 4.1.12
- Renamed parse helpers for clarity
- Added CRLF fixtures
- Tightened lint rules for tests
- Dropped legacy config loader
