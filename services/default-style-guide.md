# Review Writing Style Guide

This document describes the writing style used in the example academic paper reviews in this folder. Use it to match voice, tone, structure, and phrasing when drafting new reviews.

---

## 1. Overall Voice and Tone

- **Formal but conversational.** Reads like a thoughtful senior colleague speaking directly to the authors. Not stiff, not chatty.
- **First person is used freely.** "I suggest...", "I am not sure...", "My major notes...", "in my view". This overrides general "no first-person" preferences for other writing.
- **Constructive, not adversarial.** Critiques are paired with concrete suggestions almost every time. Tone implies the authors can fix it.
- **Direct but softened.** Hedged phrasings ("seems", "it is not clear to me", "I am not sure", "perhaps") are used when raising doubts rather than declaring authors wrong.
- **No emotional language.** No exclamation points except in rare moments of genuine surprise (e.g., "if the battery didn't last more than 30 minutes (!)"). No flattery, no harshness.
- **Acknowledges author intent before pushing back.** Often restates what the authors seem to be trying to do, then points out where it falls short.

---

## 2. Prose Conventions

- **No em-dashes.** Use `---` (triple hyphen) or commas or parentheses instead.
- **Tight, concise sentences.** Avoid extended formulations that draw juxtapositions or balance multiple concepts unless necessary.
- **Plain language.** Prefer simple, direct word choice over technical-sounding alternatives.
- **Fragments in bullets are fine.** "Timely; hand tracking is increasingly used." Don't force complete sentences inside short bulleted lists.
- **Quoted phrases from the paper appear in double quotes.** When critiquing specific wording, quote it directly: `the paper writes "memoryful" does not seem to be a word`.
- **Line numbers and section references are specific.** "line 318", "Sec. 3.2", "Fig. 4", "the first sentence of the abstract". This gives authors something concrete to act on.
- **Edit suggestions use the arrow notation:** `"developers are allowed to extensive modify" -> "...extensively modify"`.
- **Numbers and units stay tight.** Don't pad with extra modifiers.

---

## 3. Document Structure

Every review follows roughly the same skeleton. Use markdown headers (`#`, `##`, `###`, or `***` for sub-sections). Headers are pragmatic, not rigid.

### 3.1 Header / Title
Start with the paper's submission number and title as a single line or top-level header. Examples:

- `1234: An Example Paper Title for an Interactive System Study`
- `# SUMMARY` (when the paper title is implicit from the file name)

### 3.2 Summary of Contributions (1 paragraph)
One paragraph. Describe what the paper does in plain terms: type of study, N, methods, key findings. No evaluation here. Examples:

> This paper presents a within-subjects user study (N = 24) about how different feedback modalities of an example interactive system affect task performance and user experience during a representative task. The study showed that one modality led to better performance on some measures, but a combined condition was most preferred by participants.

### 3.3 Strengths (2-3 bullets)
- Use `+` as the bullet marker.
- Keep to 2-3 short, denser bullets. Trim weakly supported or redundant items.
- Use fragments. Example: `+ Address an important usability problem.`
- Common strength themes: topic timeliness, study well-conducted, analysis seems correct, replicability, video helps clarity, well-written, relevance to the community.

### 3.4 Weaknesses (2-4 bullets)
- Use `-` as the bullet marker.
- Consolidate related issues into denser bullets. Granular items belong in the detailed sections below.
- One-line summaries; details come later.
- Example: `- Lack of depth in motivation, related work, and discussion sections.`

### 3.5 Optional Transition / High-Level Critique
After the bullets, often a horizontal rule (`---`) followed by 1-2 paragraphs framing the overall concern or noting how the detailed comments are organized. Example:

> My major notes are grouped below according to Presentation, Technical Soundness, Reproducibility, References, and Minor Issues.

or

> In general, the paper's contributions are rather wide-ranging and come across as unfocused...

### 3.6 Detailed Critique Sections
Two common organizing schemes. Pick whichever fits the venue's review form, but be consistent within a review:

**Scheme A: by review criteria** (used for CHI-style forms)
- `*** Originality: new ideas or approaches for HCI`
- `*** Significance: strength of contributions`
- `*** Research quality: usefulness of results`
- `*** Previous work`
- `*** Presentation clarity`
- `*** Minor edits`

**Scheme B: by content area**
- `# Presentation`
- `# Technical Soundness / Research Quality`
- `# Reproducibility`
- `# References`
- `# Minor Issues`

Or a hybrid:
- `*** Framing / Motivation`
- `*** Related Work`
- `*** Methodological Clarifications`
- `*** Results Clarifications`
- `*** Discussion Points`
- `*** Presentation`
- `*** Minor Edits`

Each section is a bulleted list of specific, addressable comments.

### 3.7 References (when notes include suggested citations)
Inline the full bibliographic entries directly in the relevant section (typically Related Work / Previous Work), not in a trailing appendix. Always include URL or DOI. Example:

> [1] Author, A., Author, B., & Author, C. (2024). An Example Paper Title. arXiv preprint arXiv:0000.00000.

Bracket numbers `[1]`, `[2]` are cited inline in the prose ("e.g., [1], [2]") and the full entries follow.

### 3.8 Recommendation (optional, venue-dependent)
A 1-3 sentence assessment at the end. Frame in terms of whether the issues are addressable through revision alone:
- "All of the critiques above should be addressable through writing alone."
- "These issues require an additional review cycle to address, so I recommend rejecting the paper."
- "The work appears fundamentally sound and I am generally on board with it."
- "I lean toward accepting this submission."
- "I lean toward recommending another revision."

---

## 4. Signature Phrasings and Constructions

These appear repeatedly. Use them as defaults.

### Softeners for raising issues
- "It is not clear to me [why / how / that]..."
- "I am not sure that..."
- "It seems that..."
- "It is a bit unclear..."
- "I find it odd that..."
- "I would expect..."
- "Perhaps..."
- "My understanding is..."

### Constructive recommendation patterns
- "The paper would benefit from [X]."
- "I suggest [X]."
- "I recommend [X]."
- "It would be helpful if [X]."
- "Consider [X]."
- "Please [clarify / improve / revise] [X]."

### Strength-of-claim markers
- "must" / "needs to" / "should" — for required fixes
- "would benefit from" / "I suggest" / "I recommend" — for strong suggestions
- "Consider" / "Perhaps" / "It may be worth" — for optional/optional-leaning suggestions
- "[minor/optional]" — explicit tag for the lowest-priority items

### Posing questions to authors
Rhetorical or Socratic questions are common and effective:
- "Is it the case that...?"
- "Why was X done?"
- "How did participants...?"
- "Was any power analysis completed?"
- "What are the implications of...?"

These push authors to justify or clarify rather than declaring them wrong outright.

### Going beyond the present study
- "It would be helpful to discuss the relevance/impact of the results beyond the limited context of this study."
- "Claims cannot be made beyond the context, but it would be great if the paper could discuss how this study contributes to a broader picture."
- "Some design guidelines derived from the findings would be useful to other researchers and practitioners."

### Common universal asks
- A **video figure** is almost always requested for highly interactive systems.
- **Hypotheses or research questions** should be explicit and presented before methods.
- **Power analysis / participant count** scrutiny when N is low.
- **Aligned Rank Transform**, **GLMM vs. LMM** questions when statistics seem mismatched to the data distribution.
- **Over-claiming on non-significant trends** is called out frequently.
- **Discussion sections** are frequently flagged as too short / not engaging prior work.

---

## 5. Critique Patterns

- **Pair each critique with a fix.** If you point out a problem, suggest at least one direction for resolving it.
- **Reference specific locations.** Line numbers, section IDs, figure numbers, table numbers. Never a vague "in the paper somewhere".
- **Quote the offending phrase.** When the issue is a sentence or word choice, quote it.
- **Distinguish strong claims from weak ones.** If authors over-claim, suggest toning down rather than removing entirely.
- **Acknowledge addressability.** Note when critiques are minor vs. require new experiments or analyses.
- **Be honest about the limits of one's own judgement.** "I am not sure this is the best way to go about clarifying this, so this reference and line of thinking is just a suggestion."
- **Concede positive aspects within negative sections.** "The study seems well-designed and the analysis seems well-conducted. One small question, was the Aligned Rank Transform performed on the original data, or on the log-transform data?"
- **Watch for LLM-generated prose.** Flag specifically if writing has "hallmarks of LLM-generated text" — wordy, redundant, generic phrasing.

---

## 6. Formatting Conventions

- **Headers:** Markdown `#`, `##`, `###`, or the alternate `***` prefix for sub-sections.
- **Bullets:**
  - `+` for strengths
  - `-` for weaknesses and most other bulleted lists
- **Horizontal rules:** `---` separates summary from detailed sections.
- **Inline emphasis:** Use `*italics*` sparingly, mainly when distinguishing words ("different *kinds* of contextualization", not "different *levels*").
- **Code-style brackets for citations:** `[1]`, `[2]`, etc.
- **Arrow for edit suggestions:** `"old text" -> "new text"`.
- **Parenthetical hedges and asides** are fine and idiomatic: `(e.g., spatialization, volume, etc.)`, `(I am neutral on whether it needs to be included)`.

---

## 7. What to Avoid

- Em-dashes (`—`). Use `---`, commas, or parentheses.
- Hyperbole, sarcasm, or any tonal sharpness.
- Long preambles or windups. Get to the point.
- Repeating the same critique in multiple sections.
- Vague generalities without a line/section/figure reference.
- Flattery or emotional support.
- LLM-generated phrasings like "delve into", "leverage", "unlock", "robust framework", "comprehensive overview". Critique these when seen in the paper itself.
- Bare critiques with no suggested direction.
- Listing every non-significant statistical result; suggest moving these to an appendix.
- A "Conclusion" or "Summary" at the end that repeats earlier points.

---

## 8. Example Skeleton

```markdown
# 1234: [Paper Title]

# Summary of Contributions

This paper presents [study type] (N = X) on [topic]. The study found [key result 1] and [key result 2].

## Strengths

+ [Strength 1, fragment OK.]
+ [Strength 2.]
+ [Strength 3.]

## Weaknesses

- [Consolidated weakness 1.]
- [Consolidated weakness 2.]
- [Consolidated weakness 3.]

---

# Detailed Comments

[Optional 1-2 sentence high-level framing of the overall concern, or a note about how the detailed sections are organized.]

## Framing / Motivation

- [Specific critique with line reference, paired with suggestion.]
- [Another point.]

## Related Work

- [Critique.]
- [Missing reference suggestion with inline citation [1].]

[1] Full bibliographic entry with DOI/URL.

## Methodological Clarifications

- [Critique.]

## Results Clarifications

- [Critique.]

## Presentation

- [Critique.]

## Minor Edits

- line X: "old phrasing" -> "new phrasing"
- Reference numbers not in order.

# Recommendation

[1-3 sentences. State addressability. State lean.]
```
