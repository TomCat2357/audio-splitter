import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deployPath = fileURLToPath(new URL('../deploy.ps1', import.meta.url));
const bytes = readFileSync(deployPath);

function hasWindowsPowerShell() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
  return r.status === 0;
}

describe('deploy.ps1 の Windows PowerShell 5.1 互換', () => {
  it('先頭が UTF-8 の BOM（EF BB BF）で、二重ではない', () => {
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect([...bytes.subarray(3, 6)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  // #Requires があると、実行環境によってはそれだけで起動を拒否される。版の確認はスクリプト内の警告で行う。
  it('#Requires ステートメントを含まない', () => {
    const text = bytes.toString('utf8');
    expect(text).not.toMatch(/^\s*#\s*requires\b/im);
  });

  it('改行は LF だけ（CR を含まない）', () => {
    expect(bytes.includes(0x0d)).toBe(false);
  });

  // PowerShell 7 でしか使えない構文は、5.1 で構文エラーになる。コメント行以外を粗く検査する（5.1 の構文解析テストが本命）
  it('三項演算子・?? ・?. ・&& / || ・::new() を使わない', () => {
    const code = bytes.toString('utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/\?\?/);
    expect(code).not.toMatch(/\?\./);
    expect(code).not.toMatch(/&&|\|\|/);
    expect(code).not.toMatch(/::new\(/);
    expect(code).not.toMatch(/\$\w+\s*\?\s*\$|\)\s*\?\s*\S+\s*:\s*\S+/);
  });

  it('executeAs / access の判定を持たない（bundle-gas.mjs に一本化）', () => {
    const text = bytes.toString('utf8');
    expect(text).not.toMatch(/ConvertTo-Json -Depth/);
    expect(text).not.toContain('Set-WebappManifest');
    expect(text).not.toMatch(/"USER_DEPLOYING"|"USER_ACCESSING"/);
  });

  it.skipIf(!hasWindowsPowerShell())('Windows PowerShell 5.1 の構文解析器でエラーが 0 件', () => {
    // パスは日本語・空白を含むので、コマンド文字列に埋め込まず環境変数で渡す
    const command =
      '$errs = $null; $tokens = $null; ' +
      '[void][System.Management.Automation.Language.Parser]::ParseFile($env:DEPLOY_PS1_PATH, [ref]$tokens, [ref]$errs); ' +
      'if ($errs.Count -gt 0) { $errs | ForEach-Object { [Console]::Error.WriteLine("$($_.Extent.StartLineNumber): $($_.Message)") }; exit 1 }; exit 0';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, DEPLOY_PS1_PATH: deployPath },
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
