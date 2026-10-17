The rate limiter reads twelve settings from `limiter.toml`, and every one of them has a default that is safe for local development.

- `enabled`: master switch
- `window_seconds`: window length
- `max_requests`: requests per window
- `burst`: extra short-term allowance
- `redis_url`: counter store address
- `key_prefix`: namespace for counters
- `fail_open`: allow on outage
- `trust_proxy`: honour forwarded headers
- `log_level`: logging verbosity
- `exempt_ips`: addresses never limited
- `retry_header`: send Retry-After
- `metrics_port`: Prometheus scrape port

Only `enabled` and `redis_url` must be set in production. The rest can stay at their defaults until real traffic tells you otherwise. If `fail_open` is false, a Redis outage will reject every request, so check that value before you deploy.
