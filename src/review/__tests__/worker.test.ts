import { describe, it, expect } from 'vitest';
import { parseReviewResult } from '../worker';

describe('parseReviewResult', () => {
  it('should parse valid JSON result', () => {
    const input = JSON.stringify({
      verdict: 'OK',
      summary: 'No issues',
      findings: [],
    });

    const result = parseReviewResult(input);
    expect(result).toEqual({
      verdict: 'OK',
      summary: 'No issues',
      findings: [],
    });
  });

  it('should parse result with findings', () => {
    const input = JSON.stringify({
      verdict: 'NG',
      summary: 'Issues found',
      findings: [
        {
          file: 'src/test.ts',
          line: 10,
          severity: 'error',
          message: 'Bug detected',
        },
        {
          severity: 'warning',
          message: 'Style issue',
        },
      ],
    });

    const result = parseReviewResult(input);
    expect(result.verdict).toBe('NG');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual({
      file: 'src/test.ts',
      line: 10,
      severity: 'error',
      message: 'Bug detected',
    });
    expect(result.findings[1]).toEqual({
      severity: 'warning',
      message: 'Style issue',
    });
  });

  it('should extract JSON from code fences', () => {
    const input = '```json\n{"verdict":"OK","summary":"Good","findings":[]}\n```';

    const result = parseReviewResult(input);
    expect(result.verdict).toBe('OK');
  });

  it('should extract JSON from code fences without language tag', () => {
    const input = '```\n{"verdict":"OK","summary":"Good","findings":[]}\n```';

    const result = parseReviewResult(input);
    expect(result.verdict).toBe('OK');
  });

  it('should throw on invalid verdict', () => {
    const input = JSON.stringify({
      verdict: 'MAYBE',
      summary: 'Unsure',
      findings: [],
    });

    expect(() => parseReviewResult(input)).toThrow('Invalid verdict');
  });

  it('should throw on missing summary', () => {
    const input = JSON.stringify({
      verdict: 'OK',
      findings: [],
    });

    expect(() => parseReviewResult(input)).toThrow('Missing or invalid summary');
  });

  it('should throw on missing findings', () => {
    const input = JSON.stringify({
      verdict: 'OK',
      summary: 'Good',
    });

    expect(() => parseReviewResult(input)).toThrow('Missing or invalid findings');
  });

  it('should throw on invalid severity', () => {
    const input = JSON.stringify({
      verdict: 'NG',
      summary: 'Bad',
      findings: [{ severity: 'critical', message: 'Bad' }],
    });

    expect(() => parseReviewResult(input)).toThrow('Invalid severity');
  });

  it('should throw on finding missing message', () => {
    const input = JSON.stringify({
      verdict: 'NG',
      summary: 'Bad',
      findings: [{ severity: 'error' }],
    });

    expect(() => parseReviewResult(input)).toThrow('Finding missing message');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseReviewResult('not json')).toThrow();
  });
});
