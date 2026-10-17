Monday's copy of our customer data into the new cluster finished before lunch, and no alert fired during the copy.

Every table was verified against the old cluster by comparing row counts, and only two small tables needed to be copied again. The application servers still point at the old cluster, because we want to switch them only after the weekend traffic has passed. Replication between the two clusters has stayed within a few seconds of the source for the whole period of the test.

The next step is to rehearse the switch on the staging environment, which should take the team about half a day. Rehearsing the switch will also tell us how long the connection pool needs to drain before the new cluster accepts writes. If the drain takes longer than the planned window, we will extend the window rather than force the connections closed early. The rollback plan keeps the old cluster running and read only for seven days after the switch, in case we find problems. Monitoring for the new cluster is already in place, and the alerts for disk space and replication lag have both been tested. The only open question is whether the nightly report job can run against the new cluster without changes to its settings.

Priya will time that job on Tuesday, and if it matches our old cluster we will book a weekend for the switch.
