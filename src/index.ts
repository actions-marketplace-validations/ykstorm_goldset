// ─── Documented functional API (README + docs/API.md) ───────────────────────
export {
  goldenDataset,
  llmJudge,
  structural,
  grounding,
  runEval,
  toEvalResult,
} from './runners/api';
export type {
  LLMFn,
  JudgeFn,
  GoldenCase,
  GoldenConfig,
  GoldenCaseResult,
  GoldenResult,
  JudgeCase,
  JudgeConfig,
  JudgeCaseResult,
  JudgeResult,
  StructuralCase,
  StructuralConfig,
  StructuralCaseResult,
  StructuralResult,
  GroundingCase,
  GroundingConfig,
  GroundingCaseResult,
  GroundingResult,
  EvalResult,
} from './runners/api';

// ─── Structural assertion vocabulary ─────────────────────────────────────────
export { applyAssertions } from './runners/structural';
export type {
  Assertion,
  AssertionType,
  AssertionFailure,
} from './runners/structural';

// ─── Lower-level class API (golden dataset) ──────────────────────────────────
export {
  GoldenDatasetRunner,
  calculateSimilarity,
  levenshteinDistance,
} from './runners/golden';
export type {
  GoldenDatasetConfig,
  GoldenTestCase,
  EvaluationResult,
  EvaluationSummary,
} from './types';
