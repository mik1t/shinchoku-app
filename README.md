# 進捗管理（ビズハブ社長向け）— Cloudflare版

claude.ai のアーティファクトで動いていたプロトタイプ（`sales-note.html`）を、Cloudflare 上の独立したWebアプリ（PWA）にしたものです。画面・操作・データ構造・見た目はプロトタイプのままです。

| 役割 | 使っているもの | ファイル |
|---|---|---|
| 画面（PWA） | Cloudflare Pages | `public/index.html`, `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` |
| API | Pages Functions | `functions/api/[[path]].js` |
| ログイン確認 | Cloudflare Access（メールのワンタイムコード）＋ API側でJWTを再検証 | `functions/api/_middleware.js`, `functions/_lib/auth.js` |
| データ | Cloudflare D1（1レコード＝1JSON） | `migrations/0001_init.sql` |
| 文字起こし | Workers AI `@cf/openai/whisper-large-v3-turbo` | `functions/api/[[path]].js` |
| 振り分け・議事録 | Claude API（`claude-sonnet-5-5`） | `functions/_lib/prompts.js` |
| PDF | html2canvas + jsPDF（端末側） | `public/index.html` |

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/all` | 全データ（clients / partners / minutes / settings）とログイン中のメール |
| PUT / DELETE | `/api/{clients,partners,minutes,settings}/:id` | 1件の保存・削除（同時編集は後勝ち） |
| POST | `/api/import` | プロトタイプの「全データを書き出す（移行用）」JSONを取り込む（管理者のみ。データがあるときは `?force=1`） |
| POST | `/api/transcribe` | 音声（16kHz・モノラルWAV、1チャンク60秒）→ Whisper で文字起こし |
| POST | `/api/sort` | メモの自動振り分け（プロトタイプの `runAI()` と同じプロンプト） |
| POST | `/api/minutes` | 議事録への変換（プロトタイプの `makeMinutes()` と同じプロンプト） |

## 音声入力のしくみ

1. 画面の録音ボタンで `MediaRecorder` 録音（iPhone は mp4、PC/Android は webm）
2. 端末側で 16kHz・モノラルWAV に変換し、60秒ずつに分割（長い会議音声・アップロードした音声ファイルも同じ）
3. `/api/transcribe` が Whisper を `language: "ja"`、`initial_prompt` 付きで呼ぶ
   - `initial_prompt` は「M&A用語（IM、NDA、LOI、トップ面談、基本合意、DD、ノンネーム、顧問先、税理士法人）→ 用語辞書 → クライアント名・つなぎ先名・担当者名・案件名（更新が新しい順）」の順に、Whisper の上限（224トークン）に収まるよう詰めます
4. 結果は入力欄に入るので、確認・修正してから「自動で振り分ける」「議事録に変換」

録音ボタンの場所：音声メモ画面（右下のマイク）、議事録作成画面（録音・音声ファイル）、タスクの「内容」欄、記録の追加欄。

---

## はじめての設定（ブラウザだけでできます）

### 1. Anthropic の APIキーを用意
[console.anthropic.com](https://console.anthropic.com/) → API Keys → Create Key。表示されたキー（`sk-ant-...`）を控えます。

### 2. Cloudflare の APIトークンとアカウントIDを用意
1. Cloudflare ダッシュボード → 右上の人型アイコン → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**
2. 権限（Permissions）に次を追加して作成
   - Account / **Cloudflare Pages** / Edit
   - Account / **D1** / Edit
3. アカウントIDは、ダッシュボードの **Workers & Pages** の右側に表示されています

### 3. GitHub にシークレットを登録
GitHub のこのリポジトリ → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** で次を登録します。

| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順2のトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 手順2のアカウントID |
| `ANTHROPIC_API_KEY` | 手順1のキー |
| `ALLOWED_EMAILS` | 使う人のメールアドレス（複数ならカンマ区切り）。テスト中は `miki.miyayoshi@fbmg.co.jp`、本番で社長のメールを追加 |
| `ADMIN_EMAILS` | `miki.miyayoshi@fbmg.co.jp` |
| `ACCESS_TEAM_DOMAIN` | 手順5で確認（例：`xxxx.cloudflareaccess.com`） |
| `ACCESS_AUD` | 手順5で確認（Application Audience (AUD) Tag） |

### 4. デプロイ
GitHub → **Actions** → 「Cloudflareへデプロイ」→ **Run workflow**。D1 の作成・テーブル作成・Pages プロジェクト作成・デプロイまで自動で行います。終わると `https://shinchoku.pages.dev`（名前が使われていた場合は表示されたURL）で公開されます。

> Pages のプロジェクト名を変えたいときは、Settings → Secrets and variables → Actions → **Variables** に `PAGES_PROJECT` を登録します。

### 5. ログイン（Cloudflare Access）を設定
1. Cloudflare ダッシュボード → **Zero Trust**（初回はチーム名を決めて Free プランを選択）
2. **Access** → **Applications** → **Add an application** → **Self-hosted**
   - Application domain：`shinchoku.pages.dev` と `*.shinchoku.pages.dev`（プレビューURLも守るため）
   - Identity providers：**One-time PIN**
3. Policy：Action **Allow**、Include → **Emails** に `miki.miyayoshi@fbmg.co.jp`（本番で社長のメールを追加）
4. 保存後、アプリの **Overview** に出る **Application Audience (AUD) Tag** を `ACCESS_AUD` に、**Settings → Custom Pages** などに出るチームドメイン（`xxxx.cloudflareaccess.com`）を `ACCESS_TEAM_DOMAIN` に登録
5. もう一度手順4（Run workflow）を実行して反映

API はこの2つの値で Access のログイン証明（JWT）を自分でも検証し、`ALLOWED_EMAILS` / `ADMIN_EMAILS` 以外のメールは拒否します。値が未登録のあいだは、API はすべて拒否します（安全側）。

> ホーム画面に追加したときアイコンが出ない場合は、Access に2つ目のアプリを追加し、パス `shinchoku.pages.dev/icons` と `shinchoku.pages.dev/manifest.webmanifest` を **Bypass（Everyone）** にしてください（中身はアイコン画像だけです）。

### 6. プロトタイプのデータを移す
1. 旧プロトタイプの「つなぎ先」タブ最下部 →「全データを書き出す（移行用）」でJSONを保存
2. 新アプリに管理者メールでログイン →「つなぎ先」タブ最下部 →「データを取り込む（初回移行・管理者のみ）」でそのJSONを選ぶ

---

## 社長に送る「ホーム画面への追加手順」

**iPhone**
1. Safari で `https://shinchoku.pages.dev` を開き、メールアドレスを入れて届いた6桁のコードでログイン
2. 画面下の共有ボタン（□に↑）をタップ
3. 「ホーム画面に追加」→「追加」。以後はホーム画面の「進捗管理」アイコンから開きます

**Android**
1. Chrome で `https://shinchoku.pages.dev` を開き、メールアドレスを入れて届いた6桁のコードでログイン
2. 右上の「︙」メニューをタップ
3. 「ホーム画面に追加」（または「アプリをインストール」）→「追加」

初めて録音ボタンを押したときに「マイクの使用を許可」と聞かれたら「許可」を押してください。

---

## 開発メモ

```sh
npm install
npm test                                  # API・認証・Whisperプロンプトのテスト
echo DEV_BYPASS_AUTH=1 > .dev.vars        # ローカルではログイン確認を省略
npx wrangler d1 migrations apply shinchoku-db --local
npx wrangler pages dev                    # Workers AI はリモート接続が必要
```
