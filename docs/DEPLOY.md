# デプロイ手順（clasp で Google Apps Script の Web アプリとして配信する）

GAS は HTML を配信するだけで、音声処理はすべてブラウザ内で行います（サーバー側の業務ロジックはありません）。

> **未確認の範囲**: ここに書いた手順のうち、`clasp login` / `clasp push` / `clasp deploy` を伴う部分と、GAS 上での表示・音声ファイルの読み込み・ダウンロードの動作は、**実機では確認していません**（ローカルでの `-WhatIf`・`-Stage bundle`・テスト、および clasp を模擬したスタブでの流れの確認のみ）。初回のデプロイ後に、実際の Web アプリ URL で動作を確かめてください。

## 構成

| ファイル | 役割 |
| --- | --- |
| `gas/Code.gs` | `doGet` と、旧デプロイ → 新デプロイへのリダイレクト処理（1 ファイル）。冒頭の `APP_ICON_URL_` / `REDIRECT_URL_`（2 行）はビルド時に `dist/` 側でだけ置換される |
| `gas/appsscript.json` | マニフェスト（`executeAs: USER_DEPLOYING` / `access: MYSELF`。`oauthScopes` は書かない） |
| `scripts/bundle-gas.mjs` | `dist/` を clasp が push できる形に仕上げる（`gas/` のソースは書き換えない） |
| `deploy.ps1` | ビルド → 組み立て → `clasp push` → `clasp deploy` |

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
./deploy.ps1 -WhatIf               # 実行予定を並べるだけ（ファイル変更・外部コマンドなし）
./deploy.ps1 -Help
```

Windows PowerShell 5.1 で実行ポリシーによりスクリプトの実行が止められる場合は、`powershell -ExecutionPolicy Bypass -File .\deploy.ps1 ...` のように実行する（PowerShell 7 なら `pwsh -ExecutionPolicy Bypass -File .\deploy.ps1 ...`）。

| パラメータ | 意味 |
| --- | --- |
| `-Stage bundle\|push\|deploy` | どこまで進めるか。既定は `deploy`。`bundle` = dist/ の生成まで、`push` = さらに `clasp push`、`deploy` = さらにデプロイ |
| `-Test` | ビルドの前に `npm test`。失敗したら中止 |
| `-IconUrl <URL/ID>` | タブのアイコン。下の「アイコン」参照 |
| `-RedirectUrl <URL>` | 旧デプロイからの移動先。下の「リダイレクト」参照 |
| `-ExecuteAs deploying\|accessing` | 指定したときだけ `dist/appsscript.json` の `webapp.executeAs` を書き換える（`USER_DEPLOYING` / `USER_ACCESSING`） |
| `-Access myself\|domain\|anyone\|anonymous` | 指定したときだけ `webapp.access` を書き換える（`MYSELF` / `DOMAIN` / `ANYONE` / `ANYONE_ANONYMOUS`） |
| `-ForcePush` | `clasp push --force`。下の「push がスキップされるとき」参照 |
| `-WhatIf` | 実行予定を表示するだけ |
| `-h`, `-Help` | ヘルプ |

**`-IconUrl` と `-RedirectUrl` は、指定したときだけ焼き込まれます。** 前回の値は引き継がれないので、アイコンやリダイレクトを使い続けるデプロイでは毎回指定してください（指定を忘れて再デプロイすると、焼き込み値のないコードが公開されます）。値は `dist/Code.gs` にだけ入り、`gas/` のソースや git には入りません。

手順: 引数の検証 → `-WhatIf` ならここで終了 → `-Test` なら `npm test` → `node_modules` が無ければ `npm install` → `npm run build` → `node scripts/bundle-gas.mjs` → `dist/` の確認 → `-ExecuteAs` / `-Access` の反映 → （`-Stage push|deploy`）clasp の前提チェック → `.clasp.json` の `rootDir` を一時的に `dist` にして `clasp push` → `clasp deploy`。`.clasp.json` は終了時に必ず元の内容へ戻ります。

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
- 反映は**再デプロイ後**です。ブラウザのキャッシュで古いアイコンが残る場合があります。
- `setFaviconUrl` が失敗しても画面は出ます（ログに記録されるだけ）。
- リダイレクトの案内ページ（一瞬しか出ない）にはアイコンを付けません。

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

`gas/appsscript.json` の既定は `executeAs: USER_DEPLOYING`（デプロイした本人として実行）、`access: MYSELF`（自分だけ）です。`-Access` で、デプロイ時にだけ変えられます。

| 値 | `webapp.access` | 誰が開けるか |
| --- | --- | --- |
| `myself` | `MYSELF` | デプロイした本人だけ |
| `domain` | `DOMAIN` | 同じ Google Workspace ドメインのユーザー |
| `anyone` | `ANYONE` | Google アカウントでログインした全員（警告を表示） |
| `anonymous` | `ANYONE_ANONYMOUS` | ログイン不要で、URL を知っている誰でも（警告を表示） |

サーバー側の処理は HTML の配信だけで、音声データは GAS には送られません。それでも公開範囲を広げるときは、意図した範囲かを確認してください。`-ExecuteAs accessing` にすると、アクセスした人として実行されます。

## OAuth スコープについて

`gas/appsscript.json` に `oauthScopes` は書いていません。使っているサービスは `HtmlService` と `PropertiesService`（スクリプト プロパティの読み取り）だけで、Apps Script は自動検出のスコープで足りる見込みです。`PropertiesService` はスコープの承認を要求しないサービスとして扱われると理解していますが、**承認画面に影響が出ないことは実機では確認していません**。初回のデプロイ・アクセスで承認画面が出るか確認してください。

## 確認の目安（実機）

- [ ] `./deploy.ps1` が最後まで通り、Web アプリ URL が表示される
- [ ] URL を開いて画面が表示される（GAS 上での表示は未確認）
- [ ] 音声ファイルを選んで分割・圧縮でき、ダウンロードできる（GAS の iframe 内でのダウンロードは未確認）
- [ ] `-IconUrl` 指定時にタブのアイコンが変わる
- [ ] `-RedirectUrl` またはプロパティ指定時に新 URL へ移る。`?noredirect=1` で移らない。プロパティ `off` で解除できる
