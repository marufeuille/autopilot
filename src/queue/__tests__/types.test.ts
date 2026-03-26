import { describe, it, expect } from 'vitest';
import type { QueueFailedAction } from '../../notification/types';

describe('QueueFailedAction 型', () => {
  it('resume / retry / clear の3値を受け入れる', () => {
    const actions: QueueFailedAction[] = ['resume', 'retry', 'clear'];
    expect(actions).toEqual(['resume', 'retry', 'clear']);
  });

  it('網羅的 switch で全ケースをカバーできる', () => {
    function handleAction(action: QueueFailedAction): string {
      switch (action) {
        case 'resume':
          return 'スキップして次へ';
        case 'retry':
          return 'このStoryをリトライ';
        case 'clear':
          return 'キューをすべてクリア';
        default: {
          const _exhaustive: never = action;
          throw new Error(`Unexpected action: ${_exhaustive}`);
        }
      }
    }

    expect(handleAction('resume')).toBe('スキップして次へ');
    expect(handleAction('retry')).toBe('このStoryをリトライ');
    expect(handleAction('clear')).toBe('キューをすべてクリア');
  });
});
