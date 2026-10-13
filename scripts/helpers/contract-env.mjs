// 突き合わせテスト用の組み立て: メモリ上の Drive + 本物の Code.gs + google.script.run の偽物 + 画面側の実コード（gas.ts / driveTransfer.ts）。
import { afterEach, expect } from 'vitest';
import { createFakeDrive, createServer, seedStandardDrive } from './fake-drive.mjs';
import { createFakeGas } from './fake-run.mjs';
import { createDriveTransfer } from '../../src/lib/driveTransfer.ts';

const live = [];

/**
 * opts: fake（createFakeDrive の opts）、server（createServer の opts）、hook（createFakeGas の hook）、seed（既定 true）
 * 戻り値: { fake, ids, server, g, transfer }
 *   g.call = 画面側の gasCall と同じもの（createGas の call）。transfer = createDriveTransfer({ gas: g.call }) の結果
 */
export function makeEnv(opts = {}) {
  const fake = createFakeDrive(opts.fake);
  const ids = opts.seed === false ? {} : seedStandardDrive(fake);
  const server = createServer(fake, opts.server);
  const g = createFakeGas(server, { hook: opts.hook });
  const transfer = createDriveTransfer({ gas: g.call, sleep: async () => {}, baseDelayMs: 0 });
  const env = { fake, ids, server, g, transfer };
  live.push(env);
  return env;
}

/** どのテストでも、JSON で正しく渡らない値（undefined・Date など）が往復に出ていないこと */
export function expectNoSerializationViolations() {
  afterEach(() => {
    const all = live.splice(0).flatMap((e) => e.g.violations);
    expect(all).toEqual([]);
  });
}

export const MiB = 1024 * 1024;
export const bufOf = async (blob) => Buffer.from(await blob.arrayBuffer());
export const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && a.equals(b);
