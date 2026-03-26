import { describe, it, expect } from 'vitest';
import { determineVerdict, ReviewFinding } from '../types';

describe('determineVerdict', () => {
  it('errorが1つでもあればNGになる', () => {
    const findings: ReviewFinding[] = [
      { severity: 'error', message: 'Bug found' },
    ];
    expect(determineVerdict(findings)).toBe('NG');
  });

  it('warningのみはOKになる（自動修正対象外）', () => {
    const findings: ReviewFinding[] = [
      { severity: 'warning', message: 'Consider refactoring' },
    ];
    expect(determineVerdict(findings)).toBe('OK');
  });

  it('infoのみの場合はOKのまま', () => {
    const findings: ReviewFinding[] = [
      { severity: 'info', message: 'FYI' },
      { severity: 'info', message: 'Note' },
    ];
    expect(determineVerdict(findings)).toBe('OK');
  });

  it('指摘が0件の場合はOKのまま', () => {
    expect(determineVerdict([])).toBe('OK');
  });

  it('error, warning, info が混在する場合はNGになる', () => {
    const findings: ReviewFinding[] = [
      { severity: 'info', message: 'FYI' },
      { severity: 'warning', message: 'Consider refactoring' },
      { severity: 'error', message: 'Bug found' },
    ];
    expect(determineVerdict(findings)).toBe('NG');
  });

  it('warningとinfoのみの場合はOKになる', () => {
    const findings: ReviewFinding[] = [
      { severity: 'info', message: 'FYI' },
      { severity: 'warning', message: 'Consider refactoring' },
    ];
    expect(determineVerdict(findings)).toBe('OK');
  });
});
