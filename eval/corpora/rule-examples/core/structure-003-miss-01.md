The deploy failed at the migration step.

Your migration adds a NOT NULL column to the events table, and because that table holds about 90 million rows and the column has no default, Postgres rewrote the whole table while holding a lock that blocked every write from the API until the health check gave up. Nothing was lost. The API returned 503 errors for those four minutes, but the queue absorbed the writes and drained them once the lock cleared.

I would split the change into three steps. First add the column as nullable, which is instant. Then backfill it in batches of 10000 rows with a short pause between batches so that replication lag stays under a second, and run the backfill as a separate job outside the deploy so it can be paused or stopped. Finally add the NOT NULL constraint once the backfill is done. The constraint check scans the table once but does not block writes if you add it as NOT VALID first and validate it afterwards. That is safe during business hours. The backfill should take about forty minutes at that batch size, judging by the staging run. Staging has only a tenth of the rows, so treat the estimate as a floor.

I can write the three migrations if you want them.
