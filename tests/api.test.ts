import { describe, it, expect, vi } from 'vitest';
import { goldenDataset, toEvalResult, structural, llmJudge, grounding } from '../src/index';

describe('goldenDataset', () => {
  it('passes exact matches and fails drifted output, with a summary', async () => {
    const llm = vi
      .fn()
      .mockResolvedValueOnce('Email support@example.com')
      .mockResolvedValueOnce('totally different unrelated answer');

    const result = await goldenDataset(
      [
        { id: 'faq-1', input: 'How do I cancel?', expected: 'Email support@example.com' },
        { id: 'faq-2', input: 'Where is my order?', expected: 'Track at example.com/track' },
      ],
      { llm, threshold: 0.85 }
    );

    expect(result.runner).toBe('goldenDataset');
    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[0].similarity).toBe(1);
    expect(result.cases[1].passed).toBe(false);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.passRate).toBe(0.5);
  });

  it('applies a custom normalize() before comparing', async () => {
    const llm = vi.fn().mockResolvedValue('  HELLO  ');
    const result = await goldenDataset([{ id: 'n', input: 'x', expected: 'hello' }], {
      llm,
      threshold: 1,
      normalize: (s) => s.trim().toLowerCase(),
    });
    expect(result.cases[0].passed).toBe(true);
  });

  it('rejects an out-of-range threshold', async () => {
    await expect(
      goldenDataset([], { llm: vi.fn(), threshold: 1.5 })
    ).rejects.toThrow();
  });
});

describe('toEvalResult', () => {
  it('combines runner results and reports overall pass/fail', async () => {
    const golden = await goldenDataset(
      [{ id: 'g', input: 'x', expected: 'x' }],
      { llm: vi.fn().mockResolvedValue('x') }
    );
    const struct = await structural([{ id: 's', input: 'x' }], {
      llm: vi.fn().mockResolvedValue('nope'),
      assertions: [{ type: 'contains', substring: 'yes' }],
    });

    const passing = toEvalResult(golden);
    expect(passing.version).toBe(1);
    expect(passing.passed).toBe(true);
    expect(passing.runners.goldenDataset).toBeDefined();

    const failing = toEvalResult(golden, struct);
    expect(failing.passed).toBe(false);
    expect(failing.runners.structural?.summary.failed).toBe(1);
  });

  it('embeds judge results under the right key', async () => {
    const judge = await llmJudge([{ id: 'j', input: 'hi' }], {
      llm: vi.fn().mockResolvedValue('hello'),
      judge: vi.fn().mockResolvedValue(JSON.stringify({ score: 5, reason: 'ok' })),
      rubric: 'be nice',
    });
    const combined = toEvalResult(judge);
    expect(combined.runners.llmJudge?.summary.passed).toBe(1);
    expect(combined.passed).toBe(true);
  });

  it('embeds grounding results under the right key', async () => {
    const result = await grounding([{ id: 'gr', input: 'q', context: ['the sky is blue'] }], {
      llm: vi.fn().mockResolvedValue('the sky is blue'),
      judge: vi.fn().mockResolvedValue(JSON.stringify({ score: 5, reason: 'grounded' })),
    });
    const combined = toEvalResult(result);
    expect(combined.runners.grounding?.summary.passed).toBe(1);
    expect(combined.passed).toBe(true);
  });
});

describe('grounding', () => {
  it('passes when the answer is supported by the context', async () => {
    const r = await grounding(
      [{ id: 'g1', input: 'What colour is the sky?', context: ['The sky is blue on a clear day.'] }],
      {
        llm: vi.fn().mockResolvedValue('The sky is blue.'),
        judge: vi.fn().mockResolvedValue(JSON.stringify({ score: 5, reason: 'fully grounded' })),
      }
    );
    expect(r.runner).toBe('grounding');
    expect(r.summary.passed).toBe(1);
    expect(r.summary.failed).toBe(0);
    expect(r.cases[0].passed).toBe(true);
  });

  it('fails when the answer hallucinates beyond the context', async () => {
    const r = await grounding(
      [{ id: 'g2', input: 'Who founded it?', context: ['Acme makes widgets.'] }],
      {
        // the answer invents a fact the context does not support
        llm: vi.fn().mockResolvedValue('Acme was founded by Jane Doe in 1998.'),
        judge: vi.fn().mockResolvedValue(JSON.stringify({ score: 1, reason: 'founder/date not in context' })),
      }
    );
    expect(r.summary.failed).toBe(1);
    expect(r.cases[0].passed).toBe(false);
    expect(r.cases[0].score).toBe(1);
  });

  it('treats unparseable judge output as a failure', async () => {
    const r = await grounding([{ id: 'g3', input: 'q', context: ['ctx'] }], {
      llm: vi.fn().mockResolvedValue('answer'),
      judge: vi.fn().mockResolvedValue('not json'),
    });
    expect(r.cases[0].score).toBe(0);
    expect(r.cases[0].passed).toBe(false);
  });

  it('passes the context into the judge prompt', async () => {
    const judge = vi.fn().mockResolvedValue(JSON.stringify({ score: 5 }));
    await grounding([{ id: 'g4', input: 'q', context: ['SECRET_CONTEXT_MARKER'] }], {
      llm: vi.fn().mockResolvedValue('a'),
      judge,
    });
    expect(judge.mock.calls[0][0]).toContain('SECRET_CONTEXT_MARKER');
  });
});
