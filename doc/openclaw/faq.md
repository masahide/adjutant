❯ 1番についてわかりやすくまとめたい。まず、

- OpenClawはGateway（WebSocket制御プレーン）とNode（Pi Agent
  Runtime）に分離されています。Gatewayがメッセージルーティング、セッション管理、Telegram/Discord/Slackなど13以上のチャネル接続を担当
  - 間違いで、実際には？
- NodeがローカルマシンやVPS上でエージェントを実行します。
  - 間違いで、gatewayもここでいうnodeも単一のプロセス上で動作しているので、そもそも分離していない？
- Gatewayが発行するトークンを接続するクライアントから送信してNodeとマッチさせる仕組みです。
  - この部分は何を言ってるのかよくわからないし、詳しく教えて欲しい

⏺ まず実際のプロセス構成とNode/Gatewayの関係をコードで正確に把握します。

⏺ 2 Explore agents finished (ctrl+o to expand)
├─ Explore Gateway/Node process model · 49 tool uses · 75.6k tokens
│ ⎿  Done
└─ Explore token/device auth flow · 28 tool uses · 66.7k tokens
⎿  Done

⏺ 調査結果を整理します。3つの質問それぞれについて。

---

1. Gatewayの役割 — 何が間違いか

元の文章は「Gatewayはルーティング・セッション管理・チャネル接続を担当」としていますが、これだとGatewayは交通整理だけで、重い仕事はNodeがやるという印象を与えます。

実際には Gatewayがほぼ全てをやります。

┌───────────────────────────────────────────┬────────────────────────────────┐
│ 責務 │ 実行場所 │
├───────────────────────────────────────────┼────────────────────────────────┤
│ LLMエージェント推論（runEmbeddedPiAgent） │ Gateway │
├───────────────────────────────────────────┼────────────────────────────────┤
│ HEARTBEAT（定期自律推論） │ Gateway (startHeartbeatRunner) │
├───────────────────────────────────────────┼────────────────────────────────┤
│ チャネル接続（Slack, Telegram等） │ Gateway │
├───────────────────────────────────────────┼────────────────────────────────┤
│ セッション管理・メッセージルーティング │ Gateway │
├───────────────────────────────────────────┼────────────────────────────────┤
│ compaction（会話要約） │ Gateway │
├───────────────────────────────────────────┼────────────────────────────────┤
│ シェルコマンド実行（system.run） │ Node │
├───────────────────────────────────────────┼────────────────────────────────┤
│ カメラ・画面録画・位置情報取得 │ Node │
└───────────────────────────────────────────┴────────────────────────────────┘

Nodeはnode.invoke.requestを待ち受けるデバイスローカルのコマンド実行ワーカーです。エージェントの「頭脳」はGateway側で動いています。

---

1. GatewayとNodeは分離しているか — 分離はしている

「単一プロセスで動作しているので分離していない」という認識は誤りです。GatewayとNodeは別プロセスです。

# ターミナル1: Gatewayプロセス起動

openclaw gateway run --port 18789

# ターミナル2: Nodeプロセス起動（Gatewayに接続）

openclaw node run --host 127.0.0.1 --port 18789

Mac miniで1台運用する場合も、2つの別プロセスがWebSocketで通信します。launchd/systemdサービスとしてインストールすることもできます（openclaw gateway install / openclaw node install）。

元の文章の間違いは「分離していない」ことではなく、役割の説明が逆なことです。

- 誤: 「Nodeがエージェントを実行する」
- 正: Gatewayがエージェントを実行する。Nodeはデバイスローカルのコマンド実行（シェル、カメラ等）だけ

  ┌─ Gateway プロセス (port 18789) ─────────────────┐
  │ LLM推論 / HEARTBEAT / チャネル接続 / セッション │
  │ → Nodeにコマンド実行を委譲したいとき │
  │ node.invoke.request を送信 │
  └────────────────────┬────────────────────────────┘
  │ WebSocket
  ┌────────────────────┴────────────────────────────┐
  │ Node プロセス │
  │ → node.invoke.request を受信 │
  │ → system.run でシェルコマンド実行 │
  │ → node.invoke.result を返送 │
  └─────────────────────────────────────────────────┘

  ***
  1. 「トークンでNodeとマッチ」— 実際の仕組み

  元の文章は認証（authentication）と同定（identification）を混同しています。実際の接続フローはこうなっています。

  ステップ1: デバイスID生成（ローカル）

  各デバイス（Node/クライアント）は初回起動時にローカルで暗号鍵ペアを生成し、そこからdevice.idを導出します（src/node-host/runner.ts:131 の
  loadOrCreateDeviceIdentity()）。これはGatewayが発行するものではなく、デバイスが自分で生成する固有IDです。

  ステップ2: ペアリング（初回のみ）

  デバイスが初めてGatewayに接続すると、ペアリング承認が必要です。ユーザーがGateway側で接続を承認すると、device token（32バイトのランダムトークン）が生成され、デバイスに渡されます。

  ステップ3: 接続時の認証

  以降の接続では、デバイスはdevice.id + tokenをWebSocketハンドシェイクで送信します（message-handler.ts:631-633）。

  const tokenCheck = await verifyDeviceToken({
  deviceId: device.id,
  token: connectParams.auth.token,
  role,
  scopes,
  });

  tokenは「本人確認」（認証）に使われます。「あなたは本当にそのdevice.idの持ち主ですか？」の検証です。

  ステップ4: Nodeの登録と同定

  認証が通ると、NodeはGatewayのNodeRegistryに登録されます（node-registry.ts:43-45）。

  register(client: GatewayWsClient, opts) {
  const nodeId = connect.device?.id ?? connect.client.id;
  // nodeId で登録。以降の invoke ルーティングはこの nodeId で行う
  }

  Node同定はdevice.id（またはclient.id）で行われます。tokenではありません。

  まとめ

  ┌─────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ 元の文章の表現 │ 実態 │
  ├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 「Gatewayがトークンを発行」 │ トークンはペアリング承認時に生成される。Gatewayが一方的に発行するというより、デバイスとの双方向フロー │
  ├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ 「トークンでNodeとマッチ」 │ トークンは認証（本人確認）用。Node同定・ルーティングはdevice.idで行う │
  └─────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────┘

  元の文章は「トークンを使ってどのNodeかを特定する」と読めますが、実際にはトークンは認証、同定はdevice.idという二段構えです。

✻ Sautéed for 2m 48s

❯ 本人確認とは、本当の人が行う認証でしょうか？それとも機械的な認証？

⏺ 機械的な認証です。「本人確認」という表現が紛らわしかったので訂正します。

人間が介在するのは初回のペアリング承認のみです。

【初回接続】人間が介在
Node → Gateway: 「接続したい」
Gateway → ユーザー(人間): 「このデバイスの接続を許可しますか？」
ユーザー → Gateway: 「許可」
Gateway → Node: device token を払い出し（32バイトランダム）
Node: tokenをローカルに保存

【2回目以降】完全に機械的
Node → Gateway: device.id + token を送信
Gateway: tokenを定数時間比較で検証 → OK → NodeRegistryに登録

2回目以降の「本人確認」は、「このWebSocket接続が、以前ペアリング承認されたデバイスと同一か」を機械的に検証する処理です。人間は関与しません。TLS通信上でtokenを送り、Gateway側でverifyDevice
Token()が自動判定します。

「本人確認」ではなく**「デバイス認証」**と呼ぶ方が正確でした。

❯ ここでいうデバイスとは具体的にはなんでしょうか？いくか例で教えて欲しい

⏺ Searched for 9 patterns, read 4 files (ctrl+o to expand)

⏺ コードから全体像が明確になりました。

---

ここでいう「デバイス」は、GatewayにWebSocket接続するクライアントプログラムのことです。物理的なハードウェアそのものではなく、Gateway上で識別されるソフトウェアクライアントを指します。

コード上で定義されている具体的なデバイス（クライアントID）は以下の通りです（src/gateway/protocol/client-info.ts:1-14）。

┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────────┬──────────┐
│ クライアントID │ 具体例 │ role │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ node-host │ openclaw node run で起動するCLIプロセス。シェルコマンド実行を担当 │ node │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ openclaw-macos │ macOS用ネイティブアプリ（Swabble/）。カメラ・通知・画面録画等のOS機能にアクセス │ node │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ openclaw-ios │ iOS用アプリ。スマホからのチャットやデバイス機能提供 │ node │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ openclaw-android │ Android用アプリ │ node │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ webchat-ui │ ブラウザで開くチャットUI │ operator │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ openclaw-control-ui │ ブラウザで開く管理ダッシュボード │ operator │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ cli │ openclaw chat 等のCLIコマンド │ operator │
├─────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼──────────┤
│ gateway-client │ Gateway自身が内部的に他のGatewayやサービスに接続するときのID │ operator │
└─────────────────────┴─────────────────────────────────────────────────────────────────────────────────┴──────────┘

典型的な構成例

Mac mini 1台で運用する場合:

Mac mini
├─ Gateway プロセス (port 18789)
│ LLM推論、HEARTBEAT、チャネル接続
│
├─ node-host プロセス ← device.id: "abc123..."
│ system.run（シェルコマンド実行）
│
└─ macOS アプリ (Swabble) ← device.id: "def456..."
カメラ、画面録画、通知

3つとも同じマシン上の別プロセスで、WebSocketで通信します。

スマホから外出先で使う場合:

Mac mini (自宅)
├─ Gateway プロセス
├─ node-host プロセス ← device.id: "abc123..."
└─ macOS アプリ ← device.id: "def456..."

iPhone (外出先)
└─ iOS アプリ ← device.id: "ghi789..."
Gatewayに接続してチャット + デバイス機能提供

iOSアプリはoperator（チャットするUI）とnode（カメラ等のデバイス機能を提供）の両方の役割を兼ねられます。

device.id の正体

device.idは各デバイス（＝各クライアントプロセス）がローカルで生成するEd25519公開鍵のSHA-256ハッシュです（device-identity.ts:143-148）。

crypto.createHash("sha256").update(publicKeyRaw).digest("hex")

鍵ペアはデバイスのローカルに保存され、同じマシンの同じインストールからは常に同じdevice.idが導出されます。Gatewayが割り当てるのではなく、デバイスが自己生成する識別子です。

✻ Cogitated for 59s

❯ node-host について詳しく教えて、 gatewayで動作しているpi-coding-agentがツールを使いたいとなった場合に、 node-hostに通信して、コマンドを実行したりするのでしょうか？

⏺ Explore(Trace agent tool→node.invoke flow)
⎿  Done (42 tool uses · 81.2k tokens · 1m 27s)
(ctrl+o to expand)

⏺ はい、その理解で合っています。詳しく説明します。

Pi AgentのツールはGatewayローカルでも実行できる

重要な点として、node-hostへの委譲は必須ではありません。Gatewayプロセス自身もシェルコマンドを実行できます。

ツール実行時のhostパラメータでルーティングが決まります（src/agents/bash-tools.exec.ts）。

host="gateway"（デフォルト）→ Gatewayプロセスがchild_process.spawnで直接実行
host="node" → node-hostにWebSocket経由で委譲

つまり、node-hostが接続されていなくてもGateway単体でエージェントは動作します。シェルコマンドもGateway自身のプロセスとして実行されます。

node-hostが必要になるケース

node-hostに委譲する理由は、Gatewayとは別のマシン・別の環境でコマンドを実行したい場合です。

┌──────────────────┬────────────────────────────────────────────────────────────────────────┐
│ ケース │ 説明 │
├──────────────────┼────────────────────────────────────────────────────────────────────────┤
│ リモート実行 │ GatewayがVPSにあり、自宅のMac miniでコマンドを実行したい │
├──────────────────┼────────────────────────────────────────────────────────────────────────┤
│ macOSアプリ連携 │ macOSネイティブアプリ（Swabble）経由でカメラ・通知・画面録画を使いたい │
├──────────────────┼────────────────────────────────────────────────────────────────────────┤
│ iOS/Android │ スマホのデバイス機能（カメラ、位置情報等）にアクセスしたい │
├──────────────────┼────────────────────────────────────────────────────────────────────────┤
│ セキュリティ分離 │ Gatewayにシェル実行権限を持たせたくない │
└──────────────────┴────────────────────────────────────────────────────────────────────────┘

実行フロー（node-host経由の場合）

Pi Agent (Gateway上で動作)
│ 「このファイルの中身を見たい」→ tool call: system.run "cat foo.txt"
│
↓ host="node" の場合
Gateway (NodeRegistry.invoke)
│ WebSocket event: "node.invoke.request"
│ { requestId: "uuid-1", command: "system.run", params: { cmd: "cat foo.txt" } }
│
↓
node-host (handleInvoke)
│ child_process.spawn("cat", ["foo.txt"]) を実行
│ stdout/stderr/exitCode を収集
│
↓
node-host → Gateway
│ "node.invoke.result"
│ { id: "uuid-1", ok: true, payloadJSON: '{"stdout":"...", "exitCode":0}' }
│
↓
Gateway → Pi Agent
ツール結果としてLLMに返す

ポイントは、Pi AgentはGatewayとしか会話しないことです。node-hostの存在を直接意識するわけではなく、Gatewayが内部でルーティングを判断して必要に応じてnode-hostに委譲します。

Mac mini 1台運用の場合

Mac mini 1台でopenclaw gateway run + openclaw node runを両方動かしている場合、実質的には同じマシンのchild_process.spawnがGateway側で直接実行されるか、node-host側でWebSocket経由で実行され
るかの違いだけです。結果は同じですが、node-hostを立てておくとmacOSアプリ連携やexec approval管理がnode-host側で行えるという利点があります。

✻ Brewed for 2m 8s

❯ Macが1台の場合でもnode-hostは必ず起動するのでしょうか？

⏺ Explore(Check if node-host auto-starts)
⎿  Done (40 tool uses · 60.2k tokens · 1m 29s)
(ctrl+o to expand)

⏺ 必須ではありません。 Gateway単体で動作します。

node-hostの起動は完全にオプション

- openclaw gateway run は node-host を自動起動しない
- セットアップウィザード（src/wizard/onboarding.ts）も node-host のインストールを含まない
- openclaw gateway install と openclaw node install は独立したコマンドで、ユーザーが明示的に選択する

  Gateway単体で動く理由

  execツールのデフォルトの実行先は "sandbox"（サンドボックス環境）で、elevated（昇格）コマンドの場合は "gateway" に切り替わります（src/agents/bash-tools.exec.ts）。

  sandbox（デフォルト）→ Gateway上のサンドボックスで実行
  gateway（昇格時） → Gatewayプロセスからchild_process.spawnで実行
  node → 明示指定時のみ。node-hostが未接続ならエラー

  つまりMac 1台で openclaw gateway run だけ起動すれば、シェルコマンドはGateway自身のプロセスとして実行されます。node-hostがなくても基本的なエージェント動作には問題ありません。

  node-hostが未接続で host="node" を要求した場合

  フォールバックはなく、エラーになります。

  "exec host=node requires a paired node (none available).
  This requires a companion app or node host."

  Mac 1台の典型的な構成パターン

  パターンA: Gateway のみ（最小構成）
  openclaw gateway run
  → エージェント推論、HEARTBEAT、チャネル接続、シェル実行すべてGateway上

  パターンB: Gateway + node-host（フル構成）
  openclaw gateway run
  openclaw node run --host 127.0.0.1
  → node-host経由の実行やmacOSアプリ連携が使える

  パターンC: Gateway + macOSアプリ
  openclaw gateway run（またはアプリがgatewayをlaunchd経由で管理）
  macOSアプリがnode roleで接続
  → カメラ、通知、画面録画などOS固有機能が使える

  多くのユーザーはパターンAで運用していると考えられます。node-hostを立てるのはリモート実行やデバイス固有機能が必要な場合だけです。

✻ Worked for 1m 56s

❯ node-host を有効活用する例はやはり別のマシンでnode-hostを動かすことでしょうか？ 同じホストで動作させる意味はあまりなさそうに思いますが？

⏺ その直感は正しいです。同一ホストでCLI node-host（openclaw node
run）を動かすメリットはほぼありません。Gateway自身がchild_process.spawnで同じことをできるので、WebSocketを経由する分だけオーバーヘッドが増えるだけです。

node-hostが活きるケース

1. 別マシンでのリモート実行（本命のユースケース）

クラウドVPS (Gateway)
LLM推論、チャネル接続、HEARTBEAT
│
│ WebSocket
↓
自宅 Mac mini (node-host)
ローカルファイル操作、ビルド、テスト実行

Gatewayをクラウドに置いてスマホ等から外部アクセスしつつ、コマンド実行は自宅マシンで行うパターン。

1. 複数マシンへの分散実行

Gateway
├→ node-host A (Mac mini): ビルド・テスト
├→ node-host B (Linux server): デプロイ・インフラ操作
└→ node-host C (Raspberry Pi): IoTデバイス制御

エージェントが用途に応じて異なるNodeにコマンドを委譲できる。

1. 同一ホストでも意味があるのはネイティブアプリだけ

同一Macで意味があるのは、CLIのnode-hostではなくmacOSネイティブアプリがnode roleで接続するケースです。

Mac mini
├─ Gateway プロセス ← シェルコマンドはこちらで直接実行
└─ macOS アプリ (node role) ← Gateway からは呼べないOS固有API
カメラ撮影、画面録画、macOS通知、位置情報

これらはネイティブAPIへのアクセスが必要で、Node.jsのchild_process.spawnでは代替できないため、別プロセスとしてnode接続する意味があります。

まとめ

┌─────────────────────────────────────────┬───────────────────────────────────┐
│ 構成 │ 意味があるか │
├─────────────────────────────────────────┼───────────────────────────────────┤
│ 同一ホストでCLI node-host │ ほぼ無い。Gatewayの直接実行と同じ │
├─────────────────────────────────────────┼───────────────────────────────────┤
│ 別マシンでnode-host │ 主要ユースケース │
├─────────────────────────────────────────┼───────────────────────────────────┤
│ 同一ホストでネイティブアプリ(node role) │ あり。OS固有機能の提供 │
└─────────────────────────────────────────┴───────────────────────────────────┘

元の文章の「Mac miniで運用しているユーザーが多いですが、その場合はGatewayとNodeが1台の端末に同居」という記述は、ネイティブアプリのケースを指しているのであれば正確ですが、CLI
node-hostを同居させているという意味であれば実用上の意味は薄いです。

❯ もしかしてhost-node経由でコマンドを実行することで非同期にコマンド実行が可能ということはないでしょうか？
⎿  API Error: 503 Too many connections, please wait before trying again.

✻ Cooked for 3m 53s

❯ もしかしてhost-node経由でコマンドを実行することで非同期にコマンド実行が可能ということはないでしょうか？

⏺ Searched for 1 pattern, read 1 file (ctrl+o to expand)

⏺ いいえ、node-host経由でも同期的（リクエスト-レスポンス）です。非同期の利点はありません。

NodeRegistry.invoke()（node-registry.ts:107-155）の実装を見ると：

// line 139: Promiseで結果を待つ。タイムアウトはデフォルト30秒
return await new Promise<NodeInvokeResult>((resolve, reject) => {
const timer = setTimeout(() => {
this.pendingInvokes.delete(requestId);
resolve({ ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } });
}, timeoutMs);
this.pendingInvokes.set(requestId, { nodeId, command, resolve, reject, timer });
});

Gateway側はnode.invoke.requestを送信した後、node-hostからnode.invoke.resultが返ってくるまでPromiseで待機します。node-hostの結果が返るか、30秒のタイムアウトに達するまでブロックされます。

Gateway自身のchild_process.spawnもPromiseで結果を待つ設計なので、どちらの経路でも実行モデルは同じ（await
で結果を待つ）です。node-host経由にしたからといって「コマンドを投げっぱなしにして別の作業を進める」ような非同期実行にはなりません。

✻ Churned for 39s

❯ この情報を持ってdoc/openclaw/architecture.md の修正版をdoc/openclaw/architecture2.md に記載してほしい

⏺ Read 1 file (ctrl+o to expand)
⎿  Interrupted · What should Claude do instead?

❯ /model
⎿ Set model to Default (global.anthropic.claude-sonnet-4-5-20250929-v1:0)

❯ この情報を持ってdoc/openclaw/architecture.md の修正版をdoc/openclaw/architecture2.md に記載してほしい
⎿  API Error: Claude's response exceeded the 4096 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.

⏺ 修正版を作成します。
