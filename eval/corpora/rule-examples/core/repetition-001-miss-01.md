The patch fixes the pagination bug in the orders endpoint. It changes the offset calculation so that page two no longer repeats the final row of page one. A new test covers the boundary case where the results fill exactly one page.

The test builds a fixture of fifty orders in a fixed creation order. Reviewers should read the SQL in `orders_query.py`, because the ordering clause moved there from the controller, where it had been copied twice over the years and had drifted out of step with the database index. The benchmark we ran on the staging copy shows no change in latency. No migration is needed, so the deploy takes no downtime.

Clients that cached page tokens before the fix will see one duplicated row until their cache expires. I have not updated the changelog. Say if you want me to.
