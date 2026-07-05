// Free-runner timing for Goldset's structural + golden runners. Pure CPU — a
// stub llm() supplies canned output so no provider is called (no API key, no
// cost). Measures the runner overhead that runs on every PR; the point is these
// runners are milliseconds, so they never block a PR (the LLM-judge runner,
// which does cost, is benchmarked separately in bench/judge.mjs).
// Run: node bench/runners.mjs
import { structural, calculateSimilarity } from '../dist/index.mjs'

const assertions = [
  { type: 'contains', substring: 'refund' },
  { type: 'regex', pattern: 'approved', flags: 'i' },
  { type: 'json-schema', schema: { type: 'object', properties: { ok: {}, answer: {} } } },
]
const llm = () => '{"ok":true,"answer":"your refund was approved"}' // stub, no network

async function timeStructural(n) {
  const cases = Array.from({ length: n }, (_, i) => ({ id: 'c' + i, input: 'query ' + i }))
  await structural(cases.slice(0, 5), { llm, assertions }) // warm
  const t0 = process.hrtime.bigint()
  const r = await structural(cases, { llm, assertions })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { runner: 'structural', cases: n, total_ms: +ms.toFixed(2), per_case_ms: +(ms / n).toFixed(4), passed: r.summary.passed }
}
function timeGolden(n) {
  const pairs = Array.from({ length: n }, (_, i) => ['the refund was approved on tuesday number ' + i, 'refund approved tuesday ' + i])
  for (let i = 0; i < 5; i++) calculateSimilarity(pairs[0][0], pairs[0][1]) // warm
  const t0 = process.hrtime.bigint()
  for (const [a, b] of pairs) calculateSimilarity(a, b)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { runner: 'golden(levenshtein)', cases: n, total_ms: +ms.toFixed(2), per_case_ms: +(ms / n).toFixed(4) }
}

const out = []
for (const n of [10, 100, 1000]) { const r = await timeStructural(n); out.push(r); console.log(JSON.stringify(r)) }
for (const n of [10, 100, 1000]) { const r = timeGolden(n); out.push(r); console.log(JSON.stringify(r)) }
console.log('node=' + process.version)
