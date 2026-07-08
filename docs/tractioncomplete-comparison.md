# TractionComplete comparison intake

Source requested by Ryan: <https://tractioncomplete.com/>

Fetch status from this agent worktree: a direct homepage GET returned HTTP 200. The homepage describes Traction Complete as an "Agentic Data Management Suite for Salesforce" that "enriches, cleanses, connects and orchestrates" data, and its public navigation lists Complete Leads, Complete Hierarchies, Complete Clean, Complete Influence, Complete AI, Complete Discover, lead routing, lead-to-account matching, account hierarchies, deduplication, relationship mapping, and mass territory reassignment. This note avoids unverified packaging, pricing, or private feature claims.

## Comparison axes from public homepage material

The smallest useful FullStackGTM CLI increment is a read/plan-only CRM data orchestration slice that overlaps with the public TractionComplete homepage axes while preserving FullStackGTM's broader CRM-native operating-model scope:

| Public TractionComplete axis | FullStackGTM CLI surface added | Positioning / status |
| --- | --- | --- |
| Lead routing + lead-to-account matching | `fullstackgtm route leads` builds an approval-gated plan to link contacts to matched accounts by email domain or company-name fallback. | Implemented and tested against saved snapshots; dry-run plan only until approved. |
| Owner assignment / routing | `route leads` can inherit active account owners for ownerless contacts or use a deterministic assignment policy, producing normal `set_field` operations for approve/apply. Existing owners are preserved unless `--reassign-owned` is explicitly passed. | Implemented and tested; no production writes without patch-plan approval. |
| Account hierarchies | `fullstackgtm hierarchy report` renders account trees from provider parent hints plus deterministic subdomain inference, with duplicate/ambiguous/cyclic-parent conflicts instead of guessed writes. | Implemented and CLI-tested for markdown, JSON, and `--out`. |
| Relationship mapping | `fullstackgtm relationships account` summarizes stakeholders, roles, activity evidence, open deals, and missing-role gaps for one account. | Implemented and CLI-tested for markdown, JSON, and `--out`. |
| Deduplication / data cleanup | Existing `dedupe`, `merge`, `resolve`, and audit rules produce governed plans and ambiguity gates. | Existing surface; not expanded in this increment. |
| Mass territory reassignment | Existing `reassign` and assignment-policy primitives cover governed ownership changes; roadmap territory planning remains broader. | Existing surface; future work should connect territory module outputs into route/reassign plans. |

## FullStackGTM differentiation

- FullStackGTM is not only a Salesforce data-management tool: the roadmap positions it as the GTM operating layer for Salesforce and HubSpot across planning, budgets, headcount, territories, quotas, assignments, pipeline, forecasting, commissions, performance, ICP, ABM, attribution, customer health, playbooks, patch plans, and approvals.
- The open package keeps deterministic primitives framework-independent and zero-dependency.
- Write-safety stays central: routing and reassignment writes are typed `PatchPlan` operations that require explicit approval before apply.

## Guardrails for follow-up comparison

- Validate exact TractionComplete product behavior from accessible pages, docs, or a demo before claiming full parity.
- Keep FullStackGTM's OSS boundary: deterministic plan builders are open; no hosted-only dependency is required.
- Preserve the safety spine: all routing writes are dry-run `PatchPlan` operations that require approval before apply.
