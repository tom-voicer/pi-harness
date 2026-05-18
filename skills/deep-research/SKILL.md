---
name: deep-research
description: >-
  Conduct thorough, multi-source research on a concept, topic, claim, person,
  product, or open question. Use this skill whenever the user asks to "research,"
  "investigate," "look into," "do a deep dive on," "write a report on," or wants
  more than a quick lookup — including comparisons, literature reviews, market
  scans, due diligence, fact-checks, and explainers requiring synthesis across
  multiple sources. Default to this skill when the question is broad, contested,
  time-sensitive, or would benefit from triangulation across sources, even if the
  user does not say the word "research."
---

# Deep Research

Deep research means investigating a question with enough rigor that the answer
would survive scrutiny from a skeptical, informed reader. It is **not** "search
once and paraphrase the top result." It is: plan → gather → triangulate →
synthesize → cite, with explicit handling of uncertainty.

Follow the research loop below. Stop early when the question is genuinely
answered; do not pad.

---

## Research Depth Levels

Adapt depth to the request. If unclear, default to Level 2.

| Level | Label | When to use | Target output |
|-------|-------|-------------|---------------|
| 1 | **Quick Research** | User asks for a fast overview, a single fact-check, or a "what is X" that needs 2–3 sources max | Definition, why it matters, 1–2 key facts with sources, one-sentence recommendation |
| 2 | **Standard Deep Research** | Default. User asks to "research," "investigate," compare options, or understand a concept | Full concept report with source-backed synthesis, alternatives, tradeoffs, and practical recommendations |
| 3 | **Expert Deep Research** | User asks for architecture/strategy/investment-level analysis, due diligence, or "everything we know about X" | Full report plus source map, technical model, historical context, ecosystem map, risks matrix, confidence levels, and open questions |

---

## Core Principles

1. **Decompose before searching.** A vague question produces vague answers. Break
   the topic into specific sub-questions you can actually look up. Searches map
   to sub-questions, not the original prompt verbatim.
2. **Triangulate.** Any non-trivial claim should have at least two independent
   sources, ideally of different types (e.g., a primary source + reporting on
   it). If only one source supports a claim, say so.
3. **Prefer primary over secondary.** Original papers, official docs, source
   code, standards, and first-party announcements beat blog posts and
   aggregators. Use secondaries to find primaries.
4. **Date-stamp everything.** For any fact that could change (prices, leaders,
   statistics, "current" anything), record when the source was published. Stale
   beats fabricated, but fresh beats stale.
5. **Track confidence explicitly.** Distinguish what is well-established, what
   is contested, what is a single-source claim, and what is your inference.
6. **Search to defeat priors, not confirm them.** If your first searches all
   agree, run at least one search designed to find disconfirming evidence
   ("X criticism", "problems with X", "X doesn't work").
7. **Stop when marginal searches stop changing the answer.** Diminishing returns
   is the signal to write up, not to keep gathering.

---

## The Research Loop

### Phase 1 — Clarify the Question

Before any tool call, write down internally:

- **The actual question** in one sentence. If ambiguous, pick the most
  plausible reading and state it in the output. Only ask the user for
  clarification if genuinely undecidable (e.g., "research Mercury" — planet,
  element, or the band?).
- **The kind of answer required.** A number? A timeline? A recommendation? A
  list of options? A yes/no with justification? An explainer? This determines
  output structure and the type of evidence needed.
- **The depth level.** Infer from stakes and breadth. Don't default to a long
  report for a question that wants a paragraph.
- **Implicit constraints.** Geography, time window, language, audience
  expertise, what the user already knows. Infer from context rather than asking.

### Phase 2 — Decompose into Sub-Questions

Turn the main question into 3–8 sub-questions whose answers, combined, answer
the main one. Good sub-questions are:

- **Specific enough to search for.** "Is X effective?" → "What does the most
  recent systematic review say about X for condition Y?"
- **Independently answerable.** Each resolves on its own evidence.
- **Collectively exhaustive.** When all are answered, the main question is
  answered. If not, add more.

Example decomposition: "Should we adopt technology X?"
1. What is X and what problem does it solve?
2. Who uses it in production and at what scale?
3. What are the documented failure modes?
4. What does it cost (license, infra, learning curve)?
5. What are the leading alternatives, and how do they compare?
6. What is the trajectory — adoption growing, flat, declining?

### Phase 3 — Plan the Search Strategy

For each sub-question, identify:

- **Likely source types** — academic papers, regulatory filings, company docs,
  news, GitHub issues, statistical agencies, expert blogs, forums. For
  scholarly topics, prefer API-first academic sources (see Academic Research
  Sources section) over general web search.
- **Best queries** — concrete keywords, proper nouns, dates, technical terms.
  Avoid filler words. Use the actual current date in time-sensitive queries.
- **What "good enough" looks like** — a specific number? A direct quote from a
  primary source? Convergence between three secondary sources?

Search query patterns for a concept `{X}`:
```
# General web
{X} official documentation
{X} architecture
{X} use cases
{X} limitations
{X} tradeoffs
{X} alternatives
{X} vs {related concept}
{X} production best practices
{X} case study
{X} criticism
{X} benchmarks
site:github.com {X}
{X} specification
{X} scaling limits

# Academic (use web_search to find DOIs/titles, then web_extract or APIs for full text)
{X} survey OR review paper
{X} systematic review
{X} state of the art
{X} dataset
{X} arXiv
{X} benchmark
```

### Phase 4 — Search Broad, Then Narrow

1. Run initial **broad searches** (1–2 queries per sub-question) to map the
   terrain: what terminology is used, who the key players are, what sources
   look like.
2. **Fetch the page** when the snippet isn't enough. Search snippets are often
   misleading or truncated. For anything load-bearing, open the actual source
   via `web_extract`.
3. **Follow citations upstream.** When a news article references a study, find
   the study. When a blog references a primary source, find the primary.
4. **Vary the approach, not the wording.** If a query didn't work, change the
   angle (different keywords, different source type), not just the phrasing.
5. Run targeted follow-ups to nail down specifics.
6. **Run the counter-case query.** If your thesis is "X works," search
   "X doesn't work" or "X criticism."

### Phase 5 — Evaluate Sources

For every source you use, ask:

- **Who produced this and what is their incentive?** A vendor's whitepaper
  about their own product is not neutral. A trade group's report on its own
  industry is not neutral. This doesn't make them useless — it makes them a
  data point about what that party claims.
- **When was it published, and is the claim still current?**
- **Is this a primary source or someone summarizing one?** If summarizing, can
  you find the original?
- **Does it cite its own sources?** Sourceless confident claims are weak
  evidence.
- **Does it contradict other sources?** If yes, investigate: who's right, and
  why do they disagree?

**Source tiers:**

| Tier | Type | Examples |
|------|------|----------|
| 1 — Primary | Official docs, peer-reviewed papers, standards, source code, specs, company engineering blogs, regulatory filings, datasets | `docs.anthropic.com`, arXiv, PubMed, OpenAlex, Semantic Scholar, Zenodo, OSF, DOAB, MIT OCW |
| 2 — Expert | Technical blogs by credible practitioners, conference talks, postmortems, case studies, academic surveys, textbooks | Staff engineer blogs, conference proceedings, OpenStax textbooks, detailed postmortems |
| 3 — Community | Forum discussions, Hacker News, Reddit, generic blog posts, vendor comparison pages | Use as leads, not as final authority. Do not use Google Scholar (no stable API), ResearchGate, or Sci-Hub. |

For academic questions, consult the full **Academic Research Sources** catalog
below for API-first scholarly sources organized by category.

Reject sources that fail on multiple criteria. Note disagreement rather than
averaging it away.

### Phase 6 — Triangulate and Resolve Conflicts

When sources disagree, ask:

- Are they measuring the same thing? (Different definitions, time windows,
  populations often produce different numbers that look like disagreement.)
- Is one more authoritative or more recent?
- Is the disagreement substantive (genuine uncertainty) or apparent
  (terminology, framing)?

Surface real disagreements: "Estimates range from A to B depending on
methodology" is more honest and useful than picking the middle. Don't
both-sides genuine consensus — if 95% of sources agree and one outlier
disagrees, represent the actual distribution.

### Phase 7 — Know When to Stop

Stop when:
- The sub-questions are answered to the depth required, OR
- Additional searches return sources you've already seen, OR
- The remaining uncertainty is structural (the answer genuinely isn't knowable
  from public sources) — say so rather than searching forever.

Do NOT stop just because you found one good source. Do NOT keep going past
diminishing returns to seem thorough.

### Phase 8 — Synthesize, Don't Summarize

A summary lists what each source said. A synthesis answers the question,
drawing on sources as evidence. Always synthesize.

- **Lead with the answer.** The first paragraph states the main finding
  plainly. Don't bury it.
- **Organize by claim, not by source.** Source-by-source structure ("Source A
  said X. Source B said Y.") is summarizing, not synthesizing.
- **Surface uncertainty inline.** Where evidence is thin, contested, or stale,
  say so in the same place you make the claim. Don't quarantine caveats at the
  end.
- **Cite inline.** Every non-obvious factual claim gets a source. Link to the
  URL.
- **Distinguish your inferences.** If you concluded something the sources
  didn't explicitly state, mark it as your inference.

### Phase 9 — Self-Check Before Delivering

Run this checklist:
- [ ] Does the lead actually answer the user's question?
- [ ] Is every load-bearing claim sourced?
- [ ] Are dates given for time-sensitive facts?
- [ ] Have I represented disagreement where it exists?
- [ ] Have I distinguished established fact from contested claim from my inference?
- [ ] Did I search for evidence against my conclusion?
- [ ] Is anything here I can't point to a source for? (Source it or remove it.)
- [ ] Can this be 30% shorter without losing substance? (If yes, cut it.)

---

## Output Formats

Match format to the request:

### Level 1 — Quick Research
1–3 sentence answer with sources. No headers needed. Example:
> **Answer:** X is a Y that does Z. It's primarily used for A and B.
> Key tradeoff: C vs D. [Source 1], [Source 2]

### Level 2 — Standard Deep Research

```markdown
# Deep Research: [Concept]

## Executive Summary
The most important findings in 3–5 sentences.

## 1. What It Is
Plain-language definition, technical definition, domain, related terms,
common confusions.

## 2. Why It Exists
The problem it solves and the context that created it.

## 3. How It Works
Conceptual and/or technical explanation with components and flow.

## 4. Main Use Cases
Where and why people use it, with concrete examples.

## 5. Alternatives and Comparisons
Table or structured comparison with adjacent concepts/tools/approaches.
When to choose this vs. alternatives.

## 6. Tradeoffs
Advantages, limitations, hidden costs, operational risks, scaling risks.

## 7. Current Ecosystem
Important tools, companies, frameworks, papers, standards, or implementations.

## 8. Practical Recommendations
When to use it, when not to use it, how to start, common mistakes.

## 9. Open Questions
Things that remain unclear or require more investigation.

## 10. Sources
Grouped by tier (Primary, Expert, Community). Each with URL and what it contributed.
```

### Level 3 — Expert Deep Research

All of Level 2, plus:

```markdown
## Additional sections:
- **Historical Context** — how the concept evolved, key milestones
- **Technical Model** — detailed architecture, data flow, component interactions
- **Ecosystem Map** — competitors, complements, dependencies, power dynamics
- **Risks Matrix** — probability × impact for key failure modes
- **Implementation Roadmap** — phased adoption plan if relevant
- **Confidence Levels** — high/medium/low confidence for each major claim
- **Source Map** — every source with reliability rating and key claims extracted
```

---

## Sensitive-Topic Adjustments

- **Medical, legal, or financial questions:** Provide the factual landscape
  (what the evidence and rules say). Explicitly note this is not personal
  advice. Recommend a qualified professional for decisions. Cite official
  sources (regulators, professional bodies, peer-reviewed literature) before
  secondary commentary.
- **Contested political or moral questions:** Present the strongest version of
  each major position with the reasoning and evidence its proponents cite. Do
  not flatten into a centrist mush, and do not pick a side as if you had
  settled it. Distinguish empirical disagreement (resolvable with evidence)
  from value disagreement (not resolvable with evidence).
- **Claims about real people:** Stick to what reputable sources have reported.
  Distinguish allegations from established facts. Avoid speculating about
  motives, mental states, or private matters.

---

## Common Failure Modes

| Failure | Description | Fix |
|---------|-------------|-----|
| **Search-and-paraphrase** | Running one search and rewording the top result | Treat any single-source claim as a lead, not a conclusion |
| **Confirmation loop** | Running only queries that support a hypothesis | Always include at least one counter-case query |
| **False precision** | "73% of companies report X" from a 200-respondent vendor survey | Match claim confidence to evidence strength; note sample sizes |
| **Stale-as-fresh** | Treating a 2019 figure as current | Always check publication dates; note when data is from |
| **Source laundering** | Citing a news article that cites a study | Reach for the primary source whenever possible |
| **Both-sidesing consensus** | "Opinions are divided" when 95% of experts agree | Represent the actual distribution of views |
| **Hiding uncertainty** | "It is believed that…" without attribution | Be specific: "X's 2025 paper argues…" or "Community consensus holds…" |
| **Padding** | Long output to seem thorough, not because substance demands it | Cut anything that doesn't advance the answer |
| **Over-delegating** | Spawning too many parallel searches for simple queries | Match effort to question complexity. Simple fact = 2-3 searches, no more |
| **SEO trap** | Picking SEO-optimized content farms over authoritative sources | Prefer academic PDFs, official docs, and known-expert blogs even when lower-ranked |

---

## Academic Research Sources

When the research question touches on scholarly, scientific, or technical
knowledge, prioritize academic sources over general web search. The sites below
each have stable public APIs or structured data — prefer them over SEO-heavy
general web results for academic claims.

**Key rule:** API first, bulk dump second, browser scraping last.

**How to use these with available tools:** Since these sites expose structured
web interfaces in addition to APIs, use `web_search` with site-scoped queries
to surface relevant papers/metadata, then `web_extract` to pull full content.
Examples:
- `web_search` — `"site:arxiv.org {topic}"`, `"site:openalex.org {author}"`
- `web_extract` — pull abstract pages, full-text HTML, or dataset metadata
- For DOIs found in sources, construct URLs directly: `doi.org/{DOI}` →
  check Unpaywall for OA version, then `web_extract` the available full text

### Suggested agent stack

Wire sources in this order depending on what you need:

| Need | Primary tool | Fallback |
|------|-------------|----------|
| Discover papers | OpenAlex, Semantic Scholar | General `web_search` seeded with author/title |
| Normalize metadata | Crossref (DOI lookup) | — |
| Get full text (legal OA) | Unpaywall → CORE → arXiv → Europe PMC/PubMed Central | Direct `web_extract` on publisher page |
| Find datasets/artifacts | Zenodo, Dataverse, OSF, Figshare | `web_search` with "dataset" keyword |
| Books / course context | DOAB, OpenStax, MIT OCW | General `web_search` |
| Code / benchmarks | GitHub (seeded by paper metadata) | Papers with Code historical data dump |

### Source catalog

#### 1. Broad academic search / metadata

| Site | Best use | Access method |
|------|----------|---------------|
| **OpenAlex** | Global scholarly graph: papers, authors, institutions, topics, venues | REST API + data snapshot — `openalex.org` |
| **Semantic Scholar** | Paper search, citations, recommendations, author/paper graph | Official REST API — `semanticscholar.org/product/api` |
| **Crossref** | DOI metadata, publication metadata, funding, licenses | Public REST API returning JSON — `crossref.org/documentation/retrieve-metadata/rest-api` |
| **Unpaywall** | Find legal open-access versions of papers by DOI | Free REST API — `unpaywall.org/products/api` |

#### 2. Open papers and full text

| Site | Best use | Access method |
|------|----------|---------------|
| **arXiv** | Preprints in CS, AI, math, physics, statistics, quant finance | Public API + OAI-PMH metadata harvesting — `info.arxiv.org/help/api` |
| **CORE** | Aggregated open-access papers from repositories and journals | API for metadata and full-text/PDF access — `core.ac.uk/documentation/api` |
| **PubMed** | Biomedical and life-science citations | NCBI E-utilities API — `ncbi.nlm.nih.gov/home/develop/api` |
| **Europe PMC** | Biomedical/life-science literature, open full texts, grants | REST APIs + annotations API + OAI service — `europepmc.org/RestfulWebService` |
| **DOAJ** | Peer-reviewed open-access journal discovery | Curated OA journal directory — `doaj.org` |
| **ERIC** | Education research | Education-focused search with full-text filter — `eric.ed.gov` |

#### 3. Research datasets and artifacts

| Site | Best use | Access method |
|------|----------|---------------|
| **Zenodo** | Research outputs: datasets, software, papers, posters | REST API — `developers.zenodo.org` |
| **Harvard Dataverse** | Research datasets across disciplines | Dataverse APIs — `data.harvard.edu/dataverse` |
| **OSF / Open Science Framework** | Research projects, preregistrations, materials, datasets | Public API — `developer.osf.io` |
| **Figshare** | Research outputs: datasets, figures, media, nontraditional artifacts | JSON API v2 — `docs.figshare.com` |
| **Dryad** | Curated research data repository (esp. biology/ecology) | `datadryad.org` |

#### 4. Books, textbooks, and course material

| Site | Best use | Access method |
|------|----------|---------------|
| **MIT OpenCourseWare** | Course notes, assignments, lectures, syllabi | Open educational material — `ocw.mit.edu` |
| **OpenStax** | Free peer-reviewed textbooks | Structured textbook content — `openstax.org` |
| **DOAB** | Peer-reviewed open-access academic books | Open book discovery + REST API — `doabooks.org` |
| **Open Yale Courses** | Introductory Yale course lectures and materials | Downloadable lectures, transcripts, syllabi — `oyc.yale.edu` |

#### 5. Code, benchmarks, and reproducibility

| Site | Best use | Access method |
|------|----------|---------------|
| **GitHub** | Research code, replication packages, lab repos | `web_search` seeded by paper metadata (author, repo name). Noisy if searched blind. |
| **Papers with Code** | ML papers linked to code, datasets, methods, evaluation tables | Historical data dump on GitHub (`github.com/paperswithcode/paperswithcode-data`). Current service less reliable than OpenAlex/Semantic Scholar + GitHub search. |

### Sites to avoid as primary academic sources

Do **not** rely on these as core automated sources:

- **Google Scholar** — no stable public API; useful for humans, poor for agents.
- **ResearchGate / Academia.edu** — often account-gated and inconsistent.
- **Sci-Hub or paywall bypass sites** — legal/compliance risk.
- **Publisher pages alone** — useful for verification, but access and metadata quality vary.

---

## Tools and Capabilities

This skill uses the available web tools:

- **`web_search`** — for discovering sources. Run multiple queries with
  different angles. Start broad (short queries) then narrow (specific terms).
- **`web_extract`** — for reading full page content. Use when search snippets
  are insufficient. Batch up to 20 URLs in one call. Extract depth: 'advanced'
  for article-style pages, 'basic' for API docs.

Search heuristics (from Anthropic's research engineering):

1. **Start wide, then narrow** — explore the landscape before drilling into
   specifics. Short, broad queries first; evaluate what's available; then
   progressively narrow focus.
2. **Match tool to intent** — web search for broad external exploration;
   specialized lookups (GitHub, docs sites) for specific source types.
3. **Parallelize independent searches** — when sub-questions don't depend on
   each other, run searches in parallel via separate `web_search` calls.

---

## Quick Reference: The Loop in One Screen

```
1. CLARIFY   — Restate the question, kind of answer needed, depth level
2. DECOMPOSE — Break into 3–8 sub-questions
3. PLAN      — For each: source types, best queries, "good enough" criteria
4. SEARCH    — Broad → narrow. Fetch primaries. Run counter-case query.
5. EVALUATE  — Each source: who, when, primary?, cited?, contradicts?
6. TRIANGULATE — Surface real disagreement; don't average
7. STOP      — At diminishing returns, not at first plausible answer
8. SYNTHESIZE — Lead with answer. Organize by claim, not source. Cite inline.
9. SELF-CHECK — Sourced? Dated? Disagreement surfaced? Padding cut?
10. DELIVER   — Match format to depth level. No padding.
```
