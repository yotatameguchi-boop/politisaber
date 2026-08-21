/* store.js — 開票途中経過の追記専用ストア。

   このプロジェクトで最初に見つかった問題は「予測欄に結果が入っていた」
   ことだった。開票速報は同じ事故がもっと起きやすい:
   途中経過は何度も更新されるので、素直に実装すると上書きの連続になり、
   「何時の時点で何が分かっていたか」が失われる。

   なので観測は JSONL に追記だけする。更新も削除もしない。
   同じ自治体の値が変わったら「新しい観測」として積む。
   これで
     ・任意の時刻断面を再構成できる（後から検証できる）
     ・数字が動いた履歴が残る（訂正報道も追える）
     ・書き換えによる捏造ができない
   という性質が手に入る。

   ファイルは data/<raceId>.jsonl。1行1観測。               */
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/* ---------- 観測の正規形 ----------
   どのソース（選管サイト・報道・手入力）から来ても、この形に揃える。
     raceId       … レース識別子
     municipality … 自治体名（レース内で一意）
     votes        … { 候補者名: 得票数 }
     counted      … その自治体で開票が完了したか
     reportedAt   … ソース側の時刻（分かれば）
     observedAt   … こちらが取得した時刻
     source       … 出所の識別子
*/
function validateObservation(o){
  const errs = [];
  if (!o || typeof o !== 'object') return ['観測がオブジェクトではありません'];
  if (!o.raceId)       errs.push('raceId がありません');
  if (!o.municipality) errs.push('municipality がありません');
  if (!o.source)       errs.push('source がありません');
  if (!o.votes || typeof o.votes !== 'object') errs.push('votes がありません');
  else {
    for (const [k,v] of Object.entries(o.votes)){
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || !Number.isInteger(v)){
        errs.push(`votes["${k}"] が非負整数ではありません: ${v}`);
      }
    }
    if (!Object.keys(o.votes).length) errs.push('votes が空です');
  }
  if (o.counted != null && typeof o.counted !== 'boolean') errs.push('counted が真偽値ではありません');
  return errs;
}

const fileFor = raceId => path.join(DATA_DIR, `${raceId}.jsonl`);

/* 追記。戻り値は書き込んだレコード。 */
function append(observation){
  const errs = validateObservation(observation);
  if (errs.length) throw new Error('不正な観測: ' + errs.join(' / '));

  const rec = {
    ...observation,
    counted: observation.counted ?? true,
    observedAt: observation.observedAt ?? new Date().toISOString(),
  };
  fs.mkdirSync(DATA_DIR, { recursive:true });
  fs.appendFileSync(fileFor(rec.raceId), JSON.stringify(rec) + '\n');
  return rec;
}

/* まとめて追記。1件でも不正なら何も書かない（全か無か）。 */
function appendAll(observations){
  const bad = observations
    .map((o,i) => ({ i, errs: validateObservation(o) }))
    .filter(x => x.errs.length);
  if (bad.length){
    throw new Error(`${bad.length}件が不正です: ` +
      bad.slice(0,3).map(b => `[${b.i}] ${b.errs.join(',')}`).join(' / '));
  }
  return observations.map(append);
}

/* 全観測を時系列で読む。 */
function readAll(raceId){
  const f = fileFor(raceId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8')
    .split('\n').filter(Boolean)
    .map((l,i) => {
      try { return JSON.parse(l); }
      catch { throw new Error(`${path.basename(f)} の ${i+1}行目が壊れています`); }
    });
}

/* ---------- 時刻断面 ----------
   「asOf 時点で分かっていたこと」を再構成する。
   同じ自治体に複数の観測があれば、その時刻以前で最も新しいものを採用。
   asOf を省略すると最新断面。                                   */
function snapshotAt(raceId, asOf){
  const cutoff = asOf ? new Date(asOf).getTime() : Infinity;
  const latest = new Map();
  for (const o of readAll(raceId)){
    const t = new Date(o.observedAt).getTime();
    if (t > cutoff) continue;
    const prev = latest.get(o.municipality);
    if (!prev || new Date(prev.observedAt).getTime() <= t) latest.set(o.municipality, o);
  }
  return [...latest.values()].sort((a,b) => a.municipality < b.municipality ? -1 : 1);
}

/* 観測が入った時刻の一覧（再現・巻き戻し用） */
function timeline(raceId){
  return [...new Set(readAll(raceId).map(o => o.observedAt))].sort();
}

module.exports = { DATA_DIR, fileFor, validateObservation, append, appendAll, readAll, snapshotAt, timeline };
