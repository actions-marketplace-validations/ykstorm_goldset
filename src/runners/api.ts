/**
 * Public functional API for Goldset's three runners.
 *
 * These are the functions documented in the README and docs/API.md
 * (`goldenDataset`, `llmJudge`, `structural`). They are thin wrappers over the
 * underlying matching logic that return the documented result shapes:
 * `{ runner, cases, summary }`. An `.eval.ts` file composes them and reports a
 * combined `EvalResult` via {@link toEvalResult} / {@link runEval}.
 */
import { calculateSimilarity } from './golden';
import { applyAssertions, type Assertion, type AssertionFailure } from './structural';

export type LLMFn = (input: string) => Promise<string> | string;
export type JudgeFn = (prompt: string) => Promise<string> | string;

// ─── goldenDataset ───────────────────────────────────────────────────────────

export interface GoldenCase {
  id: string;
  input: string;
  expected: string;
}

export interface GoldenConfig {
  llm: LLMFn;
  threshold?: number;
  normalize?: (s: string) => string;
  verbose?: boolean;
}

export interface GoldenCaseResult {
  id: string;
  passed: boolean;
  similarity: number;
  output: string;
  threshold: number;
}

export interface GoldenResult {
  runner: 'goldenDataset';
  cases: GoldenCaseResult[];
  summary: {
    passed: number;
    failed: number;
    passRate: number;
    avgSimilarity: number;
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function goldenDataset(
  cases: GoldenCase[],
  config: GoldenConfig
): Promise<GoldenResult> {
  const threshold = config.threshold ?? 0.8;
  if (threshold < 0 || threshold > 1) {
    throw new Error('goldenDataset: threshold must be between 0 and 1');
  }
  const normalize = config.normalize ?? ((s: string) => s);

  const results: GoldenCaseResult[] = [];
  for (const tc of cases) {
    const output = await Promise.resolve(config.llm(tc.input));
    const similarity = round2(
      calculateSimilarity(normalize(tc.expected), normalize(output))
    );
    const passed = similarity >= threshold;
    if (config.verbose) {
      console.log(`[goldenDataset] ${passed ? '✓' : '✗'} ${tc.id} (similarity ${similarity})`);
    }
    results.push({ id: tc.id, passed, similarity, output, threshold });
  }

  const passed = results.filter((r) => r.passed).length;
  const avgSimilarity = results.length
    ? round2(results.reduce((s, r) => s + r.similarity, 0) / results.length)
    : 0;

  return {
    runner: 'goldenDataset',
    cases: results,
    summary: {
      passed,
      failed: results.length - passed,
      passRate: results.length ? round2(passed / results.length) : 0,
      avgSimilarity,
    },
  };
}

// ─── llmJudge ────────────────────────────────────────────────────────────────

export interface JudgeCase {
  id: string;
  input: string;
  expected?: string;
}

export interface JudgeConfig {
  llm: LLMFn;
  judge: JudgeFn;
  rubric: string;
  passThreshold?: number;
  verbose?: boolean;
}

export interface JudgeCaseResult {
  id: string;
  passed: boolean;
  score: number;
  output: string;
  reasoning?: string;
  passThreshold: number;
}

export interface JudgeResult {
  runner: 'llmJudge';
  cases: JudgeCaseResult[];
  summary: {
    passed: number;
    failed: number;
    avgScore: number;
  };
}

export async function llmJudge(
  cases: JudgeCase[],
  config: JudgeConfig
): Promise<JudgeResult> {
  const { llm, judge, rubric } = config;
  const passThreshold = config.passThreshold ?? 3;

  const results: JudgeCaseResult[] = [];
  for (const tc of cases) {
    const output = await Promise.resolve(llm(tc.input));
    const judgePrompt = `You are an expert evaluator. Using the following rubric, score the AI's response.

Rubric:
${rubric}

Input: ${tc.input}
${tc.expected !== undefined ? `Expected: ${tc.expected}\n` : ''}Actual Output: ${output}

Respond with a JSON object containing "score" (0-5) and "reason" (string).`;

    const judgeText = await Promise.resolve(judge(judgePrompt));

    let score = 0;
    let reasoning: string | undefined;
    try {
      const parsed = JSON.parse(judgeText) as { score: number; reason?: string };
      score = typeof parsed.score === 'number' ? parsed.score : 0;
      reasoning = parsed.reason;
    } catch {
      // Inconclusive — judge did not return parseable JSON. Mark as failed.
      score = 0;
    }

    const passed = score >= passThreshold;
    if (config.verbose) {
      console.log(`[llmJudge] ${passed ? '✓' : '✗'} ${tc.id} (score ${score}/5)`);
    }
    results.push({ id: tc.id, passed, score, output, reasoning, passThreshold });
  }

  const passed = results.filter((r) => r.passed).length;
  const avgScore = results.length
    ? round2(results.reduce((s, r) => s + r.score, 0) / results.length)
    : 0;

  return {
    runner: 'llmJudge',
    cases: results,
    summary: { passed, failed: results.length - passed, avgScore },
  };
}

// ─── grounding (faithfulness) ─────────────────────────────────────────────────
// Catches RAG hallucination: the model's answer must be supported by the
// provided context. A judge scores how grounded the output is in `context`;
// unsupported/invented claims lower the score. Same judge-scored shape as
// llmJudge, but with an explicit context set instead of a free-form rubric.

export interface GroundingCase {
  id: string;
  input: string;
  /** The retrieved context the answer must stay faithful to. */
  context: string[];
}

export interface GroundingConfig {
  llm: LLMFn;
  judge: JudgeFn;
  passThreshold?: number;
  verbose?: boolean;
}

export interface GroundingCaseResult {
  id: string;
  passed: boolean;
  score: number;
  output: string;
  reasoning?: string;
  passThreshold: number;
}

export interface GroundingResult {
  runner: 'grounding';
  cases: GroundingCaseResult[];
  summary: {
    passed: number;
    failed: number;
    avgScore: number;
  };
}

export async function grounding(
  cases: GroundingCase[],
  config: GroundingConfig
): Promise<GroundingResult> {
  const { llm, judge } = config;
  const passThreshold = config.passThreshold ?? 3;

  const results: GroundingCaseResult[] = [];
  for (const tc of cases) {
    const output = await Promise.resolve(llm(tc.input));
    const judgePrompt = `You are a strict faithfulness checker. Using ONLY the context below, decide whether every factual claim in the answer is supported by that context. Claims that are invented or not backed by the context (hallucinations) must lower the score.

Context:
${tc.context.map((c, i) => `[${i + 1}] ${c}`).join('\n')}

Question: ${tc.input}
Answer: ${output}

Score 0 (the answer makes claims the context does not support) to 5 (every claim is grounded in the context). Respond with a JSON object containing "score" (0-5) and "reason" (string).`;

    const judgeText = await Promise.resolve(judge(judgePrompt));

    let score = 0;
    let reasoning: string | undefined;
    try {
      const parsed = JSON.parse(judgeText) as { score: number; reason?: string };
      score = typeof parsed.score === 'number' ? parsed.score : 0;
      reasoning = parsed.reason;
    } catch {
      // Inconclusive — judge did not return parseable JSON. Mark as failed.
      score = 0;
    }

    const passed = score >= passThreshold;
    if (config.verbose) {
      console.log(`[grounding] ${passed ? '✓' : '✗'} ${tc.id} (score ${score}/5)`);
    }
    results.push({ id: tc.id, passed, score, output, reasoning, passThreshold });
  }

  const passed = results.filter((r) => r.passed).length;
  const avgScore = results.length
    ? round2(results.reduce((s, r) => s + r.score, 0) / results.length)
    : 0;

  return {
    runner: 'grounding',
    cases: results,
    summary: { passed, failed: results.length - passed, avgScore },
  };
}

// ─── structural ──────────────────────────────────────────────────────────────

export interface StructuralCase {
  id: string;
  input: string;
}

export interface StructuralConfig {
  llm: LLMFn;
  assertions: Assertion[];
  verbose?: boolean;
}

export interface StructuralCaseResult {
  id: string;
  passed: boolean;
  output: string;
  failedAssertion?: AssertionFailure;
}

export interface StructuralResult {
  runner: 'structural';
  cases: StructuralCaseResult[];
  summary: {
    passed: number;
    failed: number;
  };
}

export async function structural(
  cases: StructuralCase[],
  config: StructuralConfig
): Promise<StructuralResult> {
  const { llm, assertions } = config;

  const results: StructuralCaseResult[] = [];
  for (const tc of cases) {
    const output = await Promise.resolve(llm(tc.input));
    const failure = applyAssertions(output, assertions);
    const passed = failure === null;
    if (config.verbose) {
      console.log(`[structural] ${passed ? '✓' : '✗'} ${tc.id}`);
    }
    results.push({
      id: tc.id,
      passed,
      output,
      failedAssertion: failure ?? undefined,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    runner: 'structural',
    cases: results,
    summary: { passed, failed: results.length - passed },
  };
}

// ─── Combined eval result + harness ──────────────────────────────────────────

export interface EvalResult {
  version: 1;
  timestamp: string;
  commit: string;
  branch: string;
  runners: {
    goldenDataset?: GoldenResult;
    llmJudge?: JudgeResult;
    structural?: StructuralResult;
    grounding?: GroundingResult;
  };
  passed: boolean;
}

type AnyRunnerResult = GoldenResult | JudgeResult | StructuralResult | GroundingResult;

/**
 * Combine one or more runner results into the shared `EvalResult` shape that
 * the GitHub Action's diff engine consumes. `passed` is true only if every
 * runner had zero failures.
 */
export function toEvalResult(...runnerResults: AnyRunnerResult[]): EvalResult {
  const runners: EvalResult['runners'] = {};
  let failed = 0;
  for (const r of runnerResults) {
    runners[r.runner] = r as never;
    failed += r.summary.failed;
  }
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? '',
    branch: process.env.GITHUB_REF_NAME ?? '',
    runners,
    passed: failed === 0,
  };
}

/**
 * Convenience harness for an `.eval.ts` file. Runs the provided runners,
 * prints a human summary, and — when invoked with `--output json` (as the
 * Goldset Action does) — prints the `EvalResult` JSON to stdout. Calls
 * `process.exit(1)` if any runner failed so the Action can gate the merge.
 */
export async function runEval(
  ...runnerResults: AnyRunnerResult[]
): Promise<EvalResult> {
  const result = toEvalResult(...runnerResults);
  const jsonMode = process.argv.includes('--output') &&
    process.argv[process.argv.indexOf('--output') + 1] === 'json';

  if (jsonMode) {
    // Machine-readable: the only thing on stdout is the JSON blob.
    process.stdout.write(JSON.stringify(result));
  } else {
    for (const r of runnerResults) {
      const total = r.cases.length;
      const mark = r.summary.failed === 0 ? '✓' : '✗';
      console.log(`${mark} ${r.runner}: ${r.summary.passed}/${total} passed`);
    }
  }

  if (!result.passed) process.exit(1);
  return result;
}
