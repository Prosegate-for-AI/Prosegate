// 20 replies dense with 08's tics, in the forms models produce. `want` lists each tic substring a
// careful editor would cut and that one of the 23 core rules is meant to catch.
export interface TicDoc { id: string; profile?: string; text: string; want: string[] }
export const TICS: TicDoc[] = [
{ id: "t01", text: `Great question! Let’s dive in.

When it comes to caching, it’s important to note that the cache is per tenant. This is a **robust** and **seamless** approach that truly scales.

I hope this helps! Let me know if you have any other questions.`, want: ["Great question", "Let’s dive in", "it’s important to note that", "robust", "seamless", "truly", "I hope this helps", "Let me know if you have any other questions"] },
{ id: "t02", text: `Certainly! Here's a comprehensive overview of the options.

It's worth noting that each option has trade-offs. Option A is fast, simple, and reliable. Option B could potentially
be faster, but it may or may not
fit your constraints.

Feel free to reach out if you need anything else!`, want: ["Certainly!", "comprehensive", "It's worth noting that", "fast, simple, and reliable", "could potentially", "may or may not", "Feel free to reach out"] },
{ id: "t03", text: `Absolutely! I'd be happy to help with that.

- **Leverage the existing cache** to avoid extra round trips.
- It's also worth noting that the index is unique. Note that writes are idempotent.
- The approach is not just about speed, it's about reliability.

In summary, this is a robust solution. Hope this helps!`, want: ["Absolutely!", "I'd be happy to", "Leverage", "It's also worth noting that", "Note that", "not just about speed, it's about", "In summary", "robust", "Hope this helps"] },
{ id: "t04", text: `Sure thing! In today’s fast-paced development landscape, teams need tooling that is **truly** cutting-edge.

This document outlines a holistic strategy that leverages modern practices to streamline delivery and foster collaboration. It is a testament to the team's dedication.

In conclusion, this approach is a game-changer.`, want: ["Sure thing", "landscape", "truly", "cutting-edge", "This document outlines", "holistic", "leverages", "streamline", "foster", "testament", "In conclusion", "game-changer"] },
{ id: "t05", text: `That's a great question. The short answer is that it depends.

Generally speaking, the planner picks an index scan. In many cases, though, a sequential scan is arguably faster for small tables. To some extent this is a nuanced trade-off.

It is important
to note that statistics matter. Let me know if you have any questions!`, want: ["great question", "it depends.", "Generally speaking", "In many cases", "arguably", "To some extent", "nuanced", "It is important\nto note that", "Let me know if you have any questions"] },
{ id: "t06", text: `**Great question!** Let's explore the options.

1. Utilize the read replica for the reporting queries.
2. It's worth noting that the replica lags by about a second.
3. The replica is relatively cheap and highly scalable.

Overall, the replica is a crucial part of a robust architecture. I hope this helps!`, want: ["Great question", "Let's explore", "Utilize", "It's worth noting that", "relatively cheap", "highly scalable", "Overall,", "crucial", "robust", "I hope this helps"] },
{ id: "t07", text: `I'd be glad to walk you through it.

In this response, I'll cover a variety of approaches. Whether it's a startup or an enterprise, the principles are the same: clarity, consistency, and simplicity.

It should be noted that the migration may or may not require downtime. Don't hesitate to reach out!`, want: ["I'd be glad to", "In this response", "a variety of", "Whether it's", "clarity, consistency, and simplicity", "It should be noted that", "may or may not", "Don't hesitate to"] },
{ id: "t08", text: `Let's dive into the details.

The new pipeline delves into each stage and underscores an important point: speed matters. It's not merely about speed, but about confidence.

It’s worth mentioning that the pipeline is seamless, robust, and scalable.

Happy to help further!`, want: ["Let's dive into", "delves", "underscores", "not merely about speed, but", "It’s worth mentioning that", "seamless", "robust", "Happy to help"] },
{ id: "t09", profile: "local/pr-description", text: `## Summary

This PR introduces a robust, comprehensive refactor of the auth module that will streamline
future work and bolster security. It's worth noting that the change is fully backwards
compatible.

## Changes

- Leveraging the new token service, sessions are now validated seamlessly.
- Various helper functions were consolidated into a single utility module.
- Error handling is now more nuanced, consistent, and predictable.

## Testing

Tests pass. This could potentially affect the mobile client, so please review carefully.`, want: ["robust", "comprehensive", "streamline", "bolster", "It's worth noting that", "Leveraging", "seamlessly", "Various", "nuanced", "could potentially"] },
{ id: "t10", profile: "local/email", text: `Hi Sam,

I hope this email finds you well! I'd be happy to share an update on the migration.

It is important to note that the migration is on track. The team has done truly remarkable work, which is a testament to their dedication.

Please don't hesitate to reach out if you have any questions.

Best,
Alex`, want: ["I hope this email finds you well", "I'd be happy to", "It is important to note that", "truly", "remarkable", "testament", "don't hesitate to"] },
{ id: "t11", text: `Great question — the answer is nuanced.

The cache isn't just a performance optimization; it's a correctness boundary. In the realm of distributed systems, this distinction is pivotal.

It's worth noting, however, that a number of teams skip it. That's a mistake.`, want: ["Great question", "nuanced", "isn't just a performance optimization; it's", "realm", "pivotal", "It's worth noting", "a number of"] },
{ id: "t12", text: `Certainly! Below is a step-by-step guide.

First, you'll want to utilize the CLI. Then, you can leverage the config file to fine-tune things. Finally, it's crucial to verify the output.

This approach is fast, reliable and
easy to maintain. Let me know if you'd like me to elaborate on any of these steps!`, want: ["Certainly!", "utilize", "leverage", "crucial", "fast, reliable and\neasy", "Let me know if you"] },
{ id: "t13", text: `Absolutely! Here's what's happening.

The error occurs because the token expires. Note that the client does not refresh it. Importantly, this is a fairly common issue that arguably affects many users.

To summarize, refresh the token before it expires. I hope this helps clarify things!`, want: ["Absolutely!", "Note that", "Importantly", "fairly common", "arguably", "To summarize", "I hope this helps"] },
{ id: "t14", text: `Let's break this down.

- **Speed**: The new engine is incredibly fast.
- **Reliability**: It is extremely reliable, thanks to its robust design.
- **Scalability**: It scales seamlessly across a wide range of workloads.

Ultimately, it's not just a tool, it's a paradigm shift.`, want: ["incredibly", "extremely", "robust", "seamlessly", "a wide range of", "not just a tool, it's", "paradigm shift"] },
{ id: "t15", text: `I'd be happy to help you with this!

It is worth noting that Kubernetes offers a plethora of options here. The ever-evolving ecosystem provides a myriad of tools that can potentially streamline your workflow.

Feel free to reach out if you have further questions. Happy coding!`, want: ["I'd be happy to", "It is worth noting that", "a plethora of", "ever-evolving", "a myriad of", "streamline", "Feel free to reach out"] },
{ id: "t16", text: `Great question!

> **Note:** It's important to note that this only applies to v2.

The fix is relatively simple: update the config. This could potentially resolve the issue entirely, but it may or may not fix the related warnings.

Hope this helps!`, want: ["Great question", "It's important to note that", "relatively simple", "could potentially", "may or may not", "Hope this helps"] },
{ id: "t17", text: `Sure thing! [Let's dive in](#details).

The service genuinely benefits from caching. It's worth
noting that the cache is per tenant, so it's **highly effective** for multi-tenant workloads.

In summary, caching is crucial. Let me know if you have any questions.`, want: ["Sure thing", "Let's dive in", "genuinely", "It's worth\nnoting that", "highly effective", "In summary", "crucial", "Let me know if you have any questions"] },
{ id: "t18", text: `Absolutely, I can help with that!

The migration was a meticulous, holistic effort. We utilized a phased rollout and leveraged feature flags to elevate confidence. This truly underscores the value of planning.

It's important to remember that every system is different. I hope this helps!`, want: ["meticulous", "holistic", "utilized", "leveraged", "elevate", "truly", "underscores", "I hope this helps"] },
{ id: "t19", profile: "local/chat-reply", text: `**Short answer:** yes, it's safe.

**Why:** The change is **backwards compatible** and **fully tested**. It's worth noting that the **migration** is **idempotent**.

**Next steps:** Deploy to **staging** first, then **production**. I hope this helps!`, want: ["It's worth noting that", "I hope this helps", "<bold density>"] },
{ id: "t20", text: `Great question! The cache is per tenant and expires after an hour. Each tenant has its own cache, and entries expire after one hour.

Reads go to the replica. Writes go to the primary. Reads are served by the replica.

To recap: the cache is per tenant and expires after an hour, reads go to the replica, and writes go to the primary.`, want: ["Great question", "Each tenant has its own cache, and entries expire after one hour", "Reads are served by the replica", "<closing restates opening>"] },
];
