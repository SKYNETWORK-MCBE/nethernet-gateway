# リリース方法

- `package.json` の `version` を更新する
- コミットする
- タグを作成する
  - `git tag v<version>`
- version更新分のコミットとタグを一緒にpushする
  - `git push origin main --tags`
  - `git push origin <ブランチ名> --tags`
