I checked the billing database against the Postgres 16 upgrade notes and found these problems.

- The extension `pg_partman` is pinned to version 4.5, and that release does not support Postgres 16.
- Three stored procedures call `array_agg` with an ORDER BY inside a window frame, which now needs an explicit cast.
- The nightly vacuum job will fail on its first run.
- Replication to the analytics replica uses a logical slot that cannot survive a major version change.
- The connection pooler on the new cluster accepts scram-sha-256 only, so older drivers will be refused at login, and two of our reporting tools still ship such drivers.
- Two reporting views depend on the removed `adminpack` extension.
- Staging holds 40 GB of data but production holds 600 GB, so the dump and restore estimate is far too low.
- The backup retention script deletes any file older than seven days, including the pre-upgrade snapshot that rollback needs.
- Disk usage will rise by about 15 percent during the upgrade.
- The monitoring dashboards query a metric name that changes in Postgres 16, so the alerts will go quiet without warning.
- The Python service pins `psycopg2` at version 2.8.
- The failover runbook still names the old data directory and needs the new path before anyone follows it at night, because the first person to use it will probably be tired and in a hurry.
- Two cron jobs run as the `postgres` user and write to a log directory that the new package does not create.
- The upgrade rehearsal has never been run.
- Support has not been told about the maintenance window.
- The load balancer health check queries a table that the migration drops in step four.
- Finance closes the quarter on the last day of the month, so the cutover cannot fall in the final three days.

None of these blocks the upgrade on its own. The partman pin and the replication slot carry the most risk, so I would start with those two.
