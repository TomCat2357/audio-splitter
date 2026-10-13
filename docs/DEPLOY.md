# デプロイ手順（clasp で Google Apps Script の Web アプリとして配信する）

音声処理はすべてブラウザ内で行います。GAS は HTML の配信と、Google ドライブの閲覧・読み込み・保存の窓口（サーバー側は Drive との受け渡しだけで、音声の処理はしません）を担います。

> **未確認の範囲**: ここに書いた手順のうち、`clasp login` / `clasp push` / `clasp deploy` を伴う部分と、GAS 上での表示・音声ファイルの読み込み・ダウンロードの動作は、**実機では確認していません**（ローカルでの `-WhatIf`・`-Stage bundle`・テスト、および clasp を模擬したスタブでの流れの確認のみ）。初回のデプロイ後に、実際の Web アプリ URL で動作を確かめてください。
>
> **Google ドライブ連携の GAS 上での動作（承認画面、フォルダの一覧、ファイルの転送速度、Drive への保存）も未確認です。** テストは、GAS のサービスを模擬したスタブ（`node:vm`）に対するもので、本物の Google ドライブ・GAS には一度も接続していません。

## 構成

| ファイル | 役割 |
| --- | --- |
| `gas/Code.gs` | `doGet`、旧デプロイ → 新デプロイへのリダイレクト処理、Google ドライブ連携（1 ファイル。節の区切りコメントで分けてある）。冒頭の `APP_ICON_URL_` / `REDIRECT_URL_` / `DRIVE_ENABLED_`（3 行）はビルド時に `dist/` 側でだけ置換される |
| `gas/appsscript.json` | マニフェスト（`executeAs: USER_ACCESSING` / `access: MYSELF`。Drive 連携用の `oauthScopes` 3 つと Advanced Drive Service v3） |
| `scripts/bundle-gas.mjs` | `dist/` を clasp が push できる形に仕上げる（`gas/` のソースは書き換えない）。`executeAs` / `access` の最終値の判定、Drive 連携の無効化、`dist/appsscript.json` の書き出しはここに一本化 |
| `deploy.ps1` | ビルド → 組み立て → `clasp push` → `clasp deploy`。`-ExecuteAs` / `-Access` は `bundle-gas.mjs` にそのまま渡し、結果の表示と中止の判断だけを行う |

`dist/` には `index.html`（vite の成果物。`<head>` 直後に `<base target="_top">` を挿入）、`Code.gs`、`appsscript.json` の 3 ファイルが揃います。`dist/` は git に入りません。

## 初回の準備

1. `npm install -g @google/clasp`
2. `clasp login`（ブラウザで Google アカウントを選ぶ）
3. GAS プロジェクトを用意し、リポジトリ直下に `.clasp.json` を作る（どちらか）
   - 既存のプロジェクトを使う: `.clasp.json.example` を `.clasp.json` にコピーし、`YOUR_SCRIPT_ID` を GAS プロジェクトの Script ID（エディタの「プロジェクトの設定」にある）に書き換える
   - 新しく作る: `clasp create --type webapp --title "音声分割" --rootDir dist`
4. https://script.google.com/home/usersettings で「Google Apps Script API」をオンにする（clasp の利用に必要）

`.clasp.json` と `.gas-deployment.json` は git に入りません（`.gitignore` 済み）。

## `deploy.ps1`（Windows PowerShell 5.1 以降。PowerShell 7 でも可）

```
./deploy.ps1                       # ビルド + push + デプロイ（既定は -Stage deploy）
./deploy.ps1 -Stage bundle         # dist/ を作るだけ（clasp・ログイン不要）
./deploy.ps1 -WhatIf               # 実行予定を並べるだけ（ファイル変更・npm / clasp の実行なし。配信設定の確認に node を実行するが何も書かない）
./deploy.ps1 -Help
```

Windows PowerShell 5.1 で実行ポリシーによりスクリプトの実行が止められる場合は、`powershell -ExecutionPolicy Bypass -File .\deploy.ps1 ...` のように実行する（PowerShell 7 なら `pwsh -ExecutionPolicy Bypass -File .\deploy.ps1 ...`）。

| パラメータ | 意味 |
| --- | --- |
| `-Stage bundle\|push\|deploy` | どこまで進めるか。既定は `deploy`。`bundle` = dist/ の生成まで、`push` = さらに `clasp push`、`deploy` = さらにデプロイ |
| `-Test` | ビルドの前に `npm test`。失敗したら中止 |
| `-IconUrl <URL/ID>` | タブのアイコン。下の「アイコン」参照 |
| `-RedirectUrl <URL>` | 旧デプロイからの移動先。下の「リダイレクト」参照 |
| `-ExecuteAs deploying\|accessing` | 指定したときだけ `dist/appsscript.json` の `webapp.executeAs` を書き換える（`USER_DEPLOYING` / `USER_ACCESSING`。未指定なら `gas/` の `USER_ACCESSING`）。**`deploying` になる場合は Drive 連携を自動で無効にして組み立てる**（下の「Google ドライブ連携」） |
| `-Access myself\|domain\|anyone\|anonymous` | 指定したときだけ `webapp.access` を書き換える（`MYSELF` / `DOMAIN` / `ANYONE` / `ANYONE_ANONYMOUS`）。`anonymous` は `-ExecuteAs deploying` が必須 |
| `-ForcePush` | `clasp push --force`。下の「push がスキップされるとき」参照 |
| `-WhatIf` | 実行予定を表示するだけ |
| `-h`, `-Help` | ヘルプ |

**`-IconUrl` と `-RedirectUrl` は、指定したときだけ焼き込まれます。** 前回の値は引き継がれないので、アイコンやリダイレクトを使い続けるデプロイでは毎回指定してください（指定を忘れて再デプロイすると、焼き込み値のないコードが公開されます）。値は `dist/Code.gs` にだけ入り、`gas/` のソースや git には入りません。

手順: 引数の検証 → 配信設定の確認（`node scripts/bundle-gas.mjs --plan`。成り立たない組み合わせはここで `[NG]` にして何も実行せず止める。Drive 連携を自動で無効にする場合は目立つ色で表示）→ `-WhatIf` ならここで終了 → `-Test` なら `npm test` → `node_modules` が無ければ `npm install` → `npm run build` → `node scripts/bundle-gas.mjs`（`-ExecuteAs` / `-Access` の反映と Drive 連携の有効 / 無効もここ）→ `dist/` の確認 → （`-Stage push|deploy`）clasp の前提チェック → `.clasp.json` の `rootDir` を一時的に `dist` にして `clasp push` → `clasp deploy`。`.clasp.json` は終了時に必ず元の内容へ戻ります。

前提チェック（push / deploy のとき）: グローバルの `clasp` があること、`~/.clasprc.json`（`clasp login` の結果）があること、`.clasp.json` に `scriptId`（空でも `YOUR_SCRIPT_ID` でもない）があること。足りなければ案内を出して、何も送らずに止まります。

### デプロイ ID の再利用

初回の `clasp deploy` で得たデプロイ ID と URL は `.gas-deployment.json` に保存され、次回以降は `--deploymentId` を付けて**同じ URL のまま**更新します。更新に失敗した場合（削除済みなど）は警告を出して新規デプロイします（URL は新しくなります）。

### push がスキップされるとき

clasp は `appsscript.json` の上書き確認に非対話で答えられず、何も送らずに終了コード 0 で終わることがあります。出力に `Skipping push` があれば失敗として扱い止まるので、`-ForcePush` を付けて再実行してください。

## アイコン（`-IconUrl`）

ブラウザのタブに出るアイコン（favicon）を指定した画像にできます。指定しなければ Apps Script 既定のアイコンです。

```
./deploy.ps1 -IconUrl https://drive.google.com/file/d/<ファイルID>/view
```

- 指定できる形: Drive の共有 URL（`/file/d/<ID>/` または `?id=<ID>`）、Drive のファイル ID（英数字・`_`・`-` の 20 文字以上）、それ以外の `https://` の画像 URL。
- Drive の URL / ID は `https://lh3.googleusercontent.com/d/<ID>#.png` に変換されます。末尾が `.png` / `.ico` / `.jpg` / `.gif` でなく `#` も含まない `https://` の URL にも `#.png` が足されます。理由: Apps Script の `setFaviconUrl` は URL **の末尾の拡張子**で画像の種類を判定するためです（`#` 以降はサーバーに送られないので取得される画像は変わりません）。
- 画像が ico などのときは、値の末尾に `#.ico` / `#.png` / `#.jpg` / `#.jpeg` / `#.gif` を付けるとその拡張子になります（例: `-IconUrl "<URL または ID>#.ico"`）。
- **Drive に置く場合は、そのファイルの共有を「リンクを知っている全員」にしてください**（手動。コードは共有設定を変えません）。「組織内のみ」だと、閲覧者の状態によってはアイコンが表示されないことがあります。
- 変わるのは**タブのアイコンだけ**です。スマートフォンのホーム画面に追加したときのアイコンは変えられません（Apps Script の制約）。
- 反映は**再デプロイ後**です（スクリプト プロパティで切り替えるときは次のアクセスから）。ブラウザのキャッシュで古いアイコンが残る場合があります。
- `setFaviconUrl` が失敗しても画面は出ます（ログに記録されるだけ）。
- リダイレクトの案内ページ（一瞬しか出ない）にはアイコンを付けません。

### アイコンの決まり方（優先順位）

1. **スクリプト プロパティ `AUDIO_SPLITTER_ICON_URL`** が設定されていれば、それがアイコン。値は `-IconUrl` と同じ形（Drive の URL / ファイル ID / `https://` の画像 URL。末尾の `#.ico` なども同じ）で、同じ規則で変換されます。
   - 値が `off`（大文字小文字・前後の空白は無視）なら、焼き込み値があってもアイコンを**付けない**（解除）。
   - 値が不正（`https://` でない、Drive の URL からファイル ID を取り出せない、など）なときも**付けない**。焼き込み値には戻りません（誤設定に気づけるように）。ログに「値が不正」と 1 行残ります（値そのものは出しません）。
2. プロパティが未設定・空なら、**焼き込み値**（`-IconUrl`）がアイコン。
3. どちらも空なら Apps Script 既定のアイコンです。

プロパティは GAS エディタの「プロジェクトの設定 → スクリプト プロパティ」で設定します。**再デプロイなしで切り替え・解除できます**（反映は次のアクセスから）。プロパティを消せば焼き込み値に戻ります。

## リダイレクト（旧デプロイ → 新デプロイ）

別のデプロイ（URL）へ移したあと、旧 URL を開いた人を新 URL へ案内する仕組みです。案内ページ（自動遷移 + 「開く」ボタン）を返し、本体のアプリは読み込みません。

### 移動先の決まり方（優先順位）

1. **スクリプト プロパティ `AUDIO_SPLITTER_REDIRECT_URL`** が設定されていれば、それが移動先。
   - 値が `off`（大文字小文字・前後の空白は無視）なら、焼き込み値があっても**移動しない**（解除）。
   - 値が URL として不正（`https://script.google.com/` で始まらない、デプロイ ID を取り出せない）なときも**移動しない**。焼き込み値には戻りません（誤設定に気づけるように）。
2. プロパティが未設定・空なら、**焼き込み値**（`-RedirectUrl`）が移動先。
3. どちらも空なら何もしない。

プロパティは GAS エディタの「プロジェクトの設定 → スクリプト プロパティ」で設定します。**再デプロイなしで切り替え・解除できます**（反映は次のアクセスから）。

### 旧デプロイを新 URL に誘導する手順

1. 新しいデプロイを作り、その Web アプリ URL（`https://script.google.com/macros/s/<デプロイID>/exec`）を控える。
2. 旧デプロイ側のプロジェクト（または同じプロジェクトの旧デプロイ）に、次のどちらかで移動先を入れる。
   - 焼き込み: `./deploy.ps1 -RedirectUrl https://script.google.com/macros/s/<新デプロイID>/exec` で再デプロイ
   - プロパティ: 旧側のスクリプト プロパティ `AUDIO_SPLITTER_REDIRECT_URL` に新 URL を設定
3. 旧 URL を開くと、案内ページを経て新 URL に移る。新 URL のブックマークへの更新を促す文言が出る。

### 動作の細かい点

- ループ防止: 移動先 URL に `redirect_target=<移動先のデプロイID>` を付けて渡す。クエリの `redirect_target` が今の移動先 ID と一致すれば「移動済み」として通常表示し、一致しなければ（古い ID など）今の移動先へ移す。移動先を後で変えても、古いブックマークから新しい移動先へ追従する。
- 新しいデプロイを素の URL で開くと、自分自身へ 1 回だけ移動してから表示される（許容）。同じコードを新旧両方のデプロイにする場合は、新しい側にはリダイレクトを入れない運用が簡単。
- `?noredirect=1` を付けて開くと移動しない（管理者・動作確認用の手動オーバーライド。移動先 URL には付かない）。
- 起動時のクエリ（`noredirect` と `redirect_target` を除く）は移動先へ引き継ぐ。
- `https://script.google.com/` で始まりデプロイ ID を取り出せる URL 以外は無視する。
- 参考実装と違い、`ScriptApp.getService().getUrl()` は呼びません。実機では、開かれたデプロイによらず `/dev` の URL を返すため、「今どのデプロイが開かれたか」の判別に使えないことが分かっているためです（現在の URL は不明として扱う）。

## 公開範囲（`-Access`）

`gas/appsscript.json` の既定は `executeAs: USER_ACCESSING`（アクセスしている利用者として実行）、`access: MYSELF`（自分だけ）です。`-Access` で、デプロイ時にだけ変えられます。

| 値 | `webapp.access` | 誰が開けるか |
| --- | --- | --- |
| `myself` | `MYSELF` | デプロイした本人だけ |
| `domain` | `DOMAIN` | 同じ Google Workspace ドメインのユーザー |
| `anyone` | `ANYONE` | Google アカウントでログインした全員（警告を表示） |
| `anonymous` | `ANYONE_ANONYMOUS` | ログイン不要で、URL を知っている誰でも（警告を表示） |

ローカルファイルの分割では、音声データは GAS には送られません。Drive 連携を使うときだけ、利用者が選んだファイルの中身が GAS を経由します。公開範囲を広げるときは、意図した範囲かを確認してください。

組み合わせの制約:

| `-ExecuteAs` | `-Access` | 結果 |
| --- | --- | --- |
| 未指定 / `accessing` | 未指定 / `myself` / `domain` / `anyone` | Drive 連携は有効 |
| 未指定 / `accessing` | `anonymous` | **`[NG]` で何も実行せず止まる。** ログインしていない人には「アクセスしているユーザー」がいないため、GAS がこの組み合わせを受け付けない。ログイン不要で公開するなら `-ExecuteAs deploying` を付ける |
| `deploying` | 任意（`anonymous` も可） | Drive 連携は**自動で無効**（ローカルファイルの分割は使える） |

## Google ドライブ連携

アプリ内で Drive のフォルダをたどって音声・動画ファイルを開き、分割結果を Drive のフォルダに保存できます。サーバー側は `gas/Code.gs` の「Google ドライブ連携」節です。

> **未確認**: GAS 上での Drive 連携の動作（承認画面、フォルダの一覧、ファイルの転送速度、Drive への保存）は実機で確認していません。確認できているのはスタブに対するテストだけです。

### 操作の範囲

- Drive に対して行う操作は、**読み取り（一覧・検索・メタデータ・ファイルの中身）と、フォルダの新規作成・ファイルの新規作成だけ**です。
- 既存ファイルの上書き・名前変更・削除・移動・コピーはしません（そのための関数がありません。テストでも検査しています）。同名のファイルがあっても検査せず、Drive の仕様どおり同名で作られます（重複の回避は画面側）。
- 一覧と検索に出すのは、フォルダと「音声・動画らしいファイル」だけです（`audio/*`、`video/*`、`application/ogg`、および拡張子が m4a / mp3 / wav などの `application/octet-stream`）。Google ドキュメント形式は出しません。保存できるのも、拡張子が音声・動画のものだけです（MIME はクライアントの申告ではなく拡張子から決めます）。
- ダウンロードを禁止されたファイル（所有者の設定）は取得できず、画面側にそのコードを返します。

### 必要な権限（`gas/appsscript.json` の `oauthScopes`）

| スコープ | 理由 |
| --- | --- |
| `https://www.googleapis.com/auth/drive` | 一覧・検索・読み込み（`Drive` の Advanced Service、`UrlFetchApp` による `files.get?alt=media`）と、フォルダ・ファイルの新規作成。読み取りだけでなく新規作成もするため、`drive.readonly` や `drive.file` では足りません（他のアプリが作ったフォルダを保存先にでき、既存の音声ファイルを開けるようにするため）。 |
| `https://www.googleapis.com/auth/script.external_request` | `UrlFetchApp` で Drive の REST API（Range 付きの読み込み、再開可能アップロード）を呼ぶため。 |
| `https://www.googleapis.com/auth/userinfo.email` | 安全装置で、実効ユーザーとアクセスしているユーザーのメールアドレスを比べるため（`Session.getEffectiveUser()` / `Session.getActiveUser()`）。 |

あわせて `dependencies.enabledAdvancedServices` に Drive v3（`userSymbol: Drive`）を指定しています。`HtmlService` / `CacheService` / `PropertiesService` / `Utilities` / `Session` の利用に追加のスコープは要らない見込みですが、これも実機では確認していません。

### なぜ既定が `USER_ACCESSING` か

「デプロイしたユーザーとして実行」（`USER_DEPLOYING`）で公開すると、**アクセスした全員が、デプロイした人の Drive を閲覧・ダウンロード・書き込みできてしまいます**（サーバーはデプロイした人の権限で動くため）。「アクセスしているユーザーとして実行」（`USER_ACCESSING`）なら、利用者それぞれが自分の Drive だけを操作します。そのため既定を `USER_ACCESSING` にし、次の三重の安全装置を入れています。

1. **実行時の検査**: Drive 関連の公開関数はすべて、最初に共通のガード（`driveGuard_`）を通ります。`DRIVE_ENABLED_` が `true` で、実効ユーザーとアクセスしているユーザーのメールアドレスが空でなく一致するときだけ通り、取得に失敗したときや空のときは拒否します（`{ error, code: 'DRIVE_DISABLED' }` を返し、Drive には触れません）。画面側は `getDriveStatus()` でボタンの表示を決めます。
2. **焼き込みフラグ**: `gas/Code.gs` の `var DRIVE_ENABLED_ = true;` を、無効で組み立てるときに `dist/Code.gs` で `false` に置換します（`--drive off` または環境変数 `AUDIO_SPLITTER_DRIVE=off`。引数が優先）。
3. **権限そのものを外す**: 無効で組み立てるときは `dist/appsscript.json` から、Drive の読み書き（`drive`）と外部通信（`script.external_request`）のスコープ、および Advanced Drive Service を取り除きます。`oauthScopes` は空にせず、`userinfo.email`（自分のメールアドレスの参照）だけを明示して残します。

`-ExecuteAs deploying`（最終的な `executeAs` が `USER_DEPLOYING` になる場合）で組み立てると、`deploy.ps1` が**自動で Drive 連携を無効**にして、その旨を表示します（`-WhatIf` の列挙にも出ます）。ローカルファイルの分割は、Drive 連携なしでも使えます。

> **`oauthScopes` を空にしない理由**: `appsscript.json` に明示のスコープが 1 つも無いと、Apps Script はコードの内容から必要なスコープを自動で判定します。`dist/Code.gs` には無効の場合も Drive 関連のコードが残っているため、未指定にすると `drive` が付き直してしまい、3 が効かなくなります。明示のスコープがあれば自動判定は行われないので、害のない `userinfo.email` を残しています。**この挙動は実機では確認していません。** 無効で配信したとき、承認画面や GAS エディタの「プロジェクトの設定」に Drive のスコープが出ていないことを確認してください（1 と 2 は、この確認の結果によらず有効です）。

### デプロイ時の注意

- マニフェスト（`executeAs` とスコープ、Advanced Service）が変わったため、**次回の `clasp push` は `-ForcePush` が要ります**（`appsscript.json` の上書き確認に非対話で答えられず、`Skipping push` になるため）。
- **利用者は初回に承認画面が出ます。** `drive` は機密性の高いスコープなので、Google のアプリ審査を受けていない限り、**「確認されていないアプリ」の警告**が出ることがあります（詳細を開いて続行する形になります）。
- **スコープを変えると、全員の再承認が必要**になります（以後スコープを増減したときも同じです）。
- 自分のアカウントだけで使う（`access: MYSELF`）なら、承認するのはデプロイした本人だけです。

### 転送の仕組みと上限

ファイルの中身は、`google.script.run` 経由の base64 チャンクで受け渡します。**OAuth トークンもアップロードのセッション URL も、ブラウザには渡しません**（戻り値に含めず、テストで検査しています）。

- 読み込み: `getFileInfo` → `getFileChunk(fileId, offset, length)` を繰り返します。サーバーが `UrlFetchApp` で `files.get?alt=media` を Range 付きで読み、base64 にして返します（206 / 200 / 416 に対応。Range が効かないときはサーバー側で切り出し、`partial: false` を返します）。429 / 500 / 502 / 503 / 504、`UrlFetchApp` の例外、403 のうち利用回数の上限は一時的な失敗とみなし、`retryable: true` で返します（画面側が間隔を空けて再試行し、再試行が起きたら同時実行数を 1 に絞ります）。404 は再試行なしのエラーです。それ以外で Range 付きの取得が通らないとき（400 / 401 / 403 など）だけ、`DriveApp` でファイル全体を読んで切り出すフォールバックに入ります（50 MB まで）。ETag を返し、画面側が取得中の更新を検出できます。
- 保存: `beginUpload` → `uploadChunk` を繰り返し、`abortUpload` で取り消します。Drive の再開可能アップロード（resumable upload）をサーバーが `UrlFetchApp` でプロキシします。セッション URL は `CacheService.getUserCache()`（ユーザー単位、6 時間）に保存し、不透明なトークンだけを返します。応答だけが失われた再送には、Drive に状態を問い合わせて安全に続けます（`UrlFetchApp` が例外を投げて Drive が受け取ったか不明のときも、次の呼び出しは先に状態を問い合わせます）。完了したセッションは、セッション URL を含まない「完了済み」の印に置き換えて 30 分だけ残し、最後のチャンクの応答が失われて再送されても同じ結果を返します。
- 単位と上限: 1 チャンクは **8 MiB**（256 KiB の倍数。base64 で約 10.7 MB）。`getFileChunk` の `length` は 16 MiB まで。保存する 1 ファイルは **500 MB まで**です。
- 転送速度、`google.script.run` の呼び出し 1 回あたりの所要時間、GAS の実行時間・クォータ（1 日の `UrlFetchApp` 呼び出し数や転送量など）に収まるかは、**実機では確認していません**。

## OAuth スコープについて

Drive 連携を有効にして組み立てた `dist/appsscript.json` には、上の「必要な権限」の 3 つのスコープを明示しています。無効にして組み立てた場合は `userinfo.email` だけを明示します（前述の「`oauthScopes` を空にしない理由」を参照）。`PropertiesService`（スクリプト プロパティの読み取り）は承認を要求しないサービスとして扱われると理解していますが、**承認画面に影響が出ないことは実機では確認していません**。

## 確認の目安（実機）

- [ ] `./deploy.ps1 -ForcePush` が最後まで通り、Web アプリ URL が表示される
- [ ] URL を開いて画面が表示される（GAS 上での表示は未確認）
- [ ] 音声ファイルを選んで分割・圧縮でき、ダウンロードできる（GAS の iframe 内でのダウンロードは未確認）
- [ ] Drive 連携: 初回に承認画面が出る（`drive` の警告の有無を確認）
- [ ] Drive 連携: `getDriveStatus` が `enabled: true` になる（`Session.getActiveUser().getEmail()` が `USER_ACCESSING` で空にならないか。空だとガードで拒否される）
- [ ] Drive 連携: フォルダの一覧・検索・音声ファイルの読み込み（m4a が `audio/x-m4a` / `audio/mp4` / `application/octet-stream` のどれで保存されていても出る）、フォルダの新規作成、結果の保存
- [ ] `-ExecuteAs deploying` で配信したとき、Drive 連携が無効になり（`getDriveStatus` が `enabled: false`）、承認画面に Drive のスコープが出ない
- [ ] `-IconUrl` またはプロパティ指定時にタブのアイコンが変わる。プロパティ `off` で解除できる
- [ ] `-RedirectUrl` またはプロパティ指定時に新 URL へ移る。`?noredirect=1` で移らない。プロパティ `off` で解除できる
