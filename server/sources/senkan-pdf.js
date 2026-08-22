/* senkan-pdf.js — 選管の開票速報PDFから直接取り込むアダプタ。

   開票当日、選管は同じ書式のPDFを繰り返し差し替えて公開する。
   前回選挙の確定版で検証済みのパーサ（tools/parse_senkan_pdf.py）が
   そのまま使えるので、「未知のHTMLを推測して書く」種類のスクレイパとは
   риск の性質が違う。だからこれは同梱してよいと判断した。

   Python を呼び出しているのは README に書いた分担どおり:
     オフラインのデータ抽出 → Python
     予測モデル → JS（ブラウザとサーバで共有）
   PDF の CID 復号を JS へ移植すると、検証済みの実装が2つになる。

   ★必ず expect（公表されている全県計）を渡すこと。
     開票途中は全県計が変動するので、確定後の突き合わせにしか使えないが、
     渡せる場面では必ず渡す。渡さない場合は下の sanity check だけが頼りになる。 */
const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const TOOL = path.join(__dirname, '..', '..', 'tools', 'parse_senkan_pdf.py');

function runParser(pdfPath, candidates, opts = {}){
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(TOOL)) return reject(new Error(`パーサがありません: ${TOOL}`));
    const args = [TOOL, pdfPath, '--candidates', ...candidates];
    if (opts.expect) args.push('--expect', ...opts.expect.map(String));
    if (opts.maxSeq) args.push('--max-seq', String(opts.maxSeq));
    execFile(opts.python ?? 'python3', args, { maxBuffer: 20e6 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`PDF パースに失敗: ${(stderr || err.message).trim()}`));
      try { resolve({ rows: JSON.parse(stdout), log: stderr.trim() }); }
      catch { reject(new Error(`パーサの出力が JSON ではありません: ${stdout.slice(0,200)}`)); }
    });
  });
}

/* PDF の候補者列の並びは、レース定義の candidates と一致しないことがある
   （選管PDFは届出順、レース定義は任意の順）。対応表で吸収する。
     race.pdf = { columns:[PDF列順の名前], map:{PDF名: レース定義名}, url, maxSeq, expect } */
function resolveColumns(race){
  const cfg = race.pdf ?? {};
  const columns = cfg.columns ?? race.candidates;
  const map = cfg.map ?? {};
  const toRace = n => map[n] ?? n;
  const unknown = columns.map(toRace).filter(n => !race.candidates.includes(n));
  if (unknown.length){
    throw new Error(`PDF の列がレース定義の候補者に対応しません: ${unknown.join(', ')}。` +
                    `race.pdf.map で対応を書いてください。期待: ${race.candidates.join(', ')}`);
  }
  return { columns, toRace, cfg };
}

const senkanPdf = {
  name: 'senkan-pdf',
  /* opts: { file } でローカルPDF、または { url } で取得。
     race.pdf.url があれば opts 省略時にそれを使う。                */
  async fetchObservations(race, opts = {}){
    const { columns, toRace, cfg } = resolveColumns(race);

    let pdfPath = opts.file ?? null;
    let tmp = null;
    if (!pdfPath){
      const url = opts.url ?? cfg.url;
      if (!url) throw new Error('senkan-pdf には file か url が必要です（race.pdf.url でも可）');
      const res = await fetch(url, {
        headers: { 'User-Agent': 'politisaber/1.0 (personal research)' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
      if (!res.ok) throw new Error(`senkan-pdf: HTTP ${res.status} — ${url}`);
      tmp = path.join(os.tmpdir(), `senkan-${Date.now()}.pdf`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      pdfPath = tmp;
    }

    try {
      const { rows } = await runParser(pdfPath, columns, {
        expect: opts.expect ?? cfg.expect,
        maxSeq: opts.maxSeq ?? cfg.maxSeq ?? race.municipalities.length,
        python: opts.python,
      });

      const known = new Set(race.municipalities.map(m => m.name));
      const unknown = rows.map(r => r.name).filter(n => !known.has(n));
      if (unknown.length){
        throw new Error(`レース定義に無い自治体が含まれます: ${[...new Set(unknown)].join(', ')}`);
      }
      // 開票中は 0 票の自治体が並ぶ。まだ開いていないものとして落とす。
      return rows
        .filter(r => r.valid > 0)
        .map(r => {
          const votes = {};
          for (const [col, n] of Object.entries(r.votes)) votes[toRace(col)] = n;
          return { raceId: race.raceId, municipality: r.name, votes,
                   counted: true, source: 'senkan-pdf' };
        });
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    }
  },
};

module.exports = { senkanPdf, runParser, resolveColumns, TOOL };
