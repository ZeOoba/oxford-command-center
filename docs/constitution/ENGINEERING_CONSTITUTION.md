# The Oxford Intelligence Platform — Engineering Constitution

**Version:** 1.0 (draft, awaiting ratification)
**Status:** Proposed 2026-07-29 by the founding architecture review. Not yet binding — see Amendment Process (§16) for how this document becomes authoritative and how it may later change.
**Authority:** Where any implementation decision, roadmap item, ADR, coding standard, or AI agent design conflicts with this document, this document wins — unless it has been explicitly amended through the process in §16. A conflict discovered during implementation is not license to route around this file; it is a signal to either fix the implementation or open an amendment.
**Scope:** governs the Oxford Intelligence Platform (the facts/documents/edges layer and everything built on it, per `docs/roadmap/intelligence-platform/`) and, by extension, the Financial Intelligence warehouse it sits on top of. It does not govern oxfordra.net or unrelated tooling.

This is not a technical specification. It contains almost no implementation detail on purpose — implementation detail belongs in `architecture/*.md`, `docs/adr/`, and `docs/roadmap/`, all of which are expected to change constantly. This document is written to still be true when none of today's specific technology choices are.

---

## Preamble — why this exists

Oxford Realty Advisors is a two-principal family office, not a venture-funded PropTech company. It will never out-hire or out-spend an institutional competitor. What it can do — and what nothing on the market sells, because it isn't for sale — is accumulate twenty years of its own operating history in a form that gets smarter every year instead of sitting in filing cabinets and someone's memory. That accumulation is the entire bet this platform is making. Every principle below exists to protect that bet against the two forces most likely to kill it: (1) short-term engineering shortcuts that quietly destroy information the company will want back in year twelve, and (2) unbounded scope that consumes the one or two people capable of building this until nothing ships. Everything here is written against those two failure modes, explicitly.

---

## 1. Company Mission

**Principle:** The platform exists to make Oxford Realty Advisors a company that gets measurably smarter every year it operates, by turning every document, decision, and outcome it produces into permanent, connected, queryable institutional knowledge.

**Why it exists:** ORA's actual competitive assets are its accumulated deal history, tenant relationships, and operating record — not scale, not brand, not capital. Every other advantage (capital, deal flow, broker relationships) is purchasable or replicable. Twenty years of correctly-labeled "why we passed on this and were later proven right" is not.

**Long-term benefit:** compounding. A platform that makes underwriting 2% more accurate each year, applied over sixty acquisitions in twenty years, is worth more than any single feature. The mission is deliberately not "build good software" — good software is a means, not the mission.

**Correct implementation:** the Decision/Outcome loop (Phase 1 of the platform roadmap) exists specifically because "how accurate has our underwriting been" is currently an anecdote, not data — this is the mission's most direct expression in the current roadmap.

**Violation:** building a feature because it's technically interesting or demos well (e.g., a chat interface over the document corpus) ahead of a feature that makes an actual decision better, even if the latter is less impressive to look at. The roadmap explicitly sequences the semantic Q&A surface last for this reason.

**Tradeoffs:** optimizing for compounding institutional knowledge over user-facing polish means the platform will, for years, look less impressive than a good SaaS product demo. That is an accepted cost, not an oversight.

**Exceptions:** none. If a proposed feature cannot be traced to "this makes a future decision better," it does not belong on the roadmap regardless of how compelling it looks.

---

## 2. Engineering Philosophy

**Principles:** long-term thinking over short-term velocity; maintainability over cleverness; the simplest system that correctly does the job over the most sophisticated one; modularity and composability over monoliths; graceful evolution over rewrites.

**Why it exists:** this platform is operated by one to two people with no dedicated engineering team. Complexity that a ten-person team could absorb is fatal here — every clever abstraction is a future maintenance burden with no one to hand it to. "Boring" is a feature, not an insult.

**Long-term benefit:** a system a single person can still understand cold in year fifteen is worth more than one that was 20% faster to build in year one but requires archaeology to touch safely.

**Correct implementation:** choosing SQLite over a graph database (ADR-0002) and relational tables over a bespoke knowledge-graph engine, explicitly because the operational simplicity of "one file, one backup, one set of SQL skills" outweighs the theoretical elegance of native graph traversal at ORA's actual scale.

**Violation:** introducing a message queue, a microservice boundary, or a second programming language to solve a problem SQL and a single Node process already solve adequately. Complexity must be justified by a real, current constraint — never by anticipated future scale that may never arrive.

**Tradeoffs:** simple systems sometimes require more manual work per unit of scale than a more sophisticated system would. Accepted, because ORA's scale for the foreseeable future does not exceed what simple systems handle comfortably (see ADR-0002's revisit condition).

**Exceptions:** complexity is justified when a current, documented constraint (not a hypothetical one) genuinely requires it — e.g., the confidentiality query-guard (Phase 0, E0.2) is new, non-trivial engineering, justified because Hard Invariant 3 is a real, present constraint, not a speculative one.

---

## 3. Data Philosophy

**Principles:** data is permanent; documents are evidence, never discarded; facts are extracted from documents, not asserted independently of them; knowledge is built from connecting facts, not from facts in isolation; original information is never destroyed; every fact is traceable to its source; every transformation is reproducible; everything important is versioned; historical truth is never rewritten, only superseded.

**Why it exists:** this is the platform's entire technical thesis. A system that can't say *where* a fact came from, or that silently overwrites what it used to believe, is not institutional memory — it's just another opinion with a UI. The Master Workbook precedence rule (ADR-0001) and the bitemporal, supersede-never-overwrite fact model exist entirely in service of this principle.

**Long-term benefit:** the ability to answer "what did we believe when we made this decision, and what do we know now" is the mechanism the entire Decision/Outcome loop depends on. Lose this property and the platform's central value proposition collapses to "a nicer search bar."

**Correct implementation:** a fact table row that gets superseded remains queryable by `valid_time` — the old value isn't deleted, a new row points forward from it. A rent figure extracted from an invoice that contradicts the workbook is *flagged*, not silently resolved.

**Violation:** any migration or bugfix that does an `UPDATE` on a fact row instead of an insert-and-supersede. Any pipeline that writes an extracted number without a `source_doc_id`. Any agent that fills a missing figure with an inferred estimate presented at the same confidence as a verified one.

**Tradeoffs:** never deleting or overwriting means the fact store grows monotonically and storage cost is never reclaimed by simply forgetting old data. Accepted — storage is cheap; a wrongly "cleaned up" historical fact is not recoverable, and SQLite comfortably handles decades of this platform's actual data volume.

**Exceptions:** genuinely erroneous writes (a bug that wrote garbage, not a fact that was later found to be wrong) may be hard-deleted, but only via an explicit, logged, reviewable correction — never a silent cleanup script.

---

## 4. Institutional Memory

**Principle:** the platform remembers not only *what* was decided, but *why* — including rejected alternatives, mistakes, and the reasoning behind reversed decisions — and makes that reasoning discoverable by someone who wasn't in the room.

**Why it exists:** a future employee, partner, or Claude Code session reading "we passed on this deal" gets far less value than one reading "we passed on this deal because X, and eighteen months later the market moved the way we predicted, confirming the thesis" — or, just as valuably, "...and we were wrong, because Y." The second kind of record is what actually compounds; the first is a filing cabinet with better search.

**Long-term benefit:** avoids re-litigating settled questions, avoids repeating documented mistakes, and lets the reasoning behind a hard call outlive the person who made it.

**Correct implementation:** `docs/adr/` records why the entity-ID scheme uses natural keys instead of surrogate autoincrement, including what was considered and rejected — not just the final choice. `deal-decision-ledger.md` already captures pass/skip rationale; the Outcome Tracker agent (Phase 1) closes the loop by checking whether that rationale held up.

**Violation:** a decision record that states the conclusion without the reasoning ("we chose SQLite") is not sufficient — it must state what else was considered and why it lost (ADR-0002's actual content is the standard).

**Tradeoffs:** recording reasoning, alternatives, and rejected paths takes longer than recording just the outcome. Accepted, because the reasoning is what has resale value to a future decision-maker; the bare outcome does not.

**Exceptions:** routine, reversible operational decisions (which scheduled-task registry to use, a naming convention) don't need this treatment — reserve it for decisions matching the ADR bar (§12): expensive to reverse.

---

## 5. AI Philosophy

**Principles:** AI augments human judgment, it does not replace accountability for it; AI never silently invents a fact; every AI recommendation is explainable in terms a human can audit; confidence is always visible, never implied; uncertainty is represented honestly, including "I don't know," which is a valid and often correct answer; AI should recommend, not obscure, the reasoning behind a recommendation; humans remain accountable for every decision the AI informs; the system should become more useful over time by learning from ORA's own historical outcomes, not by retraining a model in the abstract.

**Why it exists:** this is the platform's single highest-risk area, identified in the original architecture review — an LLM stating a wrong financial figure with unearned confidence, unsupervised, is the one failure mode that can turn "institutional memory" into "a confident liar with a nice writing style" and cause a real, expensive mistake.

**Long-term benefit:** trust, sustained over years, is what lets Gabriel eventually rely on the platform's recommendations without independently re-deriving every number by hand. That trust is destroyed the first time the system is confidently wrong and no one catches it — so it must be protected structurally, not by vigilance alone.

**Correct implementation:** the deterministic-compute/LLM-narrate boundary (ADR-0005) — engines compute NOI, growth, and anomaly figures deterministically; the LLM narrates that output in prose and never originates a number. The Adversarial Verifier agent exists specifically to catch a claim that tries to cross this boundary before it reaches a human.

**Violation:** an agent that, when a figure is missing, "helpfully" estimates one and presents it with the same visual/textual weight as a verified figure. A narrative brief that states a trend without citing the underlying deterministic computation it came from.

**Tradeoffs:** this boundary means some genuinely useful AI capabilities (soft pattern-based estimates, "this will probably increase ~8%") require a separately labeled, explicitly-estimating agent rather than a quick shortcut in the Narrator. Slower to build, but the alternative erodes trust in every other number the system states correctly.

**Exceptions:** an agent explicitly designed and labeled as an estimator (clearly tagged `confidence: estimated`, never presented as verified) may produce soft predictions — the boundary is about presentation and accountability, not about forbidding estimation entirely.

---

## 6. Knowledge Graph Philosophy

**Principle:** the platform prioritizes connected understanding over isolated records — a fact's value comes substantially from what it's related to, and the system should be designed so relationships are first-class, not an afterthought bolted onto a pile of documents.

**Why it exists:** "which vendors consistently outperform across which PMs across which markets" is a relationship question, not a document-search question. A platform that stores documents well but can't answer relationship questions has built a filing cabinet with AI on top, not institutional intelligence.

**Long-term benefit:** the value of connected data compounds combinatorially as more entity types and relationships accumulate — a benefit isolated document storage never captures, no matter how much of it you have.

**Correct implementation:** the `edges` table (property→entity, lease→tenant, loan→property, vendor→work order→property) with a constrained relation-type registry, not free-text. Cross-Entity Intelligence (Phase 3) is deliberately gated on having *both* enough entities and enough relationships populated — not on graph technology sophistication.

**Violation:** treating "knowledge graph" as a technology purchase (standing up a graph database) rather than a design discipline applied to whatever storage engine is in use. Storing a fact without linking it to the entities it concerns, "to save time," leaving it functionally orphaned.

**Tradeoffs:** enforcing relationship discipline at write time is more upfront work per document ingested than dumping raw text into a search index. Accepted, because unlinked facts don't compound — they just accumulate.

**Exceptions:** none on the discipline itself; the *storage technology* used to express relationships is explicitly not fixed by this principle and may change (see ADR-0002's revisit condition) without violating it.

---

## 7. User Experience Principles

**Principles:** reduce cognitive load; surface important information automatically rather than requiring it to be searched for; prioritize recommendations over raw data dumps; keep interfaces simple; put complexity behind the scenes, not in front of the user.

**Why it exists:** the platform serves one to two working principals, not an audience of analysts who can be trained on a complex tool. If using the platform is harder than not using it, it will quietly stop being used — the single most common failure mode of internal tools built by their own beneficiaries.

**Long-term benefit:** an interface simple enough to stay in daily use for twenty years is worth more than a powerful one that gets abandoned in year two because it demands too much attention.

**Correct implementation:** the JARVIS daily brief surfacing anomalies and risk flags proactively, rather than requiring Gabriel to run a query every morning to find out if anything needs attention.

**Violation:** adding a configuration screen, a query language, or a dashboard with a dozen tunable filters because it's technically flexible — flexibility that serves a hypothetical power user this platform will likely never have, at the cost of daily usability for the one it does.

**Tradeoffs:** hiding complexity behind automatic surfacing means the system has to make judgment calls about what's important — which it can get wrong, occasionally surfacing noise or missing something a manual search would have found. Mitigated, not eliminated, by the observability principles in §10 and the Risk/Recommendation agent's precision tracking.

**Exceptions:** power-user affordances (raw SQL access, manual queries) may exist as an escape hatch for genuine edge cases, but never as the primary interface.

---

## 8. Automation Philosophy

**Principles:** automate repetitive work; never automate away understanding of *why* something happened; automation remains observable, not a black box; failures are visible, never silent; humans retain the ability to intervene; automation builds trust through transparency, not mystery.

**Why it exists:** the platform runs a real scheduled-task fleet already, and that fleet has already produced a documented incident (a registry wipe that left health-monitoring dark for weeks with zero alarm, because the one task built to detect exactly that failure was itself a fleet member and died with the registry). That incident is the concrete argument for this section, not a hypothetical.

**Long-term benefit:** automation that fails loudly and recoverably compounds trust; automation that fails silently, even once, teaches the operator to distrust the entire system, which is far more expensive to earn back than the time automation saved in the first place.

**Correct implementation:** the confidentiality guard's fail-closed design, and the existing dead-man's-switch pattern (an out-of-band watchdog that alarms when the primary automation goes dark) applied to any new scheduled process this platform introduces.

**Violation:** a scheduled ingestion or reconciliation job that fails and simply doesn't run again next cycle, with no alert, no log a human will ever read, and no distinguishable difference from "nothing new happened today."

**Tradeoffs:** building observable, fail-loud automation takes measurably longer than building a script that just runs. Accepted without exception — the documented incident above is the cost of not doing this.

**Exceptions:** none for anything touching data integrity or confidentiality. Genuinely low-stakes, easily-noticed-if-broken automation (e.g., a cosmetic formatting pass) may have lighter observability.

---

## 9. Quality Standards

**Principles:** no silent failures; no hidden assumptions; no undocumented behavior; no orphaned data; no unexplained AI outputs; no irreversible changes without safeguards; every important capability is testable; every important decision is reviewable.

**Why it exists:** these are the platform's non-negotiable floor. Each one names a specific, previously-observed failure mode in this repo or its operating history (silent send failures, the registry-wipe incident, the workbook/warehouse NOI disagreement) rather than being aspirational boilerplate.

**Long-term benefit:** a system that fails loudly and reversibly can be trusted to grow in scope over twenty years without accumulating undetected corruption. One that doesn't will eventually be trusted less than a spreadsheet, at which point it has failed at its actual mission regardless of how sophisticated it is.

**Correct implementation:** the `warehouse:verify`/`warehouse:drift` gate steps and the reconcile-to-$0 check already enforce "no orphaned data" and "no silent failures" for the financial warehouse; the Data Quality Framework (Phase 4) extends the same discipline to the facts/edges layer.

**Violation:** a migration that adds a nullable column "for now" with the intent to backfill later and no tracked ticket or review date for doing so — this is a hidden assumption with no accountability trail, prohibited outright by §14 (Technical Debt).

**Tradeoffs:** meeting this bar makes every capability slower to ship. This is the correct tradeoff for a system whose entire purpose is being trustworthy over decades — a fast-but-untrustworthy version of this platform has negative value, not merely lower value.

**Exceptions:** none. This section is the floor other sections' exceptions may not go below.

---

## 10. Security and Trust

**Principles:** protect confidential information as a structural property of the system, not a policy reminder; minimize access to the minimum necessary; audit important actions; encrypt sensitive information at rest and in transit where it leaves the local machine; maintain complete, tamper-evident change history; trust is earned through transparency, not asserted.

**Why it exists:** Hard Invariant 3 (active confidential deals never surface externally until closing) is not a platform-specific rule — it is a firm-level constraint this platform must never be the mechanism that violates. The entire value of connecting everything to everything raises, not lowers, the stakes of a confidentiality failure.

**Long-term benefit:** a platform that has never leaked confidential deal terms in twenty years of operation is one Gabriel can keep expanding without second-guessing each new connection it draws. One near-miss changes that calculus permanently.

**Correct implementation:** ADR-0004 — confidentiality tier as a required, non-null schema column set at write time, enforced by a query-layer guard with a zero-false-negative test bar, extending (not replacing) the existing egress-only `confidentiality-guard.py` pattern.

**Violation:** any read path — narrative brief, semantic search, cross-entity query — that can surface a `deal-confidential` fact without an explicit, tested authorization check. Treating confidentiality as something checked only on the way out to an external system, rather than on every internal read.

**Tradeoffs:** confidentiality checks on every read path add latency and engineering surface area that a fully open internal system wouldn't need. Non-negotiable — the cost of the check is bounded and known; the cost of a leak is not.

**Exceptions:** none on the zero-false-negative bar itself. The *tier taxonomy* (currently three tiers) may expand if a real need is documented — that's an amendment to implementation, not to this principle.

---

## 11. Documentation Philosophy

**Principles:** code explains implementation; documentation explains intent; Architecture Decision Records explain reasoning; a future developer (human or AI) should never have to guess why something exists; documentation is a product deliverable, not an afterthought.

**Why it exists:** this platform is disproportionately likely to be operated, session to session, by an AI agent with no persistent memory of prior conversations. Documentation is not a courtesy to a future hire — it is the *only* channel through which a fresh Claude Code session inherits twenty years of context. This makes documentation quality a functional requirement of the system, not a nice-to-have.

**Long-term benefit:** every hour spent writing a clear ADR or a clear roadmap section saves many hours of a future session re-deriving the same reasoning from scratch, or worse, silently making a different, conflicting decision because the original reasoning was invisible.

**Correct implementation:** the documentation placement table in `docs/roadmap/intelligence-platform/02-standards-testing-quality.md` — a specific answer for "where does this kind of writing go," so the choice isn't re-litigated every session.

**Violation:** a comment or commit message that states *what* changed without *why* — the codebase's existing convention (no comments unless the why is non-obvious) already reflects this principle and should not be silently eroded by future sessions defaulting to verbose restatement.

**Tradeoffs:** the documentation discipline this requires is more upfront effort than "just ship the code." Accepted as necessary specifically because of the AI-operator reality above — this tradeoff would be harder to justify for a team with continuous human institutional memory, but ORA does not have that.

**Exceptions:** none for anything governed by §12's ADR bar. Routine, self-evident code changes do not need prose explanation beyond what the diff itself shows.

---

## 12. Architectural Decision Records

**Principle:** major, hard-to-reverse decisions require a formal ADR recording the problem, context, alternatives considered, the decision, its tradeoffs, expected consequences, and the conditions under which it should be reconsidered. Rejected alternatives remain permanently searchable, not deleted when superseded.

**Why it exists:** established as a new convention by this initiative (the repo had none before) precisely because the platform's early, foundational choices — storage engine, entity identity, confidentiality model — are exactly the kind of decision this document elsewhere identifies as expensive to reverse. A decision that expensive deserves more than a commit message.

**Long-term benefit:** a future session (or future Gabriel) reconsidering "why don't we just use a graph database" gets ADR-0002's actual reasoning and revisit conditions instead of re-litigating from zero or, worse, reversing a decision without understanding what it cost the first time.

**Correct implementation:** ADR-0001 through ADR-0005, each following the format in `docs/adr/README.md` — and the discipline in that README that most PRs do *not* need one, reserving the format for decisions matching the "expensive to reverse" bar.

**Violation:** writing an ADR for a routine, easily-reversible choice (bloating the record and diluting its signal), or — the more dangerous failure — making a decision that *should* have had an ADR without one, leaving a future session to reverse-engineer intent from code alone.

**Tradeoffs:** the ADR discipline adds a documentation step to already-slow foundational decisions. Accepted, because the whole point of moving carefully on these specific decisions is defeated if the reasoning isn't preserved.

**Exceptions:** an ADR may itself be superseded by a later ADR that explicitly references it and states why — but a superseded ADR file is never deleted or rewritten, per §3's historical-truth principle.

---

## 13. Evolution

**Principles:** the platform is expected to change continuously; design for change rather than against it; expect new AI models, new databases, new document types, and new workflows to arrive over twenty years; prefer evolutionary architecture (additive, incremental) over rewrites.

**Why it exists:** nothing named in this document as a specific technology — SQLite, Claude, vitest, Excel — is expected to still be the right choice in year twenty. What must survive is the shape of the guarantees (traceable facts, versioned history, a deterministic/narrative boundary), not the tools currently satisfying them.

**Long-term benefit:** a platform designed to evolve incrementally never accumulates the kind of debt that forces a total rewrite — which is where institutional memory actually gets lost in practice, not through malice but through "we'll migrate the old data later" promises that don't get kept.

**Correct implementation:** ADR-0002's explicit revisit condition (portfolio grows an order of magnitude, or a query pattern SQL genuinely can't express) rather than a vague "we might change this someday" — a concrete, checkable trigger for when evolution is warranted.

**Violation:** a "rewrite the platform on a new stack" project that doesn't have a migration path preserving every existing fact's lineage — this would violate §3 regardless of how good the new stack is.

**Tradeoffs:** evolutionary architecture is sometimes slower to adopt a genuinely superior new technology than a clean-slate rewrite would be. Accepted — the data continuity cost of a rewrite is categorically higher than the opportunity cost of adopting new technology a version behind the state of the art.

**Exceptions:** a component with no persistent state of its own (e.g., which specific LLM model powers the Narrator) may be swapped outright without triggering rewrite concerns, because nothing about it holds irreplaceable history.

---

## 14. Technical Debt

**Principles:** some technical debt is acceptable; *undocumented* technical debt is not. Every deliberate shortcut records: the reason it was taken, an owner, the risk it carries, a removal strategy, and a review date.

**Why it exists:** a two-person operation will inevitably take shortcuts under time pressure — that's not a discipline failure, it's reality. What turns an acceptable shortcut into a liability is losing track of it, which is exactly what happens without a forcing function to record it.

**Long-term benefit:** a debt registry that's actually current means a future session can make an informed tradeoff ("is this the year we finally fix the placeholder insurance-loss import") instead of discovering the shortcut by surprise, mid-incident, years later.

**Correct implementation:** the existing `docs/placeholder-data.md` doctrine — placeholder fixtures are explicitly flagged with a `dataSource` discriminator, real-data swap paths are documented per fixture, and calibration writes are hard-blocked while any input is a placeholder. This is technical debt done correctly: visible, bounded, and impossible to accidentally treat as real data.

**Violation:** a `// TODO: fix later` with no owner, no date, and no tracked follow-up — indistinguishable, six months later, from a decision no one remembers making.

**Tradeoffs:** recording debt properly takes a few minutes longer than leaving a bare comment. Trivial cost relative to what it prevents.

**Exceptions:** none — if a shortcut is worth taking, it's worth the several minutes it takes to record why.

---

## 15. Competitive Advantage

**Principle:** the purpose of this platform is not the technology — it is building a company that becomes smarter every year it operates. Competitive advantage comes from accumulated, connected, correctly-labeled knowledge of ORA's own operating history, which compounds and which no competitor can purchase or replicate, because it can only be built by living the history.

**Why it exists:** this is the mission (§1) restated as a competitive thesis, and it's the tiebreaker principle when other sections seem to conflict — if a proposed direction doesn't increase the durability or connectedness of accumulated knowledge, it is not advancing the platform's actual purpose regardless of its technical merit.

**Long-term benefit:** every other advantage in real estate (capital access, broker relationships, deal flow) is available to competitors with enough money. Twenty years of ORA's own, correctly-tracked underwriting accuracy is not — it is the one asset this specific platform can build that nothing else can substitute for.

**Correct implementation:** every roadmap phase in `docs/roadmap/intelligence-platform/00-master-roadmap.md` is justified in terms of what future decision it improves, not what it demonstrates.

**Violation:** building platform features aimed at looking impressive to an outside audience (investors, a future buyer of the firm) rather than genuinely improving ORA's own decisions — this platform is not being built to be sold or shown off; it's being built to be used.

**Tradeoffs:** none identified — this principle has no cost, only a discipline requirement (asking "does this compound?" before building).

**Exceptions:** none.

---

## Immutable Principles

The following require extraordinary justification to modify — not a routine amendment (§16), but a deliberate, documented decision that the platform's core thesis itself is changing:

1. **Never lose a source document.** The original, unmodified evidence is preserved permanently, independent of any extraction or interpretation built on top of it.
2. **Every extracted fact is traceable to its source.** A fact with no citation is not institutional memory — it's an unverifiable claim, indistinguishable from a guess.
3. **AI never fabricates a company fact.** A missing number is represented as missing, never silently estimated and presented at the confidence of a verified figure.
4. **Every important decision is explainable in terms a human can audit** — not merely "the model said so."
5. **Historical information is never overwritten** — only superseded, with the prior state permanently queryable.
6. **Institutional knowledge belongs to the company, not to whoever happened to record it** — the platform, not any individual's memory or personal files, is the durable home for it.
7. **Confidentiality is enforced structurally, not by convention** — a confidential fact cannot leak through a read path that forgot to check for it, because the check is not optional infrastructure.

---

## 16. Amendment Process

*(Added by the founding review — not present in the original brief, and flagged as such in the self-critique below, because a document that claims twenty-year authority without a stated way to change itself is a design gap, not a strength.)*

- **The 15 numbered sections** may be amended by documented, explicit decision — record the amendment the same way an ADR records a decision: what changed, why, what was considered, and the date. Amendments are appended to a change log at the bottom of this file; the body of the constitution is edited in place, but the change log preserves what it used to say, per §3's own historical-truth principle applied reflexively to this document.
- **The Immutable Principles** require a higher bar: an explicit, standalone written justification for why the platform's core thesis has changed, not merely why an implementation detail has. Treat reversing one of these seven as equivalent in gravity to renaming the company.
- **This document does not self-amend via routine PR review.** A change to `docs/constitution/ENGINEERING_CONSTITUTION.md` should be a deliberate act, not incidental to an unrelated docs update.

## Change log

- 2026-07-29 — v1.0 drafted (this document), covering all 15 requested sections plus the Immutable Principles, Amendment Process (§16, added independently — see self-critique), and this change log (added independently, for the same reason). Not yet ratified.

---

## Self-Critique

**Missing from the original brief, added independently:** an amendment process (§16). A document asserting it governs the next twenty years without a stated mechanism for its own change is either going to be silently ignored the first time it becomes inconvenient, or ossify the platform against genuinely necessary evolution. Both outcomes defeat the point of writing it down. Added, and flagged here rather than presented as if it were always part of the brief.

**Weak principle, on reflection:** §7 (User Experience) is the section with the least connection to institutional-memory durability — it's good product sense, but it doesn't carry twenty-year weight the way §3 or §10 do. Kept, because a platform no one uses accumulates no institutional memory regardless of how sound its data model is, but it's honestly the section most likely to need loosening as ORA's usage patterns mature (e.g., if a second analyst joins and needs a different interface than Gabriel does).

**Overly rigid, flagged rather than softened:** §9's "no exceptions" stance and §14's "no exceptions" stance are both absolute by design — softening either would reopen exactly the failure modes (silent send failures, undocumented shortcuts) this document exists to close off. Left rigid deliberately; if either ever needs an exception, that need itself is evidence the exception should be an amendment (§16), not a quiet carve-out.

**Genuine risk of hindering innovation:** §10's zero-false-negative bar on the confidentiality guard, combined with §12's ADR discipline, could slow a fast-moving prototyping session to a crawl if applied indiscriminately to exploratory work. Mitigation, not yet fully resolved: these standards should bind anything touching real confidential data or shipping to the live platform, but a clearly-labeled experimental/throwaway branch operating on synthetic data should not need to clear the same bar before a human even decides the idea is worth pursuing. This distinction is not yet formalized anywhere in this document and should be — flagged as an open gap rather than quietly resolved by writing an exception that could be misused to bypass real safeguards.

**Contradiction check:** §2 (favor simple systems) and §9/§10 (rigorous, non-negotiable quality/security floors) are in tension by nature — rigor generally costs simplicity. Resolved deliberately, not accidentally: §2 governs *architectural* choices (which database, how many services), where simplicity wins by default; §9/§10 govern *correctness and safety* properties, where rigor wins regardless of the complexity cost. The two sections apply to different axes of a decision, not the same axis — worth stating explicitly here so a future reader doesn't read them as contradictory guidance on the same question.

**Revision made as a result of this critique:** added §16 and the open gap noted above about experimental work; no other sections were rewritten, because the self-critique did not surface a principle that was actually wrong — only one genuine omission (amendment process) and one genuinely unresolved edge case (experimental-work exemption), both now on record rather than papered over.
