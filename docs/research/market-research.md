# Market Research: Spec Driven Development and AI Code Enforcement

Researched October 14, 2026. Figures come from public sources listed at the end and should be rechecked before any launch material.

## Summary

Spec driven development (SDD) is now an established, crowded category. Most tools focus on the workflow before code is written (spec, plan, tasks). Very few enforce rules on the code after it is written, and none do it by inferring rules from an existing codebase without spec writing. That enforcement layer, agent agnostic and zero config, is the opening.

## The category

Spec driven development treats a structured specification as the source of truth and has AI agents generate and update code against it. By mid 2026 it has a Thoughtworks Radar entry, a Martin Fowler article, a DeepLearning.AI course and academic papers. One map counts more than 30 frameworks.

Tools fall into three groups:

| Group | Examples | What they do |
|---|---|---|
| Spec first frameworks added to an existing agent | GitHub Spec Kit, OpenSpec, BMAD-METHOD, Task Master AI | Scaffold a spec, plan, tasks, implement loop in the repo |
| Spec driven IDE | AWS Kiro | Integrated requirements, design and tasks workflow |
| Spec as infrastructure | Tessl, SpecStory | Treat the spec as a long lived artifact or registry |

Commonly used rigor levels: **spec first** (spec guides the first build, then fades), **spec anchored** (spec persists and evolves), **spec as source** (only specs are edited, code is generated).

## Key players

### GitHub Spec Kit
- Open source (MIT), the category anchor
- Over 115,000 GitHub stars by June 2026, less than a year after launch
- Specify, plan, tasks, implement loop across 30+ agents including Claude Code, Copilot and Cursor
- **Weakness:** prose specs drive the first generation but don't govern the codebase afterwards. Enforcement is by convention only.

### OpenSpec
- Open source (MIT), around 56,000 stars as of June 2026
- Lightweight, proposal driven changes, integrates with 25+ tools
- Spec anchored: specs persist and evolve with the code

### AWS Kiro
- Spec driven IDE (VS Code fork) plus CLI, launched GA as the replacement for Amazon Q Developer
- Credit based pricing from free to about $200 per month
- EARS formatted requirements, steering files, hooks
- **Property based testing from specs:** extracts properties from requirements and tests code against them. This is the closest existing feature to our enforcement idea.
- **Limits:** tied to the Kiro environment, and requires writing specs up front. Does not infer rules from an existing codebase.

### Tessl
- Founded by Guy Podjarny (Snyk founder), raised $125M (Index Ventures, GV, Accel, boldstart)
- Most ambitious vision: spec as source, code as a build artifact
- Runs the AI Native Dev podcast and AI Native DevCon
- Shipped a spec registry and a spec first workflow. Reviewers describe a pivot toward governing agent sprawl in enterprises.

### Augment (Intent)
- Positions around living specs that stay in sync with code, with multi agent orchestration
- Heavily funded, enterprise focused

### Superpowers (obra)
- Open source (MIT) skills framework and development methodology by Jesse Vincent (obra)
- First published in October 2025, the same day Anthropic launched the Claude Code plugin system. Now the most popular plugin in the Claude Code ecosystem; star counts vary by source but are well into six figures
- Installs in two commands inside Claude Code; skills trigger automatically when relevant
- Enforces a disciplined workflow: brainstorm a design spec, write a task gated plan, red green TDD (it makes the agent delete code written before tests), subagent code review, systematic debugging, verification before claiming success
- **How it differs from Spec Kit:** Spec Kit is artifact centric. It scaffolds spec, plan and task files that any agent consumes. Superpowers is behavior centric. It changes how the agent works through skills that fire on their own. Spec Kit asks "what are we building?"; Superpowers asks "are you working like a senior engineer?"
- **How it relates to Holdline:** it governs process, not business rules. A well tested, well reviewed change can still break a rule nobody wrote down. Superpowers users care about discipline and are ideal Holdline users
- **Lessons for launch:** ship as a Claude Code plugin, match the two command install, and take a strong, memorable stance

### BMAD-METHOD, Task Master AI
- Popular open source workflow methods and planning tools. Workflow and planning, not enforcement.

## Adjacent competitors: AI code review

These are the first comparison people will make.

### CodeRabbit
- Dedicated AI PR reviewer, the leader on public review benchmarks
- Custom rules in `.coderabbit.yaml`, path scoped instructions, reads existing rule files (Cursor rules and similar)
- Learns preferences from review conversations
- Pre merge checks with custom pass or fail criteria, can act as a required reviewer that blocks merging
- **Weakness:** enforcement is LLM judgment per PR. CodeRabbit's own guidance admits it misses violations when rules are vague, conflicting or unmeasurable.

### GitHub Copilot code review, Greptile, Claude Code review
- Built in or standalone LLM reviewers with custom instruction files
- Same pattern: an opinion on each PR, not a deterministic check

## Formal verification ("vericoding")

- Academic and research work on generating formally verified code (Dafny, Lean, Verus)
- Largest benchmark: 12,504 specs, success rates of 27% in Lean, 44% in Verus and 82% in Dafny with off the shelf models
- Well funded startups exist in this space (Axiom raised a round led by Menlo Ventures)
- **Limits for app teams:** too heavy for normal developers, and practitioners report it tends to verify components in isolation and miss bugs between them

## What AI labs are doing

- **Platforms are building SDD:** GitHub (Microsoft) owns Spec Kit, Amazon owns Kiro.
- **Model labs mostly are not:** Anthropic, OpenAI and Google focus on general agents (Claude Code, Codex, Gemini CLI) and on extension points: instruction files (CLAUDE.md, AGENTS.md), skills, plugins, hooks and MCP. Claude Code does not ship an official SDD product.
- **Implication:** labs are building the plumbing that a tool like Holdline plugs into, not the business rule layer itself. The more likely competitor is Kiro extending property testing, or CodeRabbit making checks more deterministic.

## The gap

| | Knows your business rules | Enforces deterministically | Works on existing code without spec writing | Agent agnostic |
|---|---|---|---|---|
| Instruction files (CLAUDE.md etc.) | Yes, if written | No | Partly | Yes |
| Spec Kit, OpenSpec | Yes, if written | No | No | Yes |
| Superpowers | No (process only) | Process yes, rules no | Yes | Mostly Claude Code |
| Kiro | Yes, if written | Yes (property tests) | No | No |
| CodeRabbit and AI reviewers | Partly, learned | No (LLM judgment) | Yes | Yes |
| Existing tests and CI | Only what was tested | Yes | Yes | Yes |
| **Holdline** | **Yes, inferred and approved** | **Yes** | **Yes** | **Yes** |

## Why the gap exists

1. **Markdown is easy, verifiers are hard.** A prose spec ships in weeks. Turning rules into real checks requires deep, per stack engineering.
2. **Formal methods scare off normal developers,** so nobody made "executable but not proofs" the default.
3. **Labs prefer general agents** over opinionated frameworks.
4. **Rule inference is new.** Inferring business rules from code was not reliable until recent models.
5. **Spec drift is unsolved,** and enforcement is exactly what would fix it.

## Risks

- **Absorption:** Kiro, Spec Kit, CodeRabbit or a lab could ship a good enough version within 12 to 18 months.
- **Noise:** 30+ frameworks compete for attention. Another "spec tool" would be ignored.
- **Inference quality:** if proposed rules are wrong or trivial, users drop it after one try.
- **False positives:** a noisy PR check gets disabled quickly.

## Implications for positioning

- Don't compete with Spec Kit on workflow. Integrate with it.
- Lead with "works on your existing repo in five minutes, no specs to write."
- Differentiate from AI reviewers: approved rules checked the same way every time, with tests as proof.
- Lead launch with data: a benchmark of how often agents silently break business rules.

## Sources
- [7 Spec Driven Development Tools (SSOJet)](https://ssojet.com/blog/best-spec-driven-development-tools)
- [Spec Driven Development in 2026 (CodeMySpec)](https://codemyspec.com/blog/spec-driven-development)
- [Spec Kit vs Kiro (CodeMySpec)](https://codemyspec.com/blog/spec-kit-vs-kiro)
- [Tessl Review 2026 (CodeMySpec)](https://codemyspec.com/blog/tessl-review)
- [Best Spec Driven Development Tools (Augment)](https://www.augmentcode.com/tools/best-spec-driven-development-tools)
- [Map of 30+ agentic coding frameworks (Medium)](https://medium.com/@visrow/spec-driven-development-is-eating-software-engineering-a-map-of-30-agentic-coding-frameworks-6ac0b5e2b484)
- [Spec Driven tools comparison (GitHub)](https://github.com/cameronsjo/spec-compare)
- [Spec Kit vs Kiro vs Claude Code workflows (Glukhov)](https://glukhov.org/sv/ai-devtools/ai-coding-assistants/spec-kit-vs-kiro-vs-claude-code/)
- [Kiro: Correctness with property based tests](https://kiro.dev/docs/specs/correctness/)
- [Kiro general availability](https://kiro.dev/blog/general-availability/)
- [Tessl raises $125M (Verdict)](https://www.verdict.co.uk/tessl-125m-ai-native/)
- [CodeRabbit glossary](https://docs.coderabbit.ai/reference/glossary.md)
- [CodeRabbit guidelines best practices](https://kb.coderabbit.ai/articles/8553898196-instructions-guidelines-best-practices)
- [CodeRabbit vs Copilot code review (Morph)](https://www.morphllm.com/comparisons/coderabbit-vs-copilot)
- [Superpowers for Claude Code (Emelia)](https://emelia.io/de/hub/superpowers-claude-code-framework)
- [Claude Superpowers Skill Guide (MCP Directory)](https://mcp.directory/blog/claude-superpowers-skill-guide)
- [Superpowers on GitHub](https://github.com/obra/superpowers)
- [Vericoding benchmark](https://preprints.kavlimeetings.org/2025/09/26/a-benchmark-for-vericoding-formally-verified-program-synthesis)
- [Formally Verifying the Easy Part](https://brainflow.substack.com/p/formally-verifying-the-easy-part)
- [Spec Driven Development paper (arXiv)](https://arxiv.org/abs/2602.00180v1)
