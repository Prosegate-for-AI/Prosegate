import type { Doc } from "./clean-corpus.js";
// Round-2 clean corpus, part 3: chat answers (12) and code-heavy explanations (10).
export const NEW_CHAT_CODE: Doc[] = [
{ id: "n-chat-1", kind: "chat", text: `Yes, you can run both versions side by side. Install the new one with a different prefix, for example \`/opt/node20\`, and put that directory first on the PATH only in the shell where you need it. The system version stays the default for everything else, including the services started by systemd, which use their own environment and never read your shell's PATH.

If you use a version manager such as \`fnm\` or \`nvm\`, it does the same thing per directory, which is easier once you have more than two projects.` },
{ id: "n-chat-2", kind: "chat", text: `The 403 is coming from the bucket policy, not from IAM. Your role has \`s3:GetObject\` on the bucket, but the bucket policy has an explicit deny for any request that does not come through the VPC endpoint, and an explicit deny wins over any allow. Requests from your laptop go over the internet, so they hit the deny.

Run the same command from a machine inside the VPC and it should work. If you need laptop access, the bucket owner has to add your role to the condition in that deny statement.` },
{ id: "n-chat-3", kind: "chat", text: `I'd go with the managed Postgres rather than running it on the VMs. You said the team is three people and none of them has run Postgres in production. The managed service handles backups, failover and minor upgrades, and those are the parts that go wrong at 3 a.m.

It costs about 30% more than the equivalent VMs at your size. That is roughly one day of an engineer's time a month, and you would spend more than that on backups and patching alone.

The case for VMs is an extension the managed service does not support. You mentioned PostGIS, which it does support, so that is not a blocker.` },
{ id: "n-chat-4", kind: "chat", text: `It's slow because the query sorts the whole table before applying the limit. The \`ORDER BY created_at DESC\` has no index to use, so Postgres reads all 12 million rows, sorts them, and returns ten.

Add an index on \`created_at\`, or on \`(account_id, created_at)\` if the query always filters by account, which yours does. With that index Postgres walks the newest entries for the account and stops after ten. On a table this size that should take the query from seconds to a few milliseconds.

Create it with \`CREATE INDEX CONCURRENTLY\` so the table stays writable while it builds.` },
{ id: "n-chat-5", kind: "chat", text: `No, the free tier won't cover it. The free tier includes 100,000 function invocations a month, and your webhook handler runs once per event. You said you get about 5,000 events a day, which is around 150,000 a month.

The paid tier charges per million invocations, so at your volume the bill would be well under a dollar a month for invocations. The larger cost is likely to be the outbound data if the handler forwards the full payloads, so check the payload size before you decide.` },
{ id: "n-chat-6", kind: "chat", text: `The merge conflict is in the lockfile, and the safe way to resolve it is not to edit it by hand. Take either side, then let the package manager rebuild it:

1. \`git checkout --theirs pnpm-lock.yaml\`
2. \`pnpm install\`
3. \`git add pnpm-lock.yaml\` and continue the rebase.

The install reads both branches' \`package.json\` changes, which are already merged, and writes a lockfile that matches them. Run the tests afterwards, since the install may have picked newer patch versions within your ranges.` },
{ id: "n-chat-7", kind: "chat", text: `Your cron expression \`0 9 * * 1-5\` is right for 09:00 on weekdays, but the scheduler runs in UTC. 09:00 UTC is 10:00 in London in winter and 11:00 in summer, which matches what you saw.

Most schedulers accept a timezone setting next to the expression. In GitHub Actions there isn't one, so you have to write the UTC time and adjust it twice a year, or run hourly and check the local time in the first step of the job.` },
{ id: "n-chat-8", kind: "chat", text: `Short version: keep the monorepo. Your pain is the 25-minute CI run, and splitting the repo would fix that by making each repo's CI smaller, but you would trade it for version coordination across six packages that change together in most pull requests.

You can get most of the CI time back without splitting. Run only the jobs for packages that changed, using the dependency graph your build tool already knows, and cache the build outputs between runs. Teams with a similar setup usually get a typical pull request under five minutes that way.` },
{ id: "n-chat-9", kind: "chat", text: `The browser is caching the redirect. A 301 tells the browser the move is permanent, and Chrome keeps it until the cache is cleared, so after you changed the server config your machine kept going to the old target while a fresh browser went to the new one.

Clear the cache for that site, or test in a private window. For redirects you might change later, use a 302 until you are sure, then switch to 301.` },
{ id: "n-chat-10", kind: "chat", text: `It depends on whether the reports need to be exact. If finance reconciles them against the ledger, run them on the primary or on a replica you have checked is caught up, because the replica can lag by several seconds under write load and a report run at month end could miss the last transactions.

If they are dashboards that people read for trends, the replica is fine, and it keeps the long queries away from the primary.` },
{ id: "n-chat-11", kind: "chat", text: `Thanks, that log helps. The worker is not crashing; Kubernetes is killing it. The line \`OOMKilled\` with exit code 137 means it went over its memory limit of 512 Mi. The heap dump you attached shows about 380 MB of image buffers, which fits: the worker loads each image fully into memory before resizing.

Raising the limit to 1 Gi would stop the kills for now. Processing the images as streams, which the library supports through \`sharp(input).resize()\` on a stream, would keep memory flat regardless of image size.` },
{ id: "n-chat-12", kind: "chat", text: `For a team of your size I would not add a service mesh yet. The problems you listed are retries, timeouts and seeing which service calls which. The first two your HTTP client library handles with a few lines of config per service, and the third is what the tracing you already send to your APM shows.

A mesh earns its operational cost when you need mutual TLS between services, or traffic shifting for canaries across many services. Neither is on your list. Revisit it if one of them becomes a requirement.` },
// ---- code-heavy explanations
{ id: "n-code-1", kind: "code", text: `The bug is that \`useEffect\` captures \`count\` from the render where the interval was created, so the callback always sees 0 and sets the state to 1.

\`\`\`tsx
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, []);
\`\`\`

Use the updater form, which receives the current value instead of the captured one:

\`\`\`tsx
useEffect(() => {
  const id = setInterval(() => setCount((c) => c + 1), 1000);
  return () => clearInterval(id);
}, []);
\`\`\`

Adding \`count\` to the dependency array would also work, but it tears down and recreates the interval every second.` },
{ id: "n-code-2", kind: "code", text: `\`asyncio.gather\` runs the coroutines concurrently, but \`requests.get\` is a blocking call, so each one holds the event loop until it returns and the calls run one after another.

\`\`\`python
async def fetch(url):
    return requests.get(url).json()   # blocks the loop
\`\`\`

Use an async client so the loop can switch between requests while each waits for the network:

\`\`\`python
import httpx

async def fetch(client, url):
    r = await client.get(url)
    return r.json()

async def main(urls):
    async with httpx.AsyncClient(timeout=10) as client:
        return await asyncio.gather(*(fetch(client, u) for u in urls))
\`\`\`

With 50 URLs that each take 200 ms, the first version takes about 10 seconds and the second about 200 ms plus overhead.` },
{ id: "n-code-3", kind: "code", text: `Go's \`for\` loop variable is shared across iterations before Go 1.22, so every goroutine below prints the last value:

\`\`\`go
for _, job := range jobs {
    go func() {
        process(job)
    }()
}
\`\`\`

You have two fixes. Pass the value in as an argument, which works on every Go version:

\`\`\`go
for _, job := range jobs {
    go func(j Job) {
        process(j)
    }(job)
}
\`\`\`

Or set \`go 1.22\` or later in \`go.mod\`, where each iteration gets its own variable and the original code is correct. Your \`go.mod\` says \`go 1.21\`, which is why you see the bug.` },
{ id: "n-code-4", kind: "code", text: `The regex fails on the second line because \`^\` and \`$\` match only at the start and end of the whole string by default. Turn on multiline mode:

\`\`\`js
const re = /^ERROR: (.+)$/gm;
for (const m of log.matchAll(re)) console.log(m[1]);
\`\`\`

The \`m\` flag makes \`^\` and \`$\` match at each line break. You also need \`g\` for \`matchAll\`, which throws without it. If the log uses Windows line endings, the captured message will end with \`\\r\`; use \`(.+?)\\r?$\` to drop it.` },
{ id: "n-code-5", kind: "code", text: `Your Dockerfile copies the whole source tree before installing dependencies, so any code change invalidates the install layer and every build reinstalls everything.

\`\`\`dockerfile
COPY . .
RUN npm ci
\`\`\`

Copy the manifests first, install, then copy the rest:

\`\`\`dockerfile
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
\`\`\`

Now the install layer is reused until the lockfile changes. Add \`node_modules\` to \`.dockerignore\` too, or the final \`COPY\` will overwrite the installed modules with whatever is on your machine.` },
{ id: "n-code-6", kind: "code", text: `The test passes alone and fails in the suite because another test leaves a row in the \`users\` table, and your test asserts that the table has exactly one row.

\`\`\`python
def test_create_user(db):
    create_user(db, "a@example.com")
    assert db.query(User).count() == 1
\`\`\`

Either wrap each test in a transaction that rolls back, which most fixtures support:

\`\`\`python
@pytest.fixture
def db(engine):
    with engine.connect() as conn:
        tx = conn.begin()
        yield Session(bind=conn)
        tx.rollback()
\`\`\`

or assert on the row you created rather than on the count. The first fix is better because it stops the next test that makes the same assumption.` },
{ id: "n-code-7", kind: "code", text: `In Rust the borrow checker rejects this because \`first\` borrows from \`v\` and the \`push\` may reallocate the vector, which would leave \`first\` pointing at freed memory:

\`\`\`rust
let first = &v[0];
v.push(4);
println!("{first}");
\`\`\`

If you only need the value, copy it out before the push:

\`\`\`rust
let first = v[0];
v.push(4);
println!("{first}");
\`\`\`

This works because \`i32\` is \`Copy\`. For a \`String\` or another type that is not \`Copy\`, clone it, or reorder the code so the borrow ends before the push.` },
{ id: "n-code-8", kind: "code", text: `The \`terraform plan\` wants to replace the database because you changed \`engine_version\` and the provider treats a major version change on that resource as one that forces replacement. Replacing it would create an empty database.

\`\`\`hcl
resource "aws_db_instance" "main" {
  engine_version = "16.3"   # was 13.11
}
\`\`\`

Set \`allow_major_version_upgrade = true\` and \`apply_immediately = false\` on the resource. The plan should then show an in-place update, and the upgrade runs in the next maintenance window. Take a manual snapshot first; the in-place upgrade cannot be rolled back.` },
{ id: "n-code-9", kind: "code", text: `\`git rebase\` stopped because two commits on your branch edit the same lines of \`config.yaml\` that changed on main. Resolve it one commit at a time:

\`\`\`bash
git status                 # shows config.yaml as both modified
$EDITOR config.yaml        # keep the lines you want, delete the markers
git add config.yaml
git rebase --continue
\`\`\`

Repeat for the second commit when the rebase stops again. If it gets confusing, \`git rebase --abort\` puts the branch back exactly as it was before you started, so nothing is lost by trying.` },
{ id: "n-code-10", kind: "code", text: `The SQL returns duplicate orders because the join to \`order_items\` produces one row per item, and the \`SUM\` then counts each order's shipping fee once per item.

\`\`\`sql
SELECT o.id, SUM(o.shipping_fee) AS shipping
FROM orders o
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id;
\`\`\`

The join is not needed for the shipping total. Sum it from \`orders\` alone, and if you need item counts in the same result, compute them in a subquery:

\`\`\`sql
SELECT o.id, o.shipping_fee,
       (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS items
FROM orders o;
\`\`\`

An order with three items had its shipping fee counted three times, which matches the totals finance flagged.` },
];
