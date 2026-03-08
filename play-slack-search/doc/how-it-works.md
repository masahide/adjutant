# play-slack-search How It Works

このドキュメントは `play-slack-search` の内部動作を実装ベースで説明するものです。README には使い方だけを書き、この資料では「何をどう取っているか」を中心に整理します。

## 1. 全体像

`play-slack-search` は Slack の公式 API を直接叩くツールではありません。

やっていることは大きく 3 段階です。

1. Node.js の CLI として引数と環境変数を解釈する
2. `playwright-cli` を外部プロセスとして起動し、既存の Slack ログイン済みブラウザプロファイルを使って Slack を開く
3. ブラウザ内で JavaScript を実行し、DOM または Slack クライアントの IndexedDB キャッシュから情報を取り出して JSON 化する

つまり、このツールは「Slack Web クライアントの現在の状態を、Playwright で人間の操作に近い形で読み取る」ものです。

## 2. 実行フロー

CLI の入口は `scripts/slack-search.ts` です。

実行時の流れは次です。

1. `.env` / `.env.local` を読む
2. CLI 引数を解釈する
3. ブラウザプロファイルのパスを正規化する
4. 既存の Playwright session を再利用できるか判定する
5. `search` / `list-channels` / `list-users` のどれを動かすか決める
6. `playwright-cli run-code` にブラウザ内実行コードを渡す
7. `### Result` ブロックの JSON を取り出す
8. 共通メタデータを足して stdout と必要なら `--output` 先に書く

主要な実装ファイル:

- `scripts/slack-search.ts`
- `scripts/slack-search/options.ts`
- `scripts/slack-search/session.ts`
- `scripts/slack-search/command.ts`
- `scripts/slack-search/playwright-cli.ts`
- `scripts/slack-search/browser/*.ts`

## 3. 設定の読み方

`.env` の読み込みは `scripts/slack-search/env.ts` が担当します。

読み込み順は次です。

1. すでに process 環境変数として入っている値
2. `play-slack-search/.env`
3. `play-slack-search/.env.local`

ただし実装上は「起動時点ですでに存在していた環境変数」を優先するので、シェルで export した値は `.env` より強いです。

主な設定キー:

- `PLAY_SLACK_SEARCH_WORKSPACE_URL`
- `PLAY_SLACK_SEARCH_SESSION`
- `PLAY_SLACK_SEARCH_PROFILE`

CLI 引数を明示した場合は、そちらが最優先です。

## 4. session 管理の仕組み

session 管理は `scripts/slack-search/session.ts` にあります。

### 4.1 再利用判定

まず `playwright-cli list` を実行し、その出力をパースして open/closed な session 一覧を取ります。

ここで見ているのは主に次の 2 点です。

- session 名
- `user-data-dir`

`user-data-dir` が今回使いたい profile と一致する open session があれば、その session を再利用します。

### 4.2 open の流れ

再利用できなければ、次のコマンド相当でブラウザを開きます。

```bash
playwright-cli -s=<session> open --profile=<profile> <workspace-url>
```

### 4.3 profile lock への対処

Chrome 系 profile は排他的に使われるので、同じ profile を別プロセスが掴んでいると `Browser is already in use` が出ます。

現在の実装は次の順で復旧を試みます。

1. その session に対して `close`
2. 同じ条件で再度 `open`
3. `--isolated` 付きで `open`

それでも失敗したら、`playwright-cli -s=<session> close` または `playwright-cli kill-all` を案内するエラーを返します。

補足:

- これは Playwright の daemon だけでなく、別の headless Chrome や手動で起動した Chrome が同じ `--user-data-dir` を掴んでいる場合にも起きます。
- 実際に lock の犯人を調べるときは `lsof +D <profile>` が有効です。

## 5. `playwright-cli run-code` の使い方

実ブラウザの処理は `scripts/slack-search/command.ts` から `playwright-cli run-code` に渡しています。

`serializeBrowserCode()` は、TypeScript の関数本体と入力 JSON を 1 本の文字列にして、次のような形へ変換します。

```text
async page => (browserRunner)(page, { ...input })
```

この文字列を `playwright-cli run-code` に渡し、ブラウザ側で評価させます。

戻り値の取り方は少し癖があります。`playwright-cli` の出力全体から `### Result` セクションだけを正規表現で抜き出し、その JSON を `parseRunCodeJsonOutput()` で `JSON.parse()` しています。

つまり Node.js 側とブラウザ側の境界は、実質的に「JSON を返せる関数」を `run-code` に渡す構成です。

## 6. search モードの内部動作

search は `scripts/slack-search/browser/search.ts` が担当します。

### 6.1 何をしているか

search モードは Slack の DOM を直接操作します。内部 state を直接読むのではなく、実際の検索 UI を開いて結果一覧をスクレイプしています。

流れは次です。

1. `workspaceUrl` へ `page.goto()`
2. Query combobox が見えるか確認
3. 見えなければ Search ボタンを押して検索 UI を開く
4. Query input に文字列を入れて Enter
5. `/search` URL と結果 DOM の出現を待つ
6. 並び順ボタンを見つけて `Newest` へ切り替える
7. 下へスクロールして結果件数を増やす
8. `Show more` を開く
9. `data-qa="search_result"` を起点に必要項目を抜く

### 6.2 DOM から抜いている項目

各検索結果について次を DOM から読んでいます。

- 送信者名
- 場所テキスト
- チャンネル名
- タイムスタンプラベル
- Slack の message URL
- 本文
- 結果内リンク

主な selector:

- `[data-qa="search_result"]`
- `[data-qa="message_sender_name"]`
- `[data-qa="search_result_channel_name"]`
- `[data-qa="inline_channel_entity__name"]`
- `[data-qa="message-text"]`
- `a.c-timestamp`

### 6.3 なぜ DOM 読み取りなのか

Slack の検索結果は UI 上で最終形がまとまっているため、検索に関しては IndexedDB より DOM を読んだ方が「ユーザーに見えている並び・本文・URL」をそのまま取れます。

### 6.4 制約

- Slack UI の `data-qa` やボタン文言が変わると壊れます
- 取得できるのは、検索結果画面で実際に描画された分です
- スクロール回数は固定回数なので、巨大な検索結果を全件取る用途ではありません

## 7. `--list-channels` の内部動作

channel-list は `scripts/slack-search/browser/list-channels.ts` が担当します。

### 7.1 どこから取っているか

`--list-channels` は DOM ではなく、Slack Web クライアントがブラウザ内に保持している IndexedDB から取っています。

使っている IndexedDB:

- DB 名: `reduxPersistence`
- store 名: `reduxPersistenceStore`

そこに保存されている Slack client state のうち、`persist:slack-client-<teamId>-...` という key を探し、その値を Slack の Redux 永続化 state とみなします。

`teamId` は現在の URL の `/client/<teamId>/...` から推定します。

### 7.2 どの slice を読むか

channel-list は state の `channels` slice を読みます。

その後、次の条件でフィルタします。

- `channel.is_channel`
- または `channel.is_group`

ここで重要なのは、現在の実装では DM / MPIM は一覧対象に含めていないことです。

`classifyChannel()` 自体は `dm` / `mpim` を返せますが、前段の filter が `is_channel` / `is_group` に限定されているため、実質的には public/private channel の一覧です。

### 7.3 整形内容

各 channel から次を取り出しています。

- `id`
- `name`
- `name_normalized`
- 種別
- archived/private/member などの各種フラグ
- `created`
- `updated`
- `previous_names`
- `purpose.value`
- `topic.value`

ソートは `name_normalized` 優先、なければ `name` です。

### 7.4 この方式の意味

Slack の UI を開いてサイドバーをスクレイプするのではなく、内部キャッシュからまとめて取るので、一覧取得は比較的安定しています。

一方で、これは「Slack クライアントがその時点で保持している state」のスナップショットです。サーバーへライブに問い合わせているわけではありません。

## 8. `--list-users` の内部動作

user-list は `scripts/slack-search/browser/list-users.ts` が担当します。

### 8.1 どこから取っているか

channel-list と同じく IndexedDB を使います。

- DB 名: `reduxPersistence`
- store 名: `reduxPersistenceStore`

同じ `persist:slack-client-<teamId>-...` key を開いて、その中の user 相当 slice を見ます。

### 8.2 `users` ではなく `members` を使う理由

当初は `state.users` を読んでいましたが、実際の Slack client state では `users` が空、または存在しない一方で、`members` に実データが入っているケースがありました。

そのため現在は次の候補を比較しています。

1. `state.members`
2. `state.users`

両方の entry 数を見て、実データがある方を採用します。返却 JSON の `source` には実際に使った slice 名を入れます。

### 8.3 取り出す項目

各 user / member から次を作ります。

- `id`
- `teamId`
- `name`
- `realName`
- `displayName`
- `displayNameNormalized`
- `title`
- `email`
- `tz`
- `updated`
- `isAdmin`
- `isAppUser`
- `isBot`
- `isDeleted`
- `isOwner`
- `isPrimaryOwner`
- `isRestricted`
- `isStranger`
- `isUltraRestricted`

`realName` や `displayName` は `profile` 配下も含めて補完します。

### 8.4 ソート順

次の優先順で文字列キーを作って並べます。

1. `displayNameNormalized`
2. `displayName`
3. `realName`
4. `name`
5. `id`

### 8.5 制約

- これは Slack クライアントにキャッシュ済みの member 情報です
- 必ずしもワークスペース全ユーザーを完全網羅するとは限りません
- bot、削除済みユーザー、外部チーム所属ユーザーも state に入っていれば返ります

## 9. 出力形式

返却 JSON には mode ごとの本体に加えて、共通メタデータを付けています。

- `generatedAt`
- `profile`
- `session`
- `workspaceUrl`

`query` は search のときだけ検索文字列で、list 系では `null` です。

`--output` を付けた場合は stdout に出すだけでなく、親ディレクトリを `mkdir -p` したうえでファイルにも書きます。

## 10. 既知の弱点

このツールは Slack の公開 API クライアントではなく、Slack Web クライアント内部状態への依存が大きいので、次の点に弱いです。

- Slack UI の DOM 構造変更
- Slack の IndexedDB schema 変更
- ブラウザ profile lock
- ログイン期限切れ

特に `--list-channels` と `--list-users` は「Slack がブラウザに保持している Redux persistence の形」に依存しています。将来の Slack 更新で `channels` / `members` / `users` の構造が変わると修正が必要です。

## 11. どのモードを使い分けるべきか

- 検索結果を人間が見ている形で欲しい: `--query`
- チャンネルのメタ情報をまとめて欲しい: `--list-channels`
- ユーザー ID / 表示名 / email をキャッシュから取りたい: `--list-users`

検索だけは DOM 操作、一覧系は IndexedDB 読み取り、というのが一番重要な設計上の違いです。
