/* backtest.js — 係数の推定と、モデルの成績計測。
     node backtest.js

   ★ HISTORY にレースを足すほど、推定される σ・投票率バイアス・較正が
     正確になる。47都道府県 × 直近数サイクルで150〜200件を目標に。
     いまは5件しかなく、ここで出る数字は「機構が動いている」以上の
     意味を持たない。                                                   */
const E = require('./engine.js');
const fs = require('fs');
const path = require('path');

/* ---------------- 過去レースの読み込み ----------------
   ★データの実体は template.html の RACES ひとつだけ。
     以前ここに HISTORY をベタ書きしていたが、レース結果を追記しても
     backtest だけ古いままになる事故が実際に起きた。
     ビルド済み HTML から読むことで、ページと成績が必ず一致する。     */
function loadHistory(){
  const built = path.join(__dirname, 'politisaber.html');
  if (!fs.existsSync(built)) throw new Error('politisaber.html がありません。先に node build.js');
  const script = fs.readFileSync(built, 'utf8').split('<script>')[1].split('</scr' + 'ipt>')[0];
  const cut = script.indexOf('/* ---------- ボード ---------- */');
  if (cut < 0) throw new Error('politisaber.html の構造が想定と違います');
  return new Function(script.slice(0, cut) + '\nreturn {HISTORY, RACES};')();
}

const LOADED = loadHistory();
const HISTORY = LOADED.HISTORY;

/* 参考: 以前ベタ書きしていた形（フィールドの意味の記録として残す）
   fieldConfirmed … 予測時点で候補者名簿を確認できていたか。不明なら false。
const _SCHEMA_EXAMPLE = [
  {
    name:'長崎県知事選', date:'2026-02-08', type:'保守分裂',
    fieldConfirmed:false,          // 上位2名のみ掲載＝名簿を網羅していない
    predTotal:662701, actTotal:617087, winnerName:'平田研', predTopName:'平田研',
    winProb:null,                  // ★当時は勝率を記録していなかった
    cands:[
      {name:'平田研',   incumbent:false, predicted:53.5, actual:48.3, splitGroup:'保守'},
      {name:'大石賢吾', incumbent:true,  predicted:41.4, actual:47.2, splitGroup:'保守'},
      {name:'(掲載外の候補)', incumbent:false, predicted:null, actual:4.5},
    ],
  },
  {
    name:'石川県知事選', date:'2026-03-08', type:'保守分裂',
    fieldConfirmed:false,
    predTotal:523601, actTotal:394442, winnerName:'山野之義', predTopName:'山野之義',
    winProb:null,
    cands:[
      {name:'山野之義', incumbent:false, predicted:52.1, actual:49.8, splitGroup:'保守'},
      {name:'馳浩',     incumbent:true,  predicted:42.9, actual:47.8, splitGroup:'保守'},
      {name:'(掲載外の候補)', incumbent:false, predicted:null, actual:2.4},
    ],
  },
  {
    name:'大阪府知事選', date:'2026-02-08', type:'現職安泰',
    fieldConfirmed:true,           // 2人レースで名簿を網羅できていた
    predTotal:3620000, actTotal:3620800, winnerName:'吉村洋文', predTopName:'吉村洋文',
    winProb:null,
    cands:[
      {name:'吉村洋文', incumbent:true,  predicted:80.6, actual:83.2},
      {name:'大西恒樹', incumbent:false, predicted:19.4, actual:16.8},
    ],
  },
  {
    name:'京都府知事選', date:'2026-04-05', type:'現職安泰',
    fieldConfirmed:false,          // 網羅したつもりで第3候補を見落としていた＝false が正しい
    predTotal:844000, actTotal:743861, winnerName:'西脇隆俊', predTopName:'西脇隆俊',
    winProb:null,
    note:'第3候補(藤井20.07%)を予測対象にしていなかった。誤差の主因は統計ではなく候補者名簿。',
    cands:[
      {name:'西脇隆俊', incumbent:true,  predicted:62.5, actual:55.46},
      {name:'濱田聡',   incumbent:false, predicted:37.5, actual:24.47},
      {name:'藤井伸生', incumbent:false, predicted:null, actual:20.07},
    ],
  },
  {
    name:'福井県知事選', date:'2026-01-25', type:'空席',
    fieldConfirmed:false,
    predTotal:318000, actTotal:280645, winnerName:'石田嵩人', predTopName:'山田賢一',
    winProb:0.537, winProbOn:'山田賢一',   // 山田を53.7%で優位に置いた → 外れ
    cands:[
      {name:'石田嵩人', incumbent:false, predicted:49.8, actual:47.97},
      {name:'山田賢一', incumbent:false, predicted:50.2, actual:46.43},
      {name:'金元幸枝', incumbent:false, predicted:null, actual:5.61},
    ],
  },
];
*/

const P = E.fitParams(HISTORY);

const pct  = (v,d=2) => v == null ? '—' : v.toFixed(d);
const sgn  = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
const line = s => console.log(s);
const rule = () => line('─'.repeat(72));

line('');
line('╔══════════════════════════════════════════════════════════════════════╗');
line('║  PolitiSABER backtest — 係数推定とモデル成績                          ║');
line('╚══════════════════════════════════════════════════════════════════════╝');
line(`対象: ${HISTORY.length} レース（事前予測を記録したもののみ）`);
line('');

/* ---------------- 1. 投票総数 ---------------- */
rule(); line('1. 投票総数の想定バイアス'); rule();
for (const h of HISTORY){
  line(`  ${h.name}  想定 ${h.predTotal.toLocaleString()} → 実際 ${h.actTotal.toLocaleString()}  ${sgn((h.predTotal/h.actTotal-1)*100)}%`);
}
line('');
line(`  推定バイアス補正係数 : ×${P.turnout.biasCorrection.toFixed(4)}  (想定値をこの倍率で縮める)`);
line(`  対数残差の標準偏差   : ${P.turnout.sigmaLog.toFixed(4)}  → 概ね ±${((Math.exp(P.turnout.sigmaLog)-1)*100).toFixed(1)}% (1σ)`);
line(`  n = ${P.turnout.n ?? 0}`);
line(`  ※ betaCompetitiveness は未推定(0)。前回投票率を data に持たせて初めて推定できる。`);
line('');

/* ---------------- 2. 得票率のσ ---------------- */
rule(); line('2. 得票率の残差から推定した σ (pt)'); rule();
line('  ※ 残差は「モデルに載せた候補だけで正規化し直して」から算出。');
line('     未モデル化候補の取りこぼしは下の other 成分が担当するため、二重計上を避ける。');
line('');
line(`  プール全体 : ${P.share.pooledSdPt.toFixed(2)}pt  (n=${P.share.n})`);
for (const [t,v] of Object.entries(P.share.byType)){
  line(`  ${t.padEnd(6,'　')} : ${v.toFixed(2)}pt  (プールへ縮小済み, k=${P.share.shrinkK})`);
}
line('');

/* ---------------- 2b. その他成分 ---------------- */
rule(); line('2b. 未モデル化候補（その他成分）'); rule();
line('  予測に載せていなかった候補が実際に取った得票率:');
for (const h of HISTORY){
  const un = h.cands.filter(c => c.predicted == null && c.actual != null);
  const m = un.reduce((s,c) => s + c.actual, 0);
  line(`    ${h.name}  ${m.toFixed(2)}%${un.length ? '  (' + un.map(c=>c.name).join(', ') + ')' : ''}`);
}
line('');
line('  ※ 零過剰の混合分布として推定（対数正規1本では中央値が下がりすぎ、');
line('     20%規模の候補が裾に収まらなかった）。');
line('');
line(`  出現確率(告示前)     : ${(P.other.presenceUnconfirmed*100).toFixed(0)}%  (${P.other.nPresent}/${P.other.n})`);
line(`  出現した場合の中央値 : ${(P.other.medianGivenPresent*100).toFixed(2)}%`);
line(`  対数σ                : ${P.other.sigmaLog.toFixed(2)}`);
line(`  出現確率(告示後)     : ${(P.other.presenceConfirmed*100).toFixed(0)}%  ← 名簿が確定するため`);
line('');

/* ---------------- 3. 現職バイアス ---------------- */
rule(); line('3. 現職バイアス（適用は保留）'); rule();
const ib = P.structural.incumbency;
line(`  現職の平均誤差 : ${sgn(ib.biasPt)}pt  (n=${ib.n})`);
line(`  有効化         : ${ib.enabled ? 'ON' : `OFF（n < ${ib.minN} のため。過学習を避ける）`}`);
line('');

/* ---------------- 4. 成績とベースライン ---------------- */
rule(); line('4. 当選者予測の成績とベースライン比較'); rule();
const model = E.scoreStrategy(HISTORY, h => h.predTopName);
const bInc  = E.scoreStrategy(HISTORY, E.BASELINES.alwaysIncumbent);
const bPri  = E.scoreStrategy(HISTORY, E.BASELINES.alwaysPriorTop);
line(`  モデル                 : ${model.hit}/${model.n}  ${pct(model.rate,1)}%`);
line(`  ベースライン「常に現職」: ${bInc.hit}/${bInc.n}  ${pct(bInc.rate,1)}%`);
line(`  ベースライン「前回首位」: ${bPri.n ? `${bPri.hit}/${bPri.n}  ${pct(bPri.rate,1)}%` : '測定不能（前回得票率が data にない）'}`);
line('');
line(`  スキル差（対 常に現職）: ${(bInc.rate!=null&&model.rate!=null) ? sgn(model.rate-bInc.rate)+'pt' : '—'}`);
line('');

/* ---------------- 5. 確率予測としてのスコア ---------------- */
rule(); line('5. 確率予測としてのスコア'); rule();
const scored = HISTORY.filter(h => h.winProb != null);
if (!scored.length) line('  記録された勝率がないため測定不能。');
else {
  let bs = 0;
  for (const h of scored){
    const outcome = h.winProbOn === h.winnerName;
    const b = E.brier(h.winProb, outcome);
    bs += b;
    line(`  ${h.name}  勝率${(h.winProb*100).toFixed(1)}%(${h.winProbOn}) → ${outcome?'的中':'外れ'}  Brier=${b.toFixed(3)}  logLoss=${E.logLoss(h.winProb,outcome).toFixed(3)}`);
  }
  line('');
  line(`  平均 Brier : ${(bs/scored.length).toFixed(3)}`);
  line('  参考       : コイン投げ(50%)は常に 0.250 ／ 100%断言して外すと 1.000');
  line('  → 0.250 を大きく下回れないうちは「情報があった」とは言えない。');
}
line(`  ★ 勝率を記録しているのは ${scored.length}/${HISTORY.length} レースのみ。`);
line('     全レースで勝率を残さないと、この指標は永久に育たない（snapshot.js）。');
line('');

/* ---------------- 6. 交差検証（これが本当の成績） ---------------- */
rule(); line('6. 交差検証 — 係数を推定したのと別のデータで測る'); rule();
line('  ★上の 1〜5 はすべて in-sample（自己採点）。必ず甘く出る。');
line('   ここでは伏せたレースを予測し直して、外から測る。');
line('');

const loo = E.crossValidate(HISTORY, { mode:'loo' });
const wf  = E.crossValidate(HISTORY, { mode:'walkforward' });

for (const [label, cv] of [['Leave-One-Out', loo], ['Walk-Forward（実運用と同条件）', wf]]){
  line(`  ── ${label} ──`);
  if (!cv.n){ line('    学習に使えるレースが足りず測定不能。'); line(''); continue; }
  line(`    ${'レース'.padEnd(8,'　')} ${'学習数'.padStart(6)} ${'σ'.padStart(7)}  ${'当選者'.padStart(6)}  区間に入った候補`);
  for (const f of cv.folds){
    const ins = f.candidates.filter(c => c.inside).length;
    line(`    ${f.race.replace(/[府県]知事選/,'').padEnd(8,'　')} ${String(f.trainN).padStart(6)} ${f.sdPt.toFixed(2).padStart(7)}  ${(f.hit?'的中':'不的中').padStart(6)}  ${ins}/${f.candidates.length}`);
  }
  line('');
  line(`    当選者的中     : ${cv.hits}/${cv.n}  (${(cv.hitRate*100).toFixed(1)}%)`);
  line(`    90%区間の被覆率: ${(cv.coverage*100).toFixed(0)}%  (${Math.round(cv.coverage*cv.coverageN)}/${cv.coverageN})  ← 90% であるべき`);
  line(`    平均 Brier     : ${cv.brier.toFixed(3)}  (コイン投げ=0.250)`);
  line(`    σ の振れ幅     : ${cv.sdRange[0].toFixed(2)} – ${cv.sdRange[1].toFixed(2)}pt`);
  line('');
}
line(`  ★ σ は「${loo.sdRange[0].toFixed(1)}〜${loo.sdRange[1].toFixed(1)}pt」と幅で書くべきで、`);
line(`     ${P.share.pooledSdPt.toFixed(2)}pt という一点の値は確定値ではない。`);
line('');
rule();
line('注意: 上の係数はすべて n=5 から推定したもの。確定値として扱わないこと。');
line('      HISTORY に過去レースを足すたび、この出力は自動的に更新される。');
rule();
line('');

module.exports = { HISTORY, P };
