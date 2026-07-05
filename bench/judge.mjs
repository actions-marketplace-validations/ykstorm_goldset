// Cost + latency of Goldset's LLM-judge runner, measured against a real model.
//
// The other two runners (structural, golden) are pure CPU and are timed in
// bench/runners.mjs with a stub llm() — no network, no key, no cost. The judge
// runner is the one that actually spends money, because it calls a model to
// score each case. This bench isolates that cost: it drives the *real*
// `llmJudge` from dist, injecting a deterministic stub `llm` (so the "AI under
// test" costs nothing) and a *real* `judge` that calls Claude Haiku. What we
// price is therefore exactly one judge call per case — the paid component.
//
// Provider: Anthropic, claude-haiku-4-5 (cheapest current model, $1/$5 per M).
// Auth: ANTHROPIC_API_KEY from the environment (a GitHub Actions secret in CI).
// The key is read from env only, never logged, never written to disk.
//
// Run: ANTHROPIC_API_KEY=... node bench/judge.mjs
import { llmJudge } from '../dist/index.mjs'

const MODEL = 'claude-haiku-4-5'
const IN_PER_M = 1.0   // USD per 1M input tokens  (claude-haiku-4-5)
const OUT_PER_M = 5.0  // USD per 1M output tokens (claude-haiku-4-5)

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY (this bench makes real Haiku calls).')
  process.exit(1)
}

// Eight support-bot cases. The stub llm returns a canned "answer under test";
// the judge scores each against the rubric. Content is deliberately mundane —
// the point is real token traffic, not a clever eval.
const rubric = [
  'Score 0-5 how well the answer serves the customer:',
  '5 = correct, grounded, and refuses to invent facts it does not have.',
  '3 = partially helpful but vague or hedged.',
  '0 = fabricates a policy, price, or fact, or is off-topic.',
].join('\n')

const cases = [
  { id: 'refund-window', input: 'Can I return this after 40 days?', expected: 'State the 30-day policy; decline beyond it.' },
  { id: 'no-source', input: 'What is your CEO home address?', expected: 'Refuse; no grounded source.' },
  { id: 'shipping', input: 'When does my order arrive?', expected: 'Ask for an order id; do not guess a date.' },
  { id: 'price-unknown', input: 'How much is the enterprise plan?', expected: 'Point to sales; do not fabricate a number.' },
  { id: 'reset-pw', input: 'How do I reset my password?', expected: 'Give the standard reset-link steps.' },
  { id: 'cancel', input: 'Cancel my subscription now.', expected: 'Explain the self-serve cancel path.' },
  { id: 'gdpr', input: 'Delete all my data.', expected: 'Point to the data-deletion request flow.' },
  { id: 'hours', input: 'Are you open on Sunday?', expected: 'Answer from stated hours or say you are unsure.' },
]

// Canned outputs the "AI under test" would produce — free, deterministic.
const cannedByIndex = [
  'Our return window is 30 days, so a return at 40 days is outside policy.',
  "I don't have that information and won't guess a private address.",
  'I can check that — could you share your order id?',
  'Pricing for enterprise is handled by our sales team; I can connect you.',
  'Open Settings → Security → Reset password and follow the emailed link.',
  'You can cancel anytime under Billing → Cancel subscription.',
  'You can request full data deletion at /privacy/delete; it processes in 30 days.',
  "I'm not certain of Sunday hours — let me point you to the hours page.",
]
const stubLlm = (input) => cannedByIndex[cases.findIndex((c) => c.input === input)] ?? 'ok'

// Real judge: one Haiku call per case. Returns the model's text, which
// llmJudge parses as {score, reason}. We also record latency + token usage.
const latencies = []
let inTokens = 0
let outTokens = 0
let calls = 0

async function judge(prompt) {
  const t0 = process.hrtime.bigint()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system: 'You are a strict evaluator. Respond with ONLY a JSON object {"score": <integer 0-5>, "reason": <short string>}. No prose, no code fences.',
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const body = await res.json()
  latencies.push(Number(process.hrtime.bigint() - t0) / 1e6)
  calls++
  if (body.usage) {
    inTokens += body.usage.input_tokens ?? 0
    outTokens += body.usage.output_tokens ?? 0
  }
  // Model may wrap JSON in prose despite instructions; extract the first object.
  const text = (body.content?.[0]?.text ?? '').trim()
  const m = text.match(/\{[\s\S]*\}/)
  return m ? m[0] : text
}

const p50 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

const wall0 = process.hrtime.bigint()
const result = await llmJudge(cases, { llm: stubLlm, judge, rubric, passThreshold: 3 })
const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6

const cost = (inTokens / 1e6) * IN_PER_M + (outTokens / 1e6) * OUT_PER_M
const summary = {
  runner: 'llmJudge',
  model: MODEL,
  cases: cases.length,
  judge_calls: calls,
  passed: result.summary.passed,
  avg_score: result.summary.avgScore,
  judge_latency_ms: { avg: +(latencies.reduce((a, b) => a + b, 0) / calls).toFixed(1), p50: +p50(latencies).toFixed(1) },
  tokens: { input: inTokens, output: outTokens },
  cost_usd: +cost.toFixed(6),
  cost_per_case_usd: +(cost / cases.length).toFixed(6),
  wall_ms: +wallMs.toFixed(1),
  node: process.version,
}
console.log(JSON.stringify(summary, null, 2))
