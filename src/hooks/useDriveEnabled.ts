import { useEffect, useState } from 'react';
import { checkDriveEnabled } from '../lib/driveStatus';
import { isGasAvailable } from '../lib/gas';

/** Drive 連携が使えるか。GAS の外では最初から false（通信もしない）。 */
export function useDriveEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!isGasAvailable()) return;
    let dead = false;
    void checkDriveEnabled().then((ok) => {
      if (!dead) setEnabled(ok);
    });
    return () => {
      dead = true;
    };
  }, []);
  return enabled;
}
