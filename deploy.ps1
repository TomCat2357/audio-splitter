# 音声分割 ビルド/デプロイスクリプト (Windows PowerShell 5.1 以降 / PowerShell 7 両対応)
#
# ※ このファイルは BOM 付き UTF-8 で保存すること（Windows PowerShell 5.1 が日本語を正しく読むため）。
#    BOM が無いと 5.1 は既定の文字コード（日本語 Windows では Shift_JIS）で読み、構文エラーになる。
#
# npm run build で dist/Index.html を作り、scripts/bundle-gas.mjs で dist/ に GAS 用ファイルを揃え、clasp で push / deploy する。
#   dist/Index.html       … vite の成果物（単一 HTML。<head> 直後に <base target="_top"> を挿入）
#   dist/Code.gs          … gas/Code.gs（-IconUrl / -RedirectUrl を指定したときだけ焼き込む）
#   dist/Redirect.gs      … gas/Redirect.gs
#   dist/appsscript.json  … gas/appsscript.json（-ExecuteAs / -Access 指定時はその項目だけ書き換え）
#
# Usage: .\deploy.ps1 [-Stage <bundle|push|deploy>] [-Test]
#                      [-IconUrl <Drive の URL / ファイル ID / https の画像 URL>] [-RedirectUrl <新しいデプロイの URL>]
#                      [-ExecuteAs <deploying|accessing>] [-Access <myself|domain|anyone|anonymous>]
#                      [-ForcePush] [-WhatIf] [-h]

[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter()][ValidateSet("bundle", "push", "deploy")]
    [string]$Stage = "deploy",
    [Parameter()][ValidateSet("deploying", "accessing")]
    [string]$ExecuteAs = "",
    [Parameter()][ValidateSet("domain", "anyone", "anonymous", "myself")]
    [string]$Access = "",
    [Parameter()][string]$IconUrl = "",
    [Parameter()][string]$RedirectUrl = "",
    [Parameter()][switch]$Test,
    [Parameter()][switch]$ForcePush,
    [Parameter()][switch]$WhatIf,
    [Parameter()][Alias("h")][switch]$Help
)

$ErrorActionPreference = "Stop"

# #Requires ステートメントは使わない（実行環境によってはそれだけで起動を拒否されるため）。
# 動作確認は Windows PowerShell 5.1 と PowerShell 7 で行っている。それより古い場合は警告だけ出して続行する。
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    Write-Host "[警告] PowerShell $($PSVersionTable.PSVersion) で実行しています。動作確認は 5.1 以降で行っています。" -ForegroundColor Yellow
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$DeployStartTime = Get-Date
$RepoRoot = $PSScriptRoot
$DistDir = Join-Path $RepoRoot "dist"
$BundleScript = Join-Path $RepoRoot "scripts/bundle-gas.mjs"

function Set-FileContentWithRetry {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Content,
        [int]$RetryCount = 5,
        [int]$DelayMs = 1000
    )
    if (Test-Path $Path) {
        $fullPath = (Resolve-Path $Path).Path
    } else {
        $fullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    }
    for ($attempt = 1; $attempt -le $RetryCount; $attempt++) {
        try {
            [System.IO.File]::WriteAllText($fullPath, $Content, $Utf8NoBom)
            return
        } catch {
            if ($attempt -ge $RetryCount) {
                Write-Host "[NG] ファイル書き込みの再試行回数の上限に達しました: $fullPath" -ForegroundColor Red
                throw
            }
            Start-Sleep -Milliseconds $DelayMs
        }
    }
}

# executeAs / access は独立した2軸。指定されたフィールドだけ書き込み、未指定のものには触れない。
function Set-WebappManifest {
    param(
        [Parameter(Mandatory=$true)][string]$ManifestPath,
        [string]$ManifestExecuteAs = "",
        [string]$ManifestAccess = ""
    )
    if ($ManifestExecuteAs -eq "" -and $ManifestAccess -eq "") { return }
    try {
        $manifest = [System.IO.File]::ReadAllText($ManifestPath, $Utf8NoBom) | ConvertFrom-Json
        if (-not $manifest.webapp) {
            $manifest | Add-Member -MemberType NoteProperty -Name "webapp" -Value ([PSCustomObject]@{})
        }
        if ($ManifestExecuteAs -ne "") {
            $manifest.webapp | Add-Member -MemberType NoteProperty -Name "executeAs" -Value $ManifestExecuteAs -Force
        }
        if ($ManifestAccess -ne "") {
            $manifest.webapp | Add-Member -MemberType NoteProperty -Name "access" -Value $ManifestAccess -Force
        }
        Set-FileContentWithRetry -Path $ManifestPath -Content (($manifest | ConvertTo-Json -Depth 20) + "`n")
    } catch {
        throw "appsscript.json の webapp 設定更新に失敗しました: $($_.Exception.Message)"
    }
}

# 外部コマンドを実行し、標準出力+標準エラーと終了コードを返す（stderr が $ErrorActionPreference=Stop に引っかからないようにする）。
# 出力は UTF-8 として解釈し（node / clasp は UTF-8 で出力する）、終わったら元の文字コードへ戻す。
# 5.1 では 2>&1 を通った stderr が ErrorRecord になるため、例外メッセージ（元の 1 行）の文字列へ直してから連結する。
function Invoke-Native {
    param([Parameter(Mandatory=$true)][string]$Exe, [string[]]$Arguments = @())
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $prevEnc = $null
    $encChanged = $false
    try {
        $prevEnc = [Console]::OutputEncoding
        [Console]::OutputEncoding = $Utf8NoBom
        $encChanged = $true
    } catch {
        # コンソールが無い環境では切り替えを諦めて続行する
    }
    try {
        $lines = @(& $Exe @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
        })
        $code = $LASTEXITCODE
        $out = ($lines | Out-String)
    } finally {
        $ErrorActionPreference = $prev
        if ($encChanged) {
            try { [Console]::OutputEncoding = $prevEnc } catch { }
        }
    }
    return [pscustomobject]@{ Output = $out; ExitCode = $code }
}

# 出力を捕捉せず画面へそのまま流す外部コマンド実行。終了コードは $script:NativeExitCode に入る。
# 5.1 では呼び出し側のリダイレクト（2>&1 など）を通った stderr が ErrorRecord になり、
# $ErrorActionPreference=Stop だとスクリプトが異常終了するため、実行中だけ Continue にする。
function Invoke-NativeLive {
    param([Parameter(Mandatory=$true)][string]$Exe, [string[]]$Arguments = @())
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    # 呼び出し側が出力をリダイレクトしているとき、node の UTF-8 出力が化けないようにする（画面へ直接出るときは影響しない）
    $prevEnc = $null
    $encChanged = $false
    try {
        $prevEnc = [Console]::OutputEncoding
        [Console]::OutputEncoding = $Utf8NoBom
        $encChanged = $true
    } catch {
        # コンソールが無い環境では切り替えを諦めて続行する
    }
    try {
        & $Exe @Arguments
        $script:NativeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
        if ($encChanged) {
            try { [Console]::OutputEncoding = $prevEnc } catch { }
        }
    }
}

function Show-Help {
    @'
Usage: .\deploy.ps1 [options]

npm run build で dist/Index.html を作り、scripts/bundle-gas.mjs で dist/ に
Index.html / Code.gs / Redirect.gs / appsscript.json を揃え、clasp で push / deploy します。
既定（-Stage deploy）は push + デプロイまで行います。

Options:
  -Stage <bundle|push|deploy>  どこまで進めるかを指定します（既定: deploy）。
                              bundle = dist/ を生成するだけ（clasp 不要・ログイン不要）。
                              push   = bundle + clasp push（dist/ を rootDir として push）。
                              deploy = push + Web アプリのデプロイ（.gas-deployment.json の ID を再利用して URL を維持）。
  -Test                         ビルドの前に npm test を実行し、失敗したら中止します。
  -IconUrl <URL or ID>         Web アプリのタブのアイコン（favicon）にする画像。次のどれかを指定します。
                              ・Drive の共有 URL（https://drive.google.com/file/d/<ID>/view など）
                              ・Drive のファイル ID（英数字・_・- の 20 文字以上）
                              ・それ以外の https:// の画像 URL（そのまま使います）
                              Drive の URL / ID は https://lh3.googleusercontent.com/d/<ID>#.png に変換して dist/Code.gs に焼き込みます
                              （GAS は URL 末尾の拡張子を検査するため。末尾が拡張子でない https URL にも #.png を足します）。
                              画像が ico などのときは、値の末尾に #.ico / #.png / #.jpg / #.jpeg / #.gif を付けるとその拡張子になります。
                              Drive のファイルは「リンクを知っている全員」に共有が必要です（README.md）。
  -RedirectUrl <URL>           旧デプロイから開かれたときの移動先（新しいデプロイの Web アプリ URL）。
                              https://script.google.com/ で始まりデプロイ ID を含む URL だけ受け付け、dist/Code.gs に焼き込みます。
                              実行時にスクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL があればそちらが優先されます
                              （値 off で解除）。?noredirect=1 を付けて開くと移動しません（README.md）。
  ※ -IconUrl / -RedirectUrl は、指定したときだけ焼き込まれます。指定しなければ焼き込まれません
    （前回の値は引き継がれないので、デプロイのたびに指定が必要です）。値は git に入りません（dist/ は無視）。
  -ExecuteAs <deploying|accessing>
                              指定したときだけ dist/appsscript.json の webapp.executeAs を書き換えます
                              （deploying=USER_DEPLOYING / accessing=USER_ACCESSING）。未指定なら gas/ の値（USER_DEPLOYING）。
  -Access <myself|domain|anyone|anonymous>
                              指定したときだけ webapp.access を書き換えます
                              （myself=MYSELF / domain=DOMAIN / anyone=ANYONE / anonymous=ANYONE_ANONYMOUS）。
                              未指定なら gas/ の値（MYSELF）。anyone / anonymous は公開範囲が広いので警告を表示します。
  -ForcePush                    clasp push に --force を付けます（appsscript.json の上書き確認を自動承認）。
                              clasp は確認に非対話で答えられず、何も送らずに終了コード 0 で終わることがあります。
                              その場合（出力に Skipping push）は失敗として扱うので、-ForcePush を付けて再実行してください。
  -WhatIf                       実行予定を表示するだけで、ファイル変更・外部コマンドの実行は行いません。
  -h, -Help                     このヘルプを表示します。

例:
  .\deploy.ps1                                   ビルド + push + デプロイ（既存のデプロイ ID を更新）
  .\deploy.ps1 -Stage bundle                     dist/ を生成するだけ
  .\deploy.ps1 -Test -ForcePush                  テスト後に push（--force）+ デプロイ
  .\deploy.ps1 -IconUrl https://drive.google.com/file/d/<ID>/view   タブのアイコンを焼き込む
  .\deploy.ps1 -RedirectUrl https://script.google.com/macros/s/<デプロイID>/exec   旧デプロイ用: 移動先を焼き込む
  .\deploy.ps1 -WhatIf                           ドライラン
'@
}

if ($Help) {
    Show-Help
    exit 0
}

$ManifestExecuteAs = ""
if ($PSBoundParameters.ContainsKey("ExecuteAs")) {
    $ManifestExecuteAs = if ($ExecuteAs -eq "deploying") { "USER_DEPLOYING" } else { "USER_ACCESSING" }
}
$ManifestAccess = ""
if ($PSBoundParameters.ContainsKey("Access")) {
    $ManifestAccess = switch ($Access) {
        "domain"    { "DOMAIN" }
        "anyone"    { "ANYONE" }
        "anonymous" { "ANYONE_ANONYMOUS" }
        "myself"    { "MYSELF" }
    }
}

# -IconUrl / -RedirectUrl の変換と検証は scripts/bundle-gas.mjs の normalizeIconUrl / normalizeRedirectUrl に一本化（ここでは二重実装しない）。空は空のまま。不正は例外。
function ConvertTo-NormalizedValue {
    param([string]$Value, [string]$Function, [string]$Name)
    if ($Value.Trim() -eq "") { return "" }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "$Name の検証に node が必要です（Node.js をインストールしてください）。" }
    $moduleUrl = (New-Object System.Uri($BundleScript)).AbsoluteUri
    $script = "const m=await import(process.argv[1]);try{process.stdout.write(m[process.argv[2]](process.argv[3]))}catch(e){process.stderr.write(e.message);process.exit(1)}"
    $res = Invoke-Native -Exe "node" -Arguments @("--input-type=module", "-e", $script, $moduleUrl, $Function, $Value)
    if ($res.ExitCode -ne 0) { throw "$Name が不正です: $($res.Output.Trim())" }
    return $res.Output.Trim()
}

$ResolvedIconUrl = ""
$ResolvedRedirectUrl = ""
try {
    $ResolvedIconUrl = ConvertTo-NormalizedValue -Value $IconUrl -Function "normalizeIconUrl" -Name "-IconUrl"
    $ResolvedRedirectUrl = ConvertTo-NormalizedValue -Value $RedirectUrl -Function "normalizeRedirectUrl" -Name "-RedirectUrl"
} catch {
    Write-Host "[NG] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

function Write-AccessWarning {
    if ($ManifestAccess -eq "ANYONE" -or $ManifestAccess -eq "ANYONE_ANONYMOUS") {
        Write-Host ""
        Write-Host "!!!! 警告: -Access $Access が指定されています（公開範囲が広い）!!!!" -ForegroundColor Red
        if ($ManifestAccess -eq "ANYONE") {
            Write-Host "  Google アカウントでログインした全員が、この Web アプリを開けます。" -ForegroundColor Red
        } else {
            Write-Host "  ログイン不要で、URL を知っている誰でもこの Web アプリを開けます。" -ForegroundColor Red
        }
        Write-Host "  意図した公開範囲か確認してください。" -ForegroundColor Red
        Write-Host ""
    }
}

# ---- -WhatIf ----
if ($WhatIf) {
    Write-Host "[WhatIf] ドライラン（ファイル変更・外部コマンドの実行は一切行いません）" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "実行予定（-Stage $Stage）:" -ForegroundColor Cyan
    $n = 1
    if ($Test) { Write-Host "  $n. npm test を実行（失敗したら中止）"; $n++ }
    Write-Host "  $n. node_modules が無ければ npm install"; $n++
    Write-Host "  $n. npm run build で dist/Index.html を生成"; $n++
    Write-Host "  $n. node scripts/bundle-gas.mjs で dist/ に Index.html / Code.gs / Redirect.gs / appsscript.json を揃える"; $n++
    if ($ResolvedIconUrl -ne "") {
        Write-Host "  $n. タブのアイコン（$ResolvedIconUrl）を dist/Code.gs に焼き込む予定"
    } else {
        Write-Host "  $n. タブのアイコンは指定なし（焼き込まない。Apps Script 既定のアイコン）"
    }
    $n++
    if ($ResolvedRedirectUrl -ne "") {
        Write-Host "  $n. リダイレクト先（$ResolvedRedirectUrl）を dist/Code.gs に焼き込む予定"
    } else {
        Write-Host "  $n. リダイレクト先は指定なし（焼き込まない。スクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL があればそれが使われる）"
    }
    $n++
    $parts = @()
    if ($ManifestExecuteAs -ne "") { $parts += "executeAs=$ManifestExecuteAs" }
    if ($ManifestAccess -ne "") { $parts += "access=$ManifestAccess" }
    if ($parts.Count -gt 0) {
        Write-Host "  $n. dist/appsscript.json の webapp を書き換え予定: $($parts -join ' / ')"
    } else {
        Write-Host "  $n. dist/appsscript.json の webapp 設定は変更しない予定（gas/ の値のまま）"
    }
    $n++
    if ($Stage -eq "push" -or $Stage -eq "deploy") {
        Write-Host "  $n. clasp / ~/.clasprc.json / .clasp.json（scriptId）の有無を確認"; $n++
        Write-Host "  $n. .clasp.json の rootDir を一時的に dist へ向けて clasp push$(if ($ForcePush) { ' --force' }) を実行予定（終了後に元へ戻す）"; $n++
    }
    if ($Stage -eq "deploy") {
        Write-Host "  $n. clasp deploy を実行予定（.gas-deployment.json の deploymentId があれば --deploymentId で再利用して URL を維持）"; $n++
        Write-Host "  $n. デプロイ ID と URL を .gas-deployment.json に保存予定"; $n++
    }
    Write-AccessWarning
    exit 0
}

Write-AccessWarning
Set-Location $RepoRoot

# 環境変数は bundle-gas.mjs へ渡すためだけに使い、終了時に必ず元へ戻す
$savedIconEnv = $env:AUDIO_SPLITTER_ICON_URL
$savedRedirectEnv = $env:AUDIO_SPLITTER_REDIRECT_URL
try {
    # ---- テスト ----
    if ($Test) {
        Write-Host "[1/4] npm test を実行中..." -ForegroundColor Yellow
        Invoke-NativeLive -Exe "npm" -Arguments @("test")
        if ($script:NativeExitCode -ne 0) {
            Write-Host "[NG] テストに失敗したため中止しました" -ForegroundColor Red
            exit 1
        }
        Write-Host "[OK] テスト成功" -ForegroundColor Green
    }

    # ---- ビルド ----
    if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
        Write-Host "node_modules が無いので npm install を実行します..." -ForegroundColor Yellow
        Invoke-NativeLive -Exe "npm" -Arguments @("install")
        if ($script:NativeExitCode -ne 0) {
            Write-Host "[NG] npm install に失敗しました" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "[2/4] npm run build を実行中..." -ForegroundColor Yellow
    Invoke-NativeLive -Exe "npm" -Arguments @("run", "build")
    if ($script:NativeExitCode -ne 0) {
        Write-Host "[NG] npm run build に失敗しました" -ForegroundColor Red
        exit 1
    }

    # ---- dist/ の組み立て ----
    Write-Host "[3/4] dist/ を組み立て中（node scripts/bundle-gas.mjs）..." -ForegroundColor Yellow
    if ($ResolvedIconUrl -ne "") { $env:AUDIO_SPLITTER_ICON_URL = $ResolvedIconUrl } else { Remove-Item Env:AUDIO_SPLITTER_ICON_URL -ErrorAction SilentlyContinue }
    if ($ResolvedRedirectUrl -ne "") { $env:AUDIO_SPLITTER_REDIRECT_URL = $ResolvedRedirectUrl } else { Remove-Item Env:AUDIO_SPLITTER_REDIRECT_URL -ErrorAction SilentlyContinue }
    Invoke-NativeLive -Exe "node" -Arguments @($BundleScript)
    if ($script:NativeExitCode -ne 0) {
        Write-Host "[NG] dist/ の組み立てに失敗しました" -ForegroundColor Red
        exit 1
    }

    $IndexPath = Join-Path $DistDir "Index.html"
    $CodePath = Join-Path $DistDir "Code.gs"
    $RedirectPath = Join-Path $DistDir "Redirect.gs"
    $ManifestPath = Join-Path $DistDir "appsscript.json"
    foreach ($f in @($IndexPath, $CodePath, $RedirectPath, $ManifestPath)) {
        if (-not (Test-Path $f)) {
            Write-Host "[NG] 成果物が見つかりません: $f" -ForegroundColor Red
            exit 1
        }
    }

    try {
        Set-WebappManifest -ManifestPath $ManifestPath -ManifestExecuteAs $ManifestExecuteAs -ManifestAccess $ManifestAccess
        if ($ManifestExecuteAs -ne "" -or $ManifestAccess -ne "") {
            $applied = @()
            if ($ManifestExecuteAs -ne "") { $applied += "executeAs=$ManifestExecuteAs" }
            if ($ManifestAccess -ne "") { $applied += "access=$ManifestAccess" }
            Write-Host "[OK] dist/appsscript.json に $($applied -join ' / ') を適用しました" -ForegroundColor Magenta
        }
    } catch {
        Write-Host "[NG] $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }

    if ($ResolvedIconUrl -ne "") {
        Write-Host "[OK] dist/Code.gs にタブのアイコンを焼き込みました" -ForegroundColor Magenta
        Write-Host "     ※ Drive の画像なら「リンクを知っている全員」の共有が必要です。反映はデプロイし直し後、ブラウザのキャッシュで遅れることがあります" -ForegroundColor DarkGray
    }
    if ($ResolvedRedirectUrl -ne "") {
        Write-Host "[OK] dist/Code.gs にリダイレクト先を焼き込みました（このデプロイは開かれると移動先へ案内します。?noredirect=1 で回避、スクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL が優先、off で解除）" -ForegroundColor Magenta
    }

    Write-Host ""
    Write-Host "[OK] dist/ の準備完了: $DistDir" -ForegroundColor Green
    foreach ($f in @($IndexPath, $CodePath, $RedirectPath, $ManifestPath)) {
        Write-Host ("   {0,-18} {1,10:N1} KB" -f (Split-Path $f -Leaf), ((Get-Item $f).Length / 1KB))
    }

    if ($Stage -eq "bundle") {
        $elapsed = [math]::Round(((Get-Date) - $DeployStartTime).TotalSeconds, 1)
        Write-Host ""
        Write-Host "[OK] Stage=bundle 完了（clasp push/deploy はスキップ）  [$elapsed 秒]" -ForegroundColor Green
        exit 0
    }

    # ---- clasp push / deploy の前提チェック ----
    Write-Host "[4/4] clasp でアップロード中..." -ForegroundColor Yellow
    if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
        Write-Host "[NG] clasp が見つかりません。次を実行してから再度お試しください:" -ForegroundColor Red
        Write-Host "     npm install -g @google/clasp" -ForegroundColor Yellow
        exit 1
    }
    $ClaspRc = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".clasprc.json"
    if (-not (Test-Path $ClaspRc)) {
        Write-Host "[NG] clasp にログインしていません。次を実行してから再度お試しください:" -ForegroundColor Red
        Write-Host "     clasp login" -ForegroundColor Yellow
        Write-Host "     （clasp を使わずに済ませる場合は -Stage bundle で dist/ だけ作れます）"
        exit 1
    }
    $ClaspJsonPath = Join-Path $RepoRoot ".clasp.json"
    if (-not (Test-Path $ClaspJsonPath)) {
        Write-Host "[NG] .clasp.json がありません。次のどちらかで用意してください:" -ForegroundColor Red
        Write-Host "     1) .clasp.json.example をコピーして .clasp.json にし、scriptId を GAS プロジェクトの Script ID に書き換える"
        Write-Host "     2) clasp create --type webapp --title `"音声分割`" --rootDir dist  （新しい GAS プロジェクトを作る）"
        exit 1
    }
    $claspOriginal = [System.IO.File]::ReadAllText($ClaspJsonPath, $Utf8NoBom)
    try {
        $claspObj = $claspOriginal | ConvertFrom-Json
    } catch {
        Write-Host "[NG] .clasp.json を JSON として読めません: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
    if (-not $claspObj.scriptId -or $claspObj.scriptId -eq "YOUR_SCRIPT_ID") {
        Write-Host "[NG] .clasp.json の scriptId が未設定です（空、または YOUR_SCRIPT_ID のまま）。GAS プロジェクトの Script ID を書いてください。" -ForegroundColor Red
        exit 1
    }

    $DeployCacheFile = Join-Path $RepoRoot ".gas-deployment.json"
    $ExistingDeploymentId = ""
    if (Test-Path $DeployCacheFile) {
        try {
            $cache = [System.IO.File]::ReadAllText($DeployCacheFile, $Utf8NoBom) | ConvertFrom-Json
            if ($cache.deploymentId) { $ExistingDeploymentId = [string]$cache.deploymentId }
        } catch {
            Write-Host "[警告] .gas-deployment.json を読み込めませんでした。新しいデプロイ（新しい URL）を作成します" -ForegroundColor Yellow
        }
    }

    # rootDir を一時的に dist へ向ける（終了時に必ず元へ戻す）
    $claspObj | Add-Member -MemberType NoteProperty -Name "rootDir" -Value "dist" -Force
    Set-FileContentWithRetry -Path $ClaspJsonPath -Content ($claspObj | ConvertTo-Json)
    try {
        $pushArgs = @("push"); if ($ForcePush) { $pushArgs += "--force" }
        $push = Invoke-Native -Exe "clasp" -Arguments $pushArgs
        Write-Host $push.Output
        if ($push.ExitCode -ne 0) {
            Write-Host "[NG] clasp push に失敗しました" -ForegroundColor Red
            exit 1
        }
        # clasp は appsscript.json の上書き確認に非対話で答えられず、何も送らず終了コード 0 で終わることがある
        if ($push.Output -match "Skipping push") {
            Write-Host "[NG] clasp push がスキップされました（何も送信されていません）。-ForcePush を付けて再実行してください" -ForegroundColor Red
            exit 1
        }
        Write-Host "[OK] push が完了しました" -ForegroundColor Green

        if ($Stage -eq "push") {
            $elapsed = [math]::Round(((Get-Date) - $DeployStartTime).TotalSeconds, 1)
            Write-Host "[OK] Stage=push 完了（deploy はスキップ）  [$elapsed 秒]" -ForegroundColor Green
            exit 0
        }

        # clasp deploy（説明は ASCII のみ。コマンドライン経由で文字化けさせない）
        $version = Get-Date -Format "yyyyMMdd_HHmmss"
        $description = "audio-splitter v$version"
        $deployArgs = @("deploy", "--description", $description)
        if ($ExistingDeploymentId -ne "") {
            Write-Host "[再利用] 既存のデプロイを更新します（URL は変わりません）" -ForegroundColor Cyan
            $deployArgs += @("--deploymentId", $ExistingDeploymentId)
        }
        $deploy = Invoke-Native -Exe "clasp" -Arguments $deployArgs
        if ($deploy.ExitCode -ne 0 -and $ExistingDeploymentId -ne "") {
            Write-Host "[警告] 既存デプロイの更新に失敗しました（削除済みの可能性）。新しいデプロイを作成します" -ForegroundColor Yellow
            Write-Host $deploy.Output
            $ExistingDeploymentId = ""
            $deploy = Invoke-Native -Exe "clasp" -Arguments @("deploy", "--description", $description)
        }
        if ($deploy.ExitCode -ne 0) {
            Write-Host "[NG] clasp deploy に失敗しました" -ForegroundColor Red
            Write-Host $deploy.Output
            exit 1
        }
        Write-Host "[OK] デプロイが完了しました" -ForegroundColor Green
        Write-Host $deploy.Output

        $DeploymentId = ""
        $WebAppUrl = ""
        if ($deploy.Output -match 'https://script\.google\.com/macros/s/[^\s]+') { $WebAppUrl = $Matches[0] }
        if ($WebAppUrl -match '/macros/s/([^/]+)/') { $DeploymentId = $Matches[1] }
        if ($DeploymentId -eq "" -and $deploy.Output -match 'AKf[A-Za-z0-9_\-]+') { $DeploymentId = $Matches[0] }
        if ($DeploymentId -eq "" -and $ExistingDeploymentId -ne "") { $DeploymentId = $ExistingDeploymentId }
        if ($WebAppUrl -eq "" -and $DeploymentId -ne "") { $WebAppUrl = "https://script.google.com/macros/s/$DeploymentId/exec" }

        if ($DeploymentId -ne "") {
            Set-FileContentWithRetry -Path $DeployCacheFile -Content (@{ deploymentId = $DeploymentId; webAppUrl = $WebAppUrl } | ConvertTo-Json)
            Write-Host ".gas-deployment.json にデプロイ ID を保存しました（次回以降は同じ URL を更新します）"
        } else {
            Write-Host "[警告] デプロイ ID を出力から読み取れませんでした。.gas-deployment.json は更新していません（次回は新しい URL になります）" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "==========================================" -ForegroundColor Cyan
        if ($DeploymentId -ne "") { Write-Host "Deployment ID: $DeploymentId" }
        if ($WebAppUrl -ne "") { Write-Host "Web App URL:   $WebAppUrl" -ForegroundColor Green }
        Write-Host "管理画面: https://script.google.com/home/projects/$($claspObj.scriptId)/edit"
        Write-Host "==========================================" -ForegroundColor Cyan
        $elapsed = [math]::Round(((Get-Date) - $DeployStartTime).TotalSeconds, 1)
        Write-Host "[OK] デプロイが正常に完了しました  [$elapsed 秒]" -ForegroundColor Green
    } finally {
        # .clasp.json を元の内容に戻す（exit や例外で抜けても必ず実行される）
        Set-FileContentWithRetry -Path $ClaspJsonPath -Content $claspOriginal
    }
} finally {
    if ($null -ne $savedIconEnv) { $env:AUDIO_SPLITTER_ICON_URL = $savedIconEnv } else { Remove-Item Env:AUDIO_SPLITTER_ICON_URL -ErrorAction SilentlyContinue }
    if ($null -ne $savedRedirectEnv) { $env:AUDIO_SPLITTER_REDIRECT_URL = $savedRedirectEnv } else { Remove-Item Env:AUDIO_SPLITTER_REDIRECT_URL -ErrorAction SilentlyContinue }
}
