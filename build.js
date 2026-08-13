/* build.js — engine.js を template.html のプレースホルダへ差し込んで
   単一ファイルの politisaber.html を生成する。
   エンジンの実体は engine.js ひとつだけ（HTML と各スクリプトが共有）。

     node build.js      … 1回だけビルド
     node watch.js      … 保存を監視して自動ビルド
   他のスクリプトからは require('./build.js').build() で呼べる。      */
const fs   = require('fs');
const path = require('path');

const DIR      = __dirname;
const ENGINE   = path.join(DIR, 'engine.js');
const TEMPLATE = path.join(DIR, 'template.html');
const OUTPUT   = path.join(DIR, 'politisaber.html');

const PLACEHOLDER = '/*__ENGINE__*/';
const MARKERS = /\/\* ===== ENGINE:BEGIN[\s\S]*?\/\* ===== ENGINE:END[^\n]*\n/;

function build(){
  const engine = fs.readFileSync(ENGINE, 'utf8');
  const m = engine.match(MARKERS);
  if (!m) throw new Error('engine.js に ENGINE:BEGIN / ENGINE:END マーカーが見つかりません');

  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  if (!tpl.includes(PLACEHOLDER)) throw new Error(`template.html に ${PLACEHOLDER} がありません`);

  const out = tpl.replace(PLACEHOLDER, m[0].trimEnd());

  /* --- 出力前の検証 --------------------------------------------------
     new Function() はコンパイルするだけで実行しないので、DOM なしで
     構文エラーだけを捕まえられる。壊れた編集がブラウザに届く前に止まり、
     出力ファイルは前回の内容のまま保護される。                      */
  const parts = out.split('<script>');
  if (parts.length !== 2) throw new Error(`<script> ブロックが ${parts.length-1} 個あります（1個であるべき）`);
  const js = parts[1].split('</scr' + 'ipt>')[0];
  try { new Function(js); }
  catch (e){ throw new Error(`埋め込み JS の構文エラー: ${e.message}`); }

  if (out.includes(PLACEHOLDER)) throw new Error('プレースホルダが残っています');

  fs.writeFileSync(OUTPUT, out);
  return {
    engineLines: m[0].split('\n').length,
    totalLines:  out.split('\n').length,
    bytes:       Buffer.byteLength(out),
  };
}

if (require.main === module){
  try {
    const r = build();
    console.log(`built politisaber.html  (engine ${r.engineLines} 行 / 合計 ${r.totalLines} 行 / ${(r.bytes/1024).toFixed(1)} KB)`);
  } catch (e){
    console.error('ビルド失敗: ' + e.message);
    process.exit(1);
  }
}

module.exports = { build, DIR, ENGINE, TEMPLATE, OUTPUT };
