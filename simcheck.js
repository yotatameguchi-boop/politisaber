/* simcheck.js — 開票速報モデルの検証。
     node simcheck.js
     REPS=200 PARTICLES=3000 node simcheck.js

   実データが無くてもアルゴリズムの正しさは確かめられる。
   「正解が分かっている世界」を大量に作り、そこで推定器を走らせて
     (1) 90%区間が本当に90%の頻度で真値を含むか（較正）
     (2) 素朴な按分より正確か
     (3) 開票が進むにつれて不確実性が縮むか
   を測る。ここで落ちるならモデルが間違っている。

   ★被覆率は試行回数を確保しないと読めない。n=40 では標準誤差が 4.7pt あり、
     実際に n=40 で 73〜75% と出たものが n=200 では 86〜90% だった。
     少ない試行で「較正が壊れている」と判断しないこと。               */
const E  = require('./engine.js');
const LC = require('./livecount.js');

/* ---------- 合成県 ----------
   ★架空のデータ。実在する県の市町村構成ではない。
     アルゴリズムの検証だけが目的で、特定の選挙の予測には使わない。
     実データを入れる場合は同じ形 { name, electorate, priorShares } に置き換える。 */
function makeSyntheticPrefecture(nMuni, rng){
  const municipalities = [];
  for (let i = 0; i < nMuni; i++){
    // 有権者数は対数正規（大都市が少数＋中小多数、という日本的な分布）
    const electorate = Math.round(Math.exp(8.2 + E.randn(rng) * 1.35));
    // 都市度: 大きい自治体ほど都市的。郡部で候補Aが強い、という傾きを作る。
    const urban = 1 / (1 + Math.exp(-(Math.log(electorate) - 9.2)));
    const a = Math.min(Math.max(0.72 - 0.22*urban + E.randn(rng)*0.05, 0.35), 0.92);
    municipalities.push({ name:`M${String(i+1).padStart(2,'0')}`, electorate, priorShares:[a, 1-a] });
  }
  return { name:'合成県', candidates:['候補A','候補B'], baseTurnout:0.55, municipalities };
}

const REPS        = Number(process.env.REPS ?? 100);
const PARTICLES   = Number(process.env.PARTICLES ?? 3000);
const CHECKPOINTS = [0.10, 0.25, 0.50, 0.75, 0.90];

const pref = makeSyntheticPrefecture(77, E.mulberry32(4242));
const agg = CHECKPOINTS.map(() => ({
  inside:0, n:0, errModel:[], errNaive:[], width:[], called:0, calledWrong:0, ess:[],
}));
let flipped = 0;

for (let rep = 0; rep < REPS; rep++){
  const rng = E.mulberry32(1000 + rep);
  const trueSwing = [E.randn(rng)*0.30, E.randn(rng)*0.30];   // 前回からのスイング
  const truth = LC.lcSimulateTruth(pref, { rng, trueSwing, tau:0.12 });

  const grand = truth.reduce((s,m) => s + m.total, 0);
  const finalVotes = [0,0];
  for (const m of truth) for (let i=0;i<2;i++) finalVotes[i] += m.votes[i];
  const finalShare = finalVotes.map(v => v/grand*100);
  const trueWinner = finalShare[0] > finalShare[1] ? '候補A' : '候補B';

  const priorLeader =
    pref.municipalities.reduce((s,m)=>s+m.priorShares[0]*m.electorate,0) /
    pref.municipalities.reduce((s,m)=>s+m.electorate,0) > 0.5 ? '候補A' : '候補B';
  if (trueWinner !== priorLeader) flipped++;

  const order = LC.lcCountingOrder(pref, rng);

  for (let ci = 0; ci < CHECKPOINTS.length; ci++){
    const target = CHECKPOINTS[ci] * grand;
    const reported = []; let counted = 0;
    for (const mi of order){
      if (counted >= target) break;
      reported.push({ index:mi, votes:truth[mi].votes, total:truth[mi].total });
      counted += truth[mi].total;
    }
    if (!reported.length) continue;

    const est   = LC.lcEstimate(pref, reported, { particles:PARTICLES, seed:7000+rep*10+ci });
    const naive = LC.lcNaive(pref, reported);

    const a = agg[ci]; a.n++;
    const c0 = est.candidates[0];
    if (finalShare[0] >= c0.shareCI[0] && finalShare[0] <= c0.shareCI[1]) a.inside++;
    a.errModel.push(Math.abs(c0.share - finalShare[0]));
    a.errNaive.push(Math.abs(naive[0].share - finalShare[0]));
    a.width.push(c0.shareCI[1] - c0.shareCI[0]);
    a.ess.push(est.ess);
    if (est.called){ a.called++; if (est.called !== trueWinner) a.calledWrong++; }
  }
  if ((rep+1) % 25 === 0) console.log(`  ... ${rep+1}/${REPS}`);
}

const m = xs => xs.reduce((a,b)=>a+b,0)/xs.length;
const pad = (s,n) => String(s).padStart(n);

console.log('');
console.log('╔════════════════════════════════════════════════════════════════════════╗');
console.log('║  開票速報モデルの検証（合成データ・正解が分かっている世界で測定）      ║');
console.log('╚════════════════════════════════════════════════════════════════════════╝');
console.log(`  試行 ${REPS} 回 / 粒子 ${PARTICLES} / 自治体 ${pref.municipalities.length}`);
console.log(`  前回基準から勝者が入れ替わった試行: ${flipped}/${REPS}  ← ここが難しいケース`);
console.log(`  被覆率の標準誤差 ≈ ${(Math.sqrt(0.9*0.1/REPS)*100).toFixed(1)}pt`);
console.log('');
console.log('  開票率   90%区間の被覆率   モデル誤差   素朴な按分   改善     区間幅   当確      有効粒子数');
console.log('  ' + '─'.repeat(76));
for (let i = 0; i < CHECKPOINTS.length; i++){
  const a = agg[i]; if (!a.n) continue;
  const em = m(a.errModel), en = m(a.errNaive);
  console.log(`  ${pad((CHECKPOINTS[i]*100).toFixed(0)+'%',5)}   ${pad((a.inside/a.n*100).toFixed(0)+'%',8)}${pad(`(${a.inside}/${a.n})`,10)}   ${pad(em.toFixed(2)+'pt',9)}   ${pad(en.toFixed(2)+'pt',9)}   ${pad((en/em).toFixed(1)+'x',5)}   ${pad(m(a.width).toFixed(1)+'pt',7)}   ${a.called}件${a.calledWrong?` (誤${a.calledWrong})`:''}${pad(Math.round(m(a.ess)),9)}`);
}
console.log('');
console.log('  被覆率は 90% が理想。モデル誤差 < 素朴な按分 なら価値がある。');
console.log('  当確の「誤」は誤報の件数。1件でも出たら callThreshold を上げること。');
console.log('  有効粒子数が粒子数に対して極端に小さいと、重点サンプリングが');
console.log('  枯渇している（2段階サンプリングで対策済み）。');
console.log('');
