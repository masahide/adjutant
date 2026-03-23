# vendor/codex の skills 機能の実装メモ

## 目的

この文書は `vendor/codex` に実装されている `skills` 機能が、どのように探索・ロードされ、どのタイミングでモデル入力へ反映されるかを整理した調査メモである。

調査対象の中心は以下の実装である。

- `vendor/codex/codex-rs/skills/src/lib.rs`
- `vendor/codex/codex-rs/core/src/skills/loader.rs`
- `vendor/codex/codex-rs/core/src/skills/manager.rs`
- `vendor/codex/codex-rs/core/src/skills/render.rs`
- `vendor/codex/codex-rs/core/src/skills/injection.rs`
- `vendor/codex/codex-rs/core/src/skills/invocation_utils.rs`
- `vendor/codex/codex-rs/core/src/project_doc.rs`
- `vendor/codex/codex-rs/tui/src/chatwidget.rs`

## 結論

`skills` はプラグイン実行基盤というより、`SKILL.md` を単位にしたローカル instruction パッケージである。

実装上の挙動は次の二段構えになっている。

1. 通常時は skill 一覧だけを instructions に載せる。
2. 実際に skill が明示選択されたときだけ、その `SKILL.md` 本文を追加の user message として注入する。

そのため、skill は「専用ハンドラを呼ぶ仕組み」ではなく「必要時に追加文脈を差し込む仕組み」と考えるのが近い。

## skill の実体

skill の最小単位は `SKILL.md` である。`SKILL.md` の YAML frontmatter から、少なくとも以下を読む。

- `name`
- `description`
- `metadata.short-description`

これに加えて、同じ skill ディレクトリの `agents/openai.yaml` が存在すれば、以下の補助メタデータを読む。

- `interface`
- `dependencies`
- `policy`
- `permissions`

重要なのは、`openai.yaml` は補助情報であり必須ではない点である。`openai.yaml` が壊れていても、`SKILL.md` 自体は fail-open で読み込まれる。

実装根拠:

- `loader.rs` の `SkillFrontmatter`, `SkillMetadataFile`
- `loader.rs` の `parse_skill_file()`
- `loader.rs` の `load_skill_metadata()`

## system skill の供給方法

組み込み skill は `codex-rs/skills` crate 側で `include_dir!` によりバイナリへ埋め込まれている。起動時に `CODEX_HOME/skills/.system` へ展開し、fingerprint が一致していれば再展開を省略する。

この構造により、Codex 本体に同梱された sample skill をオンディスクの skill と同じ形式で扱える。

要点:

- 埋め込み元は `codex-rs/skills/src/assets/samples`
- 展開先は `CODEX_HOME/skills/.system`
- marker file と fingerprint で差分判定する

実装根拠:

- `vendor/codex/codex-rs/skills/src/lib.rs`

## skill の探索先

skill root は 1 か所ではなく、設定レイヤと作業ディレクトリから複数導出される。

主な探索先:

- project config 配下の `skills`
- user config 配下の `skills`
- `$HOME/.agents/skills`
- `CODEX_HOME/skills/.system`
- system config 配下の `skills`
- project root から `cwd` までの各ディレクトリにある `.agents/skills`
- plugin が追加する skill root

補足:

- project root は `project_root_markers` で決まる
- `.agents/skills` は project root から `cwd` までの各階層で探す
- 同じ path は dedupe される

実装根拠:

- `loader.rs` の `skill_roots()`
- `loader.rs` の `skill_roots_from_layer_stack_inner()`
- `loader.rs` の `repo_agents_skill_roots()`

## skill の走査とロード

skill root 配下は BFS 風に走査され、`SKILL.md` を見つけると parse される。

走査上のルール:

- 隠しディレクトリや隠しファイルは無視する
- 最大深さは `MAX_SCAN_DEPTH = 6`
- root ごとの最大訪問ディレクトリ数は `MAX_SKILLS_DIRS_PER_ROOT = 2000`
- repo/user/admin skill では symlink directory をたどる
- system skill では symlink を追わない

ロード後は以下の順に整列される。

- `Repo`
- `User`
- `System`
- `Admin`

同一 skill path は後段で重複排除される。

実装根拠:

- `loader.rs` の `discover_skills_under_root()`
- `loader.rs` の `load_skills_from_roots()`

## 生成されるメタデータ

読み込み結果は `SkillMetadata` に集約される。主要フィールドは次のとおり。

- `name`
- `description`
- `short_description`
- `interface`
- `dependencies`
- `policy`
- `permission_profile`
- `path_to_skills_md`
- `scope`

この構造体は UI 表示にも、実際の注入にも使われる。

実装根拠:

- `model.rs` の `SkillMetadata`

## SkillsManager の役割

`SkillsManager` は skill のロードと `cwd` 単位のキャッシュを担当する。

役割:

- 起動時に system skill をインストールする
- `cwd` に対する skill 一覧を返す
- 必要なら config layer を再ロードして skill roots を再計算する
- enabled/disabled 設定を反映する
- implicit invocation 用の index を生成する

`skills_for_cwd()` はキャッシュを利用し、`force_reload` が指定された場合のみ再スキャンする。

実装根拠:

- `manager.rs` の `SkillsManager`
- `manager.rs` の `finalize_skill_outcome()`

## enabled/disabled の扱い

skill の有効・無効は user/session layer の `skills` 設定から決まる。ここで無効化された path は `disabled_paths` に入る。

この状態は次の両方に影響する。

- UI の一覧表示
- 明示呼び出し時の選択対象

実装根拠:

- `manager.rs` の `disabled_paths_from_stack()`

## 通常時にモデルへ渡される情報

通常時は各 skill の本文そのものは投入されない。まず instructions へ「利用可能な skill 一覧」と「skill をどう使うかのルール」を追記する。

ここで追加されるのは主に以下である。

- skill 名
- 説明
- `SKILL.md` の file path
- skill 利用ルール

このセクションは `AGENTS.md` 相当の user instructions に連結される。

実装根拠:

- `render.rs` の `render_skills_section()`
- `project_doc.rs` の `get_user_instructions()`

## 明示的な skill 呼び出し

ユーザーが skill を使う導線は 2 種類ある。

- TUI から選択されて `UserInput::Skill { name, path }` が送られる
- テキスト中の `$skill-name` や `[$skill](path)` が解析される

turn 開始時、core は入力から明示的に呼ばれた skill を解決する。解決後、その `SKILL.md` 本文を読み込み、`<skill>...</skill>` で包んだ `ResponseItem` を user message として追加注入する。

この注入の結果、モデルは skill 本文をターン限定の追加文脈として参照できる。

実装上の流れ:

1. `collect_explicit_skill_mentions()` で対象 skill を解決する
2. `build_skill_injections()` で `SKILL.md` を読む
3. `SkillInstructions` を `ResponseItem` に変換する
4. turn の入力列へ追加する

実装根拠:

- `protocol/src/user_input.rs` の `UserInput::Skill`
- `tui/src/chatwidget.rs` の skill 入力組み立て
- `core/src/skills/injection.rs`
- `core/src/codex.rs`
- `core/src/instructions/user_instructions.rs`
- `core/src/contextual_user_message.rs`

## skill 注入のメッセージ形式

skill 本文は内部的には通常の user message として注入されるが、`<skill>` タグで囲われた contextual fragment になっている。

概念的には次のような形式になる。

```xml
<skill>
<name>demo-skill</name>
<path>/abs/path/to/SKILL.md</path>
...SKILL.md の本文...
</skill>
```

これにより、履歴上でも「通常ユーザー発話」ではなく「skill 注入」であることを識別できる。

## implicit invocation の実態

`policy.allow_implicit_invocation` や `scripts/` ディレクトリを使った index は存在する。ただし、今回確認した範囲では、implicit invocation は `SKILL.md` 本文の自動注入には使われていない。

`invocation_utils.rs` でやっていることは主に次である。

- skill 配下の `scripts/*.py` などを実行したか検知する
- `SKILL.md` 自体を `cat` や `sed` などで読んだか検知する
- 重複を抑えつつ analytics / metrics を記録する

つまり、現時点の実装では implicit invocation は「注入トリガー」というより「観測と記録」に近い。

実装根拠:

- `invocation_utils.rs` の `build_implicit_skill_path_indexes()`
- `invocation_utils.rs` の `maybe_emit_implicit_skill_invocation()`

## app-server と TUI の連携

app-server には `skills/list` RPC があり、指定 `cwd` の skill 一覧を返す。TUI はこの結果を使って次を実現している。

- skill 候補ポップアップ
- enable/disable UI
- mention 候補への反映

`skills/list` は `SkillsManager` を呼び、必要なら `per_cwd_extra_user_roots` も足して一覧を返す。

実装根拠:

- `app-server/src/codex_message_processor.rs` の `skills_list()`
- `tui/src/chatwidget/skills.rs` の `set_skills_from_response()`

## 実装上の設計意図

この設計にはいくつか意図があると読める。

- skill 本文を常時全部入れず、明示選択時だけ入れるのでコンテキストを節約できる
- skill をファイルとして持つため、`scripts/`, `references/`, `assets/` を同じディレクトリにまとめられる
- 組み込み skill も user skill も最終的には同じ on-disk 形式に揃えられる
- `openai.yaml` を補助メタデータに分離することで、UI 表現や依存関係を追加しても `SKILL.md` の最小要件を壊さない

## まとめ

`vendor/codex` の skills 機能は、要約すると以下である。

- skill の本体は `SKILL.md`
- 補助メタデータは `agents/openai.yaml`
- skill roots は config, home, project 配下の複数場所から導出する
- 通常時は一覧だけを instructions に載せる
- 明示選択時だけ `SKILL.md` 本文を `<skill>` fragment として注入する
- implicit invocation は少なくとも今回確認した範囲では analytics 寄りで、本文自動注入の主経路ではない

この理解を前提にすると、Codex の skill は「ファイルシステム上の再利用可能な追加指示セット」であり、必要時にだけターン文脈へ差し込まれる軽量な instruction モジュールと整理できる。
