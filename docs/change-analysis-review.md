# Change-analysis cost review — November 6, 2026

Read-only review of 120 archived observations, sampled evenly through observation order across October 30–November 7 UTC. This is a comparison replay, not a fresh AI classification or a billing export. Historical labels are AI judgments, not ground truth.

| Replay measure | Before | After |
| --- | ---: | ---: |
| Comparisons | 120 | 120 |
| Comparison errors | 0 | 0 |
| Nonempty comparisons needing AI | 113 | 103 |
| Input payload token proxy | 3,149,470 | 2,677,231 |

Nine previously build-only comparisons became empty through metadata normalization; one previously uncertain comparison became empty but remained incomplete, so it stays locally uncertain. No previously application-labeled observation became an empty comparison. Thirteen comparisons lost a previously unresolved pairing flag, including eight historically labeled uncertain. They are still subject to other evidence checks and model classification.

The token proxy uses `o200k_base` over reconstructed payloads, excluding instructions, schema overhead, and the API-reference appendix. It is not Claude's tokenizer, actual usage, or a promised 15% dollar reduction. The payload reduction combines metadata filtering, structural bundle pairing, structured JSON, and shared unchanged context. Sentence-only rewrite savings are additional but were not measured because historical rewrite requests were not retained.

## What can safely stay local

- Exact SDK metadata slots: Sentry configuration `release` literals identified by its Next.js stack-frame integration; injected PostHog release/chunk UUID assignments. Other object fields and surrounding code remain in the comparison. Unsupported JavaScript is left untouched.
- Empty complete comparisons are build-only; empty incomplete comparisons remain uncertain.
- Structural similarity is used only to pair uniquely matching renamed assets within the existing location/query/type boundary. Original identifiers, literals, properties, and edits still go into the diff. Ambiguous candidates stay unpaired. Tokenization has a size/work cap that falls back to the existing matching behavior.

Do not equate arbitrary hash changes, renamed identifiers, generated CSS/font classes, or changed chunk references with unchanged behavior. Reflection, exports, selectors, unavailable chunks, and load order can make those changes meaningful. A global identifier-stripping fingerprint would hide evidence.

## Remaining expensive comparisons

Before these changes, historically uncertain observations accounted for approximately 49% of sampled payload tokens; the largest 10% of observations consumed approximately 47%. Large comparisons commonly involve unmatched anonymous chunks, missing or uncaptured scripts, runtime loader changes, and hunks exceeding the 400,000-character budget. These reasons overlap.

Pairing helps reduce whole-file remove/add diffs. It can also increase an individual prompt when previously omitted code now fits the budget; the replay includes such cases. Keep that evidence rather than optimizing solely for a lower bill. Missing captures and budget limits must remain explicit. Further savings require representative quality checks, not silently treating incomplete comparisons as build-only or truncating more source.

## Validation and rollout

Regression tests cover mixed metadata/feature edits, business release fields, unsupported syntax, ambiguous structural candidates, renamed bundles with real edits, diff reconstruction, rewrite isolation, provider response completion, and recommendation bounds. Relevant normalization, pairing, rewrite, and completion-check mutations are killed by the tests.

Live synthetic Claude requests verified classification, shortlist selection, and structured recommendation scores with `claude-haiku-5-5`. No archived source was sent in these smoke requests. Provider usage is now retained in `ai_usage`; it stores task, model, usage JSON, and time, without prompts or credentials. Input, cache-read, cache-write, output, processing tier, and region details remain available for reconciliation. Responses that fail before returning usage, such as transport timeouts, cannot be fully accounted for by this ledger.

Deploy only after review. Install the updated service unit, supply a root-owned `/etc/shipwatch-ai.env` with `ANTHROPIC_API_KEY`, reload systemd, and restart. The code does not reclassify historical observations or requeue failed discovery jobs automatically. The existing deployed stop-on-discovery-error and inspection-evidence behavior is retained in source. No Batch API path is introduced.
