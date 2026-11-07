# Prompt token budget

Every paid Messages request is counted using the same model, system prompt, evidence, thinking setting, and output schema that will be sent for generation. The request is rejected before generation if its estimated count exceeds 90,000 tokens, or if counting fails. This includes discovery, rewrites, and reconciliation. Claude documents that counting is an estimate, so the 10,000-token margin is deliberate. Actual usage and `preflight_input_tokens` are retained together in `ai_usage`.

Sources: [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting), [Haiku pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## Preserve evidence before reducing context

Large coarse before/after replacements can be compacted into `sourceDiff`: a sequence of unchanged strings and `[before, after]` replacement pairs. Structural token matching only chooses the alignment. Differing identifier names, literals, properties, and all other characters remain represented. Selecting each side reconstructs its exact original source. Unsupported syntax or an alignment timeout falls back to the original representation.

Comparisons still too large are partitioned at evidence boundaries, then within paired edits if necessary. Every supplied edit and API reference remains covered; missing-capture and truncation warnings accompany each part. Part reports retain specific technical facts, allowing reconciliation to identify changes whose meaning depends on multiple parts. An independently established application change from a part containing only whole supplied edits survives a generic uncertain reconciliation; fragmented evidence still requires reconciliation. A multipart build-only claim cannot prove whole-source equivalence and remains uncertain. This is static AI interpretation, not a guarantee of semantic equivalence or zero classification mistakes.

The existing capture and 400,000-character comparison limits remain explicit. The token budget adds no silent source truncation. An indivisible field or context that cannot fit fails closed as uncertain rather than generating an oversized request. All parts are planned before paid reviews begin.

Completed reports are cached by model, analysis version, prompt, schema, and exact part input. After a transport failure, retries reuse successful parts and retry the missing review/reconciliation. No historical observations are automatically reclassified.

## Validation

- Twenty-two archived comparison replays through Claude’s real token counter, with generation mocked: no reconstruction/coverage failures, no comparison errors, and all planned generation requests below the 90,000 estimated-input-token limit. Twelve initial compact requests still exceeded 100,000 tokens and were partitioned. Subsequent prompt wording clarifies that concrete captured logic changes do not require proof of visible UI effects or full route coverage.
- Regression tests cover exact reconstruction, Unicode boundaries, API references, global coverage warnings, a late real feature change, cross-part reasoning, ambiguous conclusions, cache reuse after a partial failure, identical count/generation parameters, and fail-closed counting.
- A controlled oversized comparison with a one-line checkout enablement and unrelated missing capture correctly remains application. Its five paid requests used 74,796, 74,815, 1,064, 1,081, and 1,622 input tokens, each exactly matching its preflight count.
- Controlled paid smoke requests validate the actual provider’s usage against preflight counts. These use an isolated temporary database and do not publish observations or alter live historical classifications.

Token-count estimates and sample workloads can vary. Post-deployment verification must check actual usage, including cache-read/write input tokens, rather than assuming character counts or a sample mean enforce the budget.
