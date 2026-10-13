// Drive 連携が使えるかの判定。GAS の外、サーバーが無効と答えた、失敗した、時間内に返らなかったときは「使えない」。

import { gasCall, isGasAvailable, isGasError, type GasCall } from './gas';
import type { DriveStatus } from './driveTypes';

export const STATUS_TIMEOUT_MS = 10_000;

export async function checkDriveEnabled(
  o: { gas?: GasCall; available?: () => boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const available = o.available ?? isGasAvailable;
  if (!available()) return false;
  const gas = o.gas ?? gasCall;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), o.timeoutMs ?? STATUS_TIMEOUT_MS);
    });
    const res = await Promise.race([gas<DriveStatus>('getDriveStatus'), timeout]);
    if (res === 'timeout' || isGasError(res)) return false;
    return !!res && (res as DriveStatus).enabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
