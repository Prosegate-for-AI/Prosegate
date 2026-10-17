The CI pipeline takes 22 minutes because the test job reinstalls every dependency on each run. The cache key includes the lockfile timestamp, which changes on every checkout, so the cache never hits.

I tried a fix on a branch. Keying the cache on the lockfile hash alone brought the install step from nine minutes down to forty seconds. Sharing one database container across test files saved another six minutes. The frontend now builds once and uploads its output for both jobs.

Open a pull request from `ci-cache` and ask Dana to review it before Friday's release freeze.
