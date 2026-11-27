# リリース方法

- `package.json` の `version` を更新する
- コミットする
- タグを作成する
  - `git tag v<version>`
- version更新分のコミットとタグを一緒にpushする
  - `git push origin main --tags`
  - `git push origin <ブランチ名> --tags`

## プレリリース

- `version` を `<version>-beta`（例: `1.2.0-beta`、`1.2.0-beta.1`）にして、同じ手順で `v<version>-beta` のタグをpushする
- GitHub Releaseはprereleaseとして作られ、npmには `latest` ではなく `beta` タグで公開される
  - `-` の後ろの最初の識別子がnpmのタグになる（`-rc.1` なら `rc`）
