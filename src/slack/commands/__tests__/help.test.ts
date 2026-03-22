import { describe, it, expect, vi } from 'vitest';
import { handleHelp } from '../help';

describe('handleHelp', () => {
  it('ヘルプメッセージを respond で返す', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);

    await handleHelp([], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('/ap story');
    expect(msg).toContain('/ap fix');
    expect(msg).toContain('/ap status');
    expect(msg).toContain('/ap retry');
    expect(msg).toContain('/ap help');
  });

  it('引数があっても正常に動作する', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);

    await handleHelp(['extra', 'args'], respond);

    expect(respond).toHaveBeenCalledTimes(1);
  });
});
