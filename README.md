<div align="center">

# 使いすぎ防止モード

**利用枠の残量が指定値に達したら、Codexの長時間実行されるタスクを安全に停止させるプラグイン。**

現在の残量と停止しきい値を確認してから有効化し、親子関係にあるエージェント全体がリセット後も新しいタスクを続けることを防ぎます。

[English](README.en.md)

[![Latest release](https://img.shields.io/github/v/release/brumelight/codex-capacity-guard?display_name=tag&sort=semver)](https://github.com/brumelight/codex-capacity-guard/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)

</div>

---

## 概要

使いすぎ防止モード（Capacity Guard）は、Codexで長時間実行されるタスク、ゴールモード、複数エージェントによる並列タスクを実行するときに、利用枠（quota）の使いすぎを防ぐ安全装置です。

残量が指定したしきい値以下になった場合、残量が100%へ回復した場合、残量を確認できない状態が続いた場合のいずれかを検知すると、すでに始まっている途中で止められない処理だけを完了させます。その後は、新しいツールの実行、サブエージェントの起動、追加指示、次のタスクを停止します。モデル、推論レベル、速度は変更しません。

## 機能

- **1%刻みの停止しきい値** — 残量0〜100%の整数を自然文で指定
- **有効化前の確認** — 現在の残量、停止しきい値、推論レベルを表示し、推奨選択肢による明示承認を要求
- **リセット検知** — 同じ利用枠の更新期間内で、100%未満から100%への回復を検知
- **残量を確認できない場合の停止** — 有効な残量情報を2回連続で取得できない場合に停止
- **すべてのエージェントで共有** — 親、子、孫エージェントが同じ停止状態を参照
- **安全な停止** — 開始済みの処理は完了させ、フックで検知できる新しいタスクを停止

## 導入手順

### Windows（PowerShell）

```powershell
git clone https://github.com/BrumeLight/codex-capacity-guard.git
cd codex-capacity-guard
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Locale auto
```

### macOS／Linux（Bash）

```bash
git clone https://github.com/BrumeLight/codex-capacity-guard.git
cd codex-capacity-guard
./install.sh --locale auto
```

Codexを再起動して新しいタスクを開き、次のように指定します。

```text
残量30％まで使いすぎ防止モードで実行して
```

表示された現在の残量、停止しきい値、推論レベルを確認し、推奨選択肢（表示言語により `有効化 (Recommended)` または `accept (Recommended)`）を選ぶと有効になります。

### 選択肢形式の確認画面を有効にする（実験的）

通常モードで有効化／拒否の選択肢を表示するには、個人設定の `~/.codex/config.toml` に次を追加します。

```toml
[features]
default_mode_request_user_input = true
```

すでに `[features]` がある場合は、同じ見出しを増やさず、その中へ `default_mode_request_user_input = true` だけを追加してください。設定後はCodexを再起動し、新しいタスクを開きます。

この設定は実験的な機能です。Codexのバージョンによって、仕様が変わったり利用できなかったりする可能性があります。選択肢のラベルはCodexによってローカライズされる場合があります。選択肢を利用できない場合は、固定文による確認へ自動的に切り替わり、有効化には正確に `accept` と返信する必要があります。

## 使い方

### しきい値を指定する

```text
残量30％まで使いすぎ防止モードで実行して
```

0〜100%の整数を1%刻みで指定できます。

### 既定値を使う

```text
使いすぎ防止モードで実行して
```

しきい値を省略した場合は0%です。

### 有効化を確認する

確認画面には、値の照合に使う次の固定文言が英語で表示されます。

```text
Current quota remaining: "82%".
Stop threshold: "30%".
Current reasoning effort: "high".
Enable 使いすぎ防止モード for this run?
```

- 推奨選択肢（`有効化 (Recommended)`／`accept (Recommended)`）— 表示された条件で有効化
- 拒否選択肢（`拒否`／`deny`）— 有効化せず、無効のままにする

## インストーラーの設定項目

### PowerShell

| オプション | 説明 | 既定値 |
| --- | --- | --- |
| `-Locale auto\|ja\|en` | 画面上の表示名に使う言語 | `auto` |
| `-TargetRoot <path>` | プラグインを配置する親フォルダー | `%USERPROFILE%\plugins` |

### Bash

| オプション | 説明 | 既定値 |
| --- | --- | --- |
| `--locale auto\|ja\|en` | 画面上の表示名に使う言語 | `auto` |
| `--target-root <path>` | プラグインを配置する親フォルダー | `$HOME/plugins` |

`auto` はPowerShellではWindowsの優先言語、Bashではロケール環境変数を参照します。日本語なら「使いすぎ防止モード」、それ以外は「Capacity Guard」を使用します。

## 出力・変更内容

インストーラーは次の変更を行います。

```text
%USERPROFILE%\plugins\capacity-guard\
└── プラグイン本体

%USERPROFILE%\.agents\plugins\marketplace.json
└── 個人用マーケットプレイスの登録情報
```

macOS／Linuxでは、それぞれ `$HOME/plugins/capacity-guard/` と `$HOME/.agents/plugins/marketplace.json` を使用します。

- 既存の配置先がある場合、`capacity-guard.backup.<UTC時刻>` へ移動してからコピー
- 個人用マーケットプレイスに `capacity-guard` を登録または更新
- `codex plugin add capacity-guard@personal` を実行
- 実行時の状態と監査ログはCodexが提供する `PLUGIN_DATA` に保存（各hookの起動・失敗もpayloadを含めず記録）
- hook内部エラー時は、`PreToolUse` と有効化要求をfail-closedで停止し、その他のイベントでも未検証状態を明示
- 新規taskの初回有効化では、pluginが直近5分以内に観測したquota snapshotを検証して使用し、承認直前に現taskの値と再照合

## 必要環境

- Windows PowerShell 5.1+、またはmacOS／LinuxのBash 3.2+
- Node.js 18+
- プラグインとフックに対応したCodex CLI／Codexアプリ
- Git（リポジトリを複製して導入する場合）

PowerShell版とBash版のインストーラーを同梱しています。フック用コマンドは、シェル固有の環境変数構文ではなく、Codexが実行前に展開する `${PLUGIN_ROOT}` プレースホルダーを使用します。

## プロジェクト構成

```text
.
├── .codex-plugin/plugin.json       # プラグインメタデータ
├── hooks/hooks.json                # 動作段階ごとのフック定義
├── scripts/
│   ├── capacity-guard-hook.mjs     # 判定・共有状態・安全停止
│   └── test-capacity-guard.mjs     # 合成テスト
├── skills/capacity-guard/          # Codex向け利用手順
├── install.ps1
├── install.sh
├── uninstall.ps1
├── uninstall.sh
├── CHANGELOG.md
├── README.md
├── README.en.md
└── LICENSE
```

## 開発

外部のnpmパッケージは使用していません。

```powershell
# 構文検査
node --check .\scripts\capacity-guard-hook.mjs
node --check .\scripts\test-capacity-guard.mjs

# テスト
node .\scripts\test-capacity-guard.mjs
```

## 安全上の注意

- 利用枠はアカウント単位で共有される場合があり、別のタスクによる消費も確認結果へ影響します。
- 数値だけではユーザー任意リセットとシステム側リセットを区別できません。
- `resets_at` は補助証拠として記録しますが、単独では停止判定に使いません。
- `PreToolUse` が発火しないホスト型ツールや専用ツールは、強制停止を保証できません。
- 停止状態（`TRIPPED`）になった後は、開始済みの処理が終わるのを待つため、`list_agents` と `wait_agent` だけを許可します。
- プラグインはモデル、推論レベル、速度を自動変更しません。
- アンインストーラーはCodexへの登録だけを解除し、プラグイン本体とマーケットプレイスの登録情報は保持します。PowerShellでは `uninstall.ps1`、Bashでは `uninstall.sh` を使用します。

## ライセンス

[MIT License](LICENSE) © 2026 BrumeLight
