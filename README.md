# 使いすぎ防止モード（Capacity Guard）

利用者が指定した残量条件で新しい作業を増やすのを止め、進行中の処理を安全な区切りまで収めてcheckpointを残すCodexスキルです。

[English](README.en.md) · [MIT License](LICENSE)

## 使い方

```text
残量30％まで使いすぎ防止モードで実行して
```

明確な依頼と閾値があれば、その指示を有効化の根拠にします。二重承認や固定の `accept` 入力は不要です。閾値が未指定・曖昧なら不足分だけを確認します。紹介、引用、インストール、見直しでは有効化しません。OFFでは残量確認も通常作業への干渉も行いません。

利用可能なusage-limitsツールで開始時と意味のある区切りに残量を確認します。適用するbucket/windowを記録し、複数の制約がある場合は最小の残量を使います。モデルやeffortは変更しません。

## 安全停止

- 残量が閾値以下、同じ枠でreset・予期しない回復を観測、または必要な観測を取得できなくなった場合、新しい作業を増やしません。観測の一時失敗は作業を挟まず一度だけ再確認できます。
- 開始済み処理の結果回収、安全な取消、状態を確定するための必要な検証、保存、checkpoint、handoffを有限の範囲で行います。新機能・次のタスク・代替Agentの起動は行いません。
- 稼働中Agentにも安全な区切りで停止・保存・返却するよう伝えます。収束が確認できなければ未確認の対象と次の操作を残します。
- 停止理由、最新の観測値と時刻、閾値、完了と保留、checkpoint、再開手順を報告します。resetやGoal自動継続で勝手に再開しません。利用者の再開指示後、checkpointと現在の残量を照合します。

checkpointにはその作業を復元するために必要な担当・Task・実効設定・変更所有範囲・証拠・未決・権限境界・次の具体的操作を残します。開始・区切り・最終停止前に保存し、圧縮前に機会があれば更新します。圧縮前通知や直前保存は常に保証されるものではありません。

## 保証の範囲

0.2.0はprompt-firstです。hookを登録せず、状態機械やtool allowlistを使いません。旧hook入口も何も読み書きせず空の応答を返します。過去の状態ファイルは保存したまま、有効化の根拠には使いません。

指示への追従はbest-effortであり、残量の厳密な上限や全Agentの停止を機械的には保証しません。同じアカウントの他taskや、観測間の推論・開始済み処理でも残量は減ります。promptで制御できない具体的な失敗を確認した場合だけ、その失敗に必要な決定論的補助を検討します。

## インストール・更新

このrepositoryを恒久的な場所へ配置して実行します。Node.jsと `codex plugin marketplace add` / `codex plugin add` を持つCodex CLIが必要です。

```powershell
.\install.ps1 -Locale ja
# 既に D:/BrumeLight/capacity-guard が編集元の場合、コピーせず登録:
.\install.ps1 -Locale ja -TargetRoot D:/BrumeLight
```

```bash
./install.sh --locale en
# 既存の <parent>/capacity-guard をそのまま登録:
./install.sh --locale en --target-root <parent>
```

既定の配置先はユーザーホームの `plugins/capacity-guard`。別の配置先に既存内容があれば、従来どおりバックアップへ移してコピーします。同じ編集元を使う場合はその親を指定してください。配置したplugin内の `.agents/plugins/marketplace.json` から `./` を参照し、そのディレクトリをpersonal marketplaceとして登録してからpluginを追加・更新します。別のpersonal marketplaceが既に登録されている場合はCLIが登録を拒否するため、その配置を確認してから統合してください。既存登録を自動削除しません。インストール済みpluginを先に削除しません。

現在実行中のtaskは停止・再起動しません。古いtaskが読み込んだ指示や旧hook登録の自動更新は保証しません。新しいplugin metadataが読み込まれた新規taskで利用してください。必要なら、稼働中作業を安全に終えてから利用者がアプリを再起動してください。

## 検証

```text
node --check scripts/capacity-guard-hook.mjs
node scripts/test-capacity-guard.mjs
```

自動検証はhook登録がないこと、旧入口がOFF・旧ARMED/TRIPPED・破損状態・ロック競合・監査書込不能・不正入力でも干渉しないことを確認します。promptの意味や実Agentの安全停止を証明するテストではありません。

実際の利用手順の正本は [SKILL.md](skills/capacity-guard/SKILL.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) です。
