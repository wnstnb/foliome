# The wiki

The agent's durable memory: plain markdown under `data/wiki/` (gitignored, personal). It answers one question: **what do we currently believe, and on what evidence?**

Pages are organised by **kind of claim**, not by subject. Each page has a status, so a reader can tell a standing belief from one that was later disproved. Nothing is deleted. A wrong page is re-statused and points at what replaced it, so the same mistake isn't proposed twice.

## Kinds

| Kind | Folder | What it holds | Statuses |
|---|---|---|---|
| goal | `goals/` | Something the household is working toward, with a live number (`headline`) | active · parked · closed |
| decision | `decisions/` | A call the household made, or a rule the agent follows. Reads as a rule | active · parked · closed |
| finding | `findings/` | Something learned about the money or the data, backed by evidence | standing · refuted · superseded |
| context | `context/` | A fact about the household's life (pay schedule, childcare, a trip) | active · parked · closed |
| reflection | `reflections/` | Monthly reflection, one page per month (`YYYY-MM.md`) | active (current month) · closed |
| source | `sources/` | An ingested article or video, summarised | active · closed |

## Page header

Every page starts with YAML frontmatter:

```yaml
---
type: finding                # goal | decision | finding | context | reflection | source
status: standing             # see the table above
title: PayPal purchases hide the real merchant   # the claim; also the H1
short: PayPal hides merchants                     # ≤ 40 chars, for lists and chips
topic: spending              # spending | cash-flow | investing | planning | data-quality | sync | household | tax
created: 2026-07-09
updated: 2026-10-02
tags: [paypal, classification]
sources: [transactions, config/category-overrides.json]   # where the evidence lives
headline: 53% ($42,300 of $80,000)   # goals only: the current key number
superseded_by: uncategorized-spending-dropped              # refuted/superseded findings only
---
```

`short`, `headline` and `superseded_by` are optional except as noted. Sources' pages may also carry `source_url` and `source_type`.

## Page shape

- **The title is the claim.** "A sync can say OK while one account failed", not "Sync status issue".
- **The first paragraph is the answer**, with its key number, in one or two sentences.
- Then, as the page needs them: `## Evidence`, `## What it means`, `## Caveats`, `## Open`, `## Related`.
- **Every number traces to a source** named in the header or the Evidence section.
- `## Open` holds a checklist (`- [ ] …`). The Wiki tab gathers every unchecked item onto its home view; check or strike one through to drop it.
- Machine-written blocks sit between `<!-- auto:start -->` and `<!-- auto:end -->`. Automated jobs rewrite only inside the markers, so hand-written notes survive.

## Links

`[[slug]]` links to another page by file name (without `.md`). Slugs are unique across folders, so a page can change kind without breaking links. `[[slug|label]]` sets the link text. Backlinks are computed when the wiki is read, never stored.

## Index, log and check

- `data/wiki/index.md` is generated from page headers: `node scripts/wiki.js index`. Never hand-edit it. Run it after adding, renaming or re-statusing a page.
- `data/wiki/log.md` is dated, newest first.
- `node scripts/wiki.js check` lists broken links, pages missing a type, status, title or updated date, statuses that don't fit the kind, and one-way links.

## Writing rules

- **Capture it twice rather than miss it once.** CLAUDE.md lists what triggers a page.
- **Edit in place.** Never overwrite a page you haven't read in this session.
- **Re-status, don't delete.** A finding proved wrong becomes `refuted` with `superseded_by` and a line saying why.
- Before quoting a number or re-arguing a decision, read the page. Never quote a refuted or superseded page as current.
