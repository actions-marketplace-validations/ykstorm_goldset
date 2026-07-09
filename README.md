# Goldset

**Lock your AI app's behavior — golden datasets, LLM-as-judge, and structural assertions in CI.**

> A prompt edit is a code change with no compiler — it fixes one behavior and silently regresses another, and nothing fails until a user notices.

[![npm](https://img.shields.io/npm/v/@ykstormsorg/goldset.svg)](https://npmjs.com/package/@ykstormsorg/goldset)
[![CI](https://github.com/ykstorm/goldset/actions/workflows/ci.yml/badge.svg)](https://github.com/ykstorm/goldset/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-goldset.lakshyaraj.dev-blue)](https://goldset.lakshyaraj.dev)

---

## Contents

- [Why this exists](#why-this-exists)
- [Why Goldset?](#why-goldset)
- [Install](#install)
- [Quickstart](#quickstart)
- [Three runners](#three-runners)
- [GitHub Action](#github-action)
- [API reference](docs/API.md)
- [Architecture](docs/architecture.md)
- [Setup guide](docs/SETUP.md)
- [Contributing](CONTRIBUTING.md)

---

## Why this exists

Goldset started after a wording change in one section of Homesty's production
system prompt silently shifted refusal behavior three sections away — the kind of
regression no unit test catches and no user forgives. The answer was to gate
prompt-adjacent merges on behavioral evals the same way type checks gate code:
the runners execute in CI, post a delta-vs-base comment on the pull request, and
**block the merge** when a golden case drifts, a judge rubric fails, or an output
shape breaks. Not a dashboard someone remembers to open — a check that fails.
The judge itself is calibrated against a human-labeled set before it earns that
gate authority, so a nondeterministic scorer never gets to fail a build on a whim.

---

## Why Goldset?

Most AI eval tools are dashboards with no CI integration. Goldset is the opposite:

- **Evals as code** — sit next to your app in the same repo
- **GitHub Action native** — PR diff comments, merge-blocking on regression
- **Provider agnostic** — plug in any `llm: (input) => Promise<string>`
- **Three orthogonal runners** — catch three completely different failure modes

| Runner | What it catches | Best for |
|--------|-----------------|----------|
| `goldenDataset` | Output drifted from canonical answer | FAQ, refusal correctness, deterministic Q&A |
| `llmJudge` | Behavior regression on open-ended outputs | Tone, helpfulness, brand voice, language matching |
| `structural` | Output shape broke | Function calling, structured generation, JSON schema |

---

## Install

```bash
npm install @ykstormsorg/goldset
```

Peer dependency (not installed automatically):
```bash
npm install tsx   # for running .eval.ts files directly
```

---

## Quickstart

### 1. Create an eval file

```ts
// evals/customer-support.eval.ts
import { goldenDataset, llmJudge, structural, runEval } from '@ykstormsorg/goldset'
import { myLLM, myJudge } from '../src/llm'

const golden = await goldenDataset(
  [
    { id: 'refund-q', input: 'How do I get a refund?', expected: 'Email support@...' },
    { id: 'shipping-q', input: 'Where is my order?', expected: 'Track at track.example.com/...' },
  ],
  { llm: myLLM, threshold: 0.85 }
)

const judged = await llmJudge(
  [
    { id: 'hindi-q', input: 'Bopal mein 2BHK?', expected: 'Hindi response' },
    { id: 'french-q', input: 'Comment ça marche?', expected: 'French response' },
  ],
  {
    llm: myLLM,
    judge: myJudge,
    rubric: 'Score 5 if response is in the same language as the input. 0 if not.',
    passThreshold: 3,
  }
)

const shape = await structural(
  [{ id: 'tool-q', input: 'lookup order #42' }],
  {
    llm: myLLM,
    assertions: [
      { type: 'json-schema', schema: { type: 'object', properties: { orderId: { type: 'string' } } } },
      { type: 'tool-call-shape', toolName: 'lookupOrder', argCount: 1 },
    ],
  }
)

// runEval prints a human summary (or JSON with `--output json`, as the
// GitHub Action does) and exits non-zero if any runner failed.
await runEval(golden, judged, shape)
```

### 2. Run locally

```bash
npx tsx evals/customer-support.eval.ts
```

Output:
```
✓ goldenDataset: 2/2 passed
✓ llmJudge: 2/2 passed
✓ structural: 1/1 passed
```

### 3. Add to CI

```yaml
# .github/workflows/eval.yml
name: Goldset Eval

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - uses: ykstorm/goldset@v1
        with:
          eval-dir: evals
          judge-provider: none   # or openai | anthropic
          fail-on-regression: true
          comment-on-pr: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}   # if judge-provider: openai
```

The Action runs every `*.eval.ts` under `eval-dir` with `npx tsx <file> --output json`,
writes a combined `goldset-results.json`, posts (or updates) a PR comment with a
results table and a **delta-vs-base** section, and **fails the check** if any eval
fails or regresses against the base branch — gating the merge.

## GitHub Action

| Input | Default | Description |
|-------|---------|-------------|
| `eval-dir` | `evals` | Directory containing `*.eval.ts` files |
| `judge-provider` | `none` | `openai` \| `anthropic` \| `none`. Exposes the matching key (already on the runner env) to your eval as `GOLDSET_JUDGE_PROVIDER` |
| `fail-on-regression` | `true` | Fail the check if any eval regresses vs the base branch |
| `comment-on-pr` | `true` | Post/update a results + delta comment on the PR |

Outputs: `results-path`, `passed`, `failed`, `total`, `all-passed`.

---

## Three runners

| Runner | Function | Catches |
|--------|----------|---------|
| Golden dataset | `goldenDataset(cases, { llm, threshold })` | Output drifted from the canonical answer (Levenshtein similarity vs a threshold) |
| LLM-as-judge | `llmJudge(cases, { llm, judge, rubric })` | Behavior regression on open-ended outputs (a second LLM scores against a rubric) |
| Structural | `structural(cases, { llm, assertions })` | Output shape broke (JSON schema, regex, substring, tool-call shape) |

See the full [API reference](docs/API.md).

## Performance

The golden and structural runners are pure-CPU and run on every PR, so they have
to be fast enough to never block one. Measured (Node 24, 1000 synthetic cases,
stub `llm` — no provider call):

| Runner | 1000 cases | per case |
|---|---|---|
| Structural (json-schema + regex + contains) | **3.3 ms** | ~3.3 µs |
| Golden (Levenshtein similarity) | **29.8 ms** | ~30 µs |

A full PR's worth of deterministic checks is single-digit-to-tens of
milliseconds — the eval gate never becomes the slow step. Reproduce with
`node bench/runners.mjs` (no API key).

### LLM-judge cost

The judge is the one runner that spends money — it calls a model to score each
case. `bench/judge.mjs` prices exactly that: the real `llmJudge` runner with a
free stub `llm` (the "AI under test") and a real Claude Haiku judge. Measured in
CI against `claude-haiku-4-5` over 8 cases (workflow_dispatch, one call/case):

| Metric | Result |
|---|---|
| Cost per judged case | **$0.00047** (≈ $0.47 per 1,000 cases) |
| Judge latency p50 / avg | **1410 ms / 1305 ms** |
| Tokens (8 cases) | 1,659 in / 413 out → **$0.0037 total** |

So a 200-case judged suite runs about **9 cents**. Reproduce with
`ANTHROPIC_API_KEY=… node bench/judge.mjs`, or trigger the `judge-cost` job in
[`benchmark.yml`](.github/workflows/benchmark.yml) — manual dispatch only, so
fork PRs can't touch the key and every paid run is deliberate.

## License

Apache-2.0

