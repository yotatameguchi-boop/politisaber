/* sources/index.js — 取り込みアダプタ。

   出所ごとにページ構造が違うので、「正規形の観測配列を返す」という
   一点だけを契約にして、中身は各アダプタに閉じ込める。

     async fetchObservations(race, opts) -> Observation[]

   ★スクレイパを同梱していない理由:
     都道府県選管のページ構造を実物で確認せずに書いたスクレイパは、
     動いているように見えて静かに誤った数字を入れる。このプロジェクトが
     一番避けたい失敗（出所不明のデータが混入する）そのもの。
     実際のページを見てから書く前提で、雛形と検証だけ用意してある。

   いま使えるのは manual（CSV/JSON の手入力）で、これだけでも
   1レースの開票当日は回せる。                                    */
const fs   = require('fs');
const path = require('path');

/* ---------- manual: CSV / JSON からの取り込み ----------
   CSV の形式（1行目はヘッダ、候補者名を列に）:
     municipality,玉城デニー,古謝玄太,下地幹郎,counted
     那覇市,52310,41200,6100,true
     宜野湾市,18900,17500,2300,true

   counted 列は省略可（省略時 true）。                          */
/* 引用符を尊重して1行を列に割る。
   ★表計算ソフトが書き出す CSV は桁区切りを "1,234" と囲むため、
     素朴な split(',') では列がずれる。実際にテストで露見した。
     RFC4180 の範囲（"" によるエスケープ）まで対応する。          */
function splitCsvLine(line){
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++){
    const ch = line[i];
    if (inQ){
      if (ch === '"'){
        if (line[i+1] === '"'){ cur += '"'; i++; }   // "" はリテラルの "
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"'){
      inQ = true;
    } else if (ch === ','){
      out.push(cur.trim()); cur = '';
    } else cur += ch;
  }
  if (inQ) throw new Error('引用符が閉じていません');
  out.push(cur.trim());
  return out;
}

function parseCsv(text, race, source){
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) throw new Error('CSV に行がありません（ヘッダ＋1行以上が必要）');

  const header = splitCsvLine(lines[0]);
  if (header[0] !== 'municipality'){
    throw new Error(`CSV の1列目は municipality である必要があります（実際: "${header[0]}"）`);
  }
  const hasCounted = header[header.length-1] === 'counted';
  const candCols = header.slice(1, hasCounted ? -1 : undefined);

  // 候補者名がレース定義と一致するか。ここで弾かないと黙って 0 票になる。
  const missing = race.candidates.filter(c => !candCols.includes(c));
  const extra   = candCols.filter(c => !race.candidates.includes(c));
  if (missing.length || extra.length){
    throw new Error(
      'CSV の候補者列がレース定義と一致しません。' +
      (missing.length ? ` 不足: ${missing.join(', ')}.` : '') +
      (extra.length   ? ` 余分: ${extra.join(', ')}.`   : '') +
      ` 期待: ${race.candidates.join(', ')}`);
  }

  const knownMuni = new Set(race.municipalities.map(m => m.name));
  const out = [];
  for (let i = 1; i < lines.length; i++){
    const cells = splitCsvLine(lines[i]);
    if (cells.length !== header.length){
      throw new Error(`${i+1}行目: 列数が ${cells.length} でヘッダ(${header.length})と違います`);
    }
    const municipality = cells[0];
    if (!knownMuni.has(municipality)){
      throw new Error(`${i+1}行目: "${municipality}" はレース定義に無い自治体です`);
    }
    const votes = {};
    candCols.forEach((c,j) => {
      const raw = cells[1+j].replace(/[,，\s]/g, '');
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${i+1}行目 ${c}: "${cells[1+j]}" が非負整数ではありません`);
      votes[c] = n;
    });
    const counted = hasCounted ? /^(true|1|yes|済|確定)$/i.test(cells[cells.length-1]) : true;
    out.push({ raceId: race.raceId, municipality, votes, counted, source });
  }
  return out;
}

const manual = {
  name: 'manual',
  /* opts: { file } — .csv か .json */
  async fetchObservations(race, opts = {}){
    if (!opts.file) throw new Error('manual アダプタには file が必要です');
    const p = path.resolve(opts.file);
    if (!fs.existsSync(p)) throw new Error(`ファイルがありません: ${p}`);
    const text = fs.readFileSync(p, 'utf8');
    const src = `manual:${path.basename(p)}`;

    if (p.endsWith('.json')){
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : j.observations;
      if (!Array.isArray(arr)) throw new Error('JSON は配列か {observations:[...]} である必要があります');
      return arr.map(o => ({ ...o, raceId: race.raceId, source: o.source ?? src }));
    }
    return parseCsv(text, race, src);
  },
};

/* ---------- スクレイパの雛形 ----------
   実物のページを見てから parse を埋めること。
   埋めるまでは呼ばれたら明示的に落ちる（黙って空配列を返さない）。  */
function makeScraper(name, url, parse){
  return {
    name,
    async fetchObservations(race, opts = {}){
      if (typeof parse !== 'function'){
        throw new Error(`${name}: parse が未実装です。実際のページ構造を確認してから書いてください`);
      }
      const res = await fetch(typeof url === 'function' ? url(race) : url, {
        headers: { 'User-Agent': 'politisaber/1.0 (personal research)' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const obs = parse(await res.text(), race);
      if (!Array.isArray(obs)) throw new Error(`${name}: parse が配列を返しませんでした`);
      return obs.map(o => ({ ...o, raceId: race.raceId, source: o.source ?? name }));
    },
  };
}

const { senkanPdf } = require('./senkan-pdf.js');

const REGISTRY = { manual, 'senkan-pdf': senkanPdf };

function get(name){
  const a = REGISTRY[name];
  if (!a) throw new Error(`未知のソース: ${name}（利用可能: ${Object.keys(REGISTRY).join(', ')}）`);
  return a;
}

module.exports = { get, manual, senkanPdf, makeScraper, parseCsv, splitCsvLine, REGISTRY };
