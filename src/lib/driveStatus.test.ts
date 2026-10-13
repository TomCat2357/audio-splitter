import { describe, expect, it } from 'vitest';
import { checkDriveEnabled } from './driveStatus';
import type { GasCall } from './gas';

const g = (f: () => unknown) => (async () => f()) as unknown as GasCall;

describe('checkDriveEnabled', () => {
  it('GAS の外（google.script.run が無い）では通信せず false', async () => {
    let called = false;
    const gas = g(() => {
      called = true;
      return { enabled: true };
    });
    expect(await checkDriveEnabled({ gas, available: () => false })).toBe(false);
    expect(called).toBe(false);
  });
  it('enabled: true のときだけ true', async () => {
    expect(await checkDriveEnabled({ gas: g(() => ({ enabled: true })), available: () => true })).toBe(true);
    expect(await checkDriveEnabled({ gas: g(() => ({ enabled: false, reason: 'x' })), available: () => true })).toBe(false);
  });
  it('{ error }・不正な応答・通信失敗は無効扱い', async () => {
    expect(await checkDriveEnabled({ gas: g(() => ({ error: 'x', code: 'DRIVE_DISABLED' })), available: () => true })).toBe(false);
    expect(await checkDriveEnabled({ gas: g(() => null), available: () => true })).toBe(false);
    expect(await checkDriveEnabled({ gas: g(() => 'ok'), available: () => true })).toBe(false);
    const ng = (async () => {
      throw new Error('network');
    }) as unknown as GasCall;
    expect(await checkDriveEnabled({ gas: ng, available: () => true })).toBe(false);
  });
  it('時間内に返らなければ無効扱い', async () => {
    const hang = (() => new Promise(() => {})) as unknown as GasCall;
    expect(await checkDriveEnabled({ gas: hang, available: () => true, timeoutMs: 20 })).toBe(false);
  });
});
