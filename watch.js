/* watch.js — engine.js / template.html を保存したら politisaber.html を自動再生成。
   依存パッケージなし。Ctrl+C で終了。

     node watch.js

   ディレクトリ単位で監視している理由:
   多くのエディタは保存時に「一時ファイルへ書いて rename」するため、
   ファイルを直接 fs.watch すると監視対象の inode が入れ替わり、
   2回目以降のイベントが飛ばなくなる。ディレクトリを見てファイル名で
   絞れば、この保存方式でも取りこぼさない。                          */
const fs   = require('fs');
const path = require('path');
const { build, DIR, ENGINE, TEMPLATE, OUTPUT } = require('./build.js');

const WATCHED = [ENGINE, TEMPLATE].map(p => path.basename(p));
const DEBOUNCE_MS = 150;   // 保存1回で複数イベントが飛ぶのをまとめる

const stamp = () => new Date().toLocaleTimeString('ja-JP', { hour12:false });
const ok    = s => console.log(`\x1b[32m✓\x1b[0m ${stamp()}  ${s}`);
const ng    = s => console.log(`\x1b[31m✗\x1b[0m ${stamp()}  ${s}`);
const info  = s => console.log(`\x1b[90m·\x1b[0m ${stamp()}  ${s}`);

let timer = null;
let lastSig = '';

function signature(){
  // 内容ハッシュ代わりに mtime+サイズ。無変更の再保存で走らないようにする。
  return [ENGINE, TEMPLATE].map(p => {
    try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; }
    catch { return 'x'; }
  }).join('|');
}

function rebuild(reason){
  const sig = signature();
  if (sig === lastSig) return;          // 実体が変わっていなければ無視
  lastSig = sig;
  try {
    const r = build();
    ok(`${reason} → politisaber.html を再生成 (${r.totalLines} 行 / ${(r.bytes/1024).toFixed(1)} KB)`);
  } catch (e){
    ng(`${reason} → ビルド失敗`);
    console.log(`   \x1b[31m${e.message}\x1b[0m`);
    console.log('   \x1b[90m出力ファイルは前回の内容のまま残しています\x1b[0m');
  }
}

const schedule = reason => {
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(reason), DEBOUNCE_MS);
};

console.log('');
console.log('\x1b[1mPolitiSABER watch\x1b[0m');
console.log(`\x1b[90m監視: ${WATCHED.join(' , ')}\x1b[0m`);
console.log(`\x1b[90m出力: ${path.basename(OUTPUT)}   (Ctrl+C で終了)\x1b[0m`);
console.log('');
rebuild('起動時ビルド');

let watcher;
function startWatching(){
  watcher = fs.watch(DIR, (event, filename) => {
    if (!filename) return;
    const base = path.basename(filename);
    if (!WATCHED.includes(base)) return;
    schedule(`${base} を検知`);
  });
  watcher.on('error', err => {
    ng(`監視エラー: ${err.message} — 1秒後に再接続します`);
    try { watcher.close(); } catch {}
    setTimeout(startWatching, 1000);
  });
}
startWatching();
info('待機中。engine.js か template.html を保存すると再生成します。');

process.on('SIGINT', () => {
  console.log('');
  info('監視を終了しました。');
  try { watcher.close(); } catch {}
  process.exit(0);
});
