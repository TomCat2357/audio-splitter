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

  it('#Requires -Version 5.1 である', () => {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    expect(text).toMatch(/^#Requires -Version 5\.1\r?$/m);
    expect(text).not.toMatch(/^#Requires -Version 7/m);
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
