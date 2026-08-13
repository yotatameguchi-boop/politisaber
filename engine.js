/* ===== ENGINE:BEGIN =====================================================
   PolitiSABER forecasting engine v2

   設計の中心は「不確実性をどう表すか」。点推定そのものではない。

     1. 得票率を単体(シンプレックス)上でサンプリングする
        → 合計100%が構造的に保証され、候補間の負相関が自動的に入る。
          候補ごとに独立な区間を描くと、区間上限の合計が100%を超える
          「存在しない領域」を示してしまう。
     2. 投票率を独立の確率変数として分離する
        → 得票率の誤差と投票率の誤差が票数の中で混ざらなくなる。
     3. マージン(得票差)と勝率を、同時サンプルから直接数える
        → lo1 - hi2 のような区間の引き算をやめる。

   中心値(center)は構造モデルへ差し替えるためのスロットを用意してあるが、
   係数を推定できるだけの過去データがまだない。
   そこを埋めるのが backtest.js の HISTORY を増やす作業。
   ====================================================================== */

/* ---------------- 乱数：シード固定＝予測が再現できる ---------------- */
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function randn(rng){
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* Marsaglia-Tsang。Dirichlet と t 分布で使う */
function gammaSample(rng, k){
  if (k < 1) return gammaSample(rng, k + 1) * Math.pow(rng(), 1 / k);
  const d = k - 1/3, c = 1 / Math.sqrt(9 * d);
  for (;;){
    let x, v;
    do { x = randn(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/* 標準化した t 分布（単位分散）。
   選挙のサプライズは正規分布より裾が厚い。ν=5 程度の t を使うと
   「中心の幅は変えずに裾だけ厚くする」ことができる。
   t(ν) の分散は ν/(ν-2) なので、それで割って単位分散に直す。
   こうしないと σ の較正が壊れ、分布全体が広がってしまう。

   実測（20万回）: |誤差|>2.5σ の確率は正規 1.25% に対し t(5) 2.34%（1.9倍）、
   3σ で 4.3倍、4σ で52倍。一方 90%区間の端(1.645σ)ではむしろ t の方が狭い。
   つまり効くのは「事故」の領域だけ。                                   */
function randt(rng, nu){
  if (!(nu > 2)) return randn(rng);              // ν≤2 は分散が定義されない
  const z = randn(rng);
  const w = 2 * gammaSample(rng, nu / 2);        // χ²(ν)
  return (z / Math.sqrt(w / nu)) / Math.sqrt(nu / (nu - 2));
}
/* 多変量 t 用のスケール。1シミュレーションにつき1個引いて全成分で共有する
   （成分ごとに独立な t を引くと相関構造が壊れる）。                  */
function mvtScale(rng, nu){
  if (!(nu > 2)) return 1;
  const w = 2 * gammaSample(rng, nu / 2);
  return Math.sqrt(nu / w) / Math.sqrt(nu / (nu - 2));
}

/* ---------------- 線形代数・要約統計 ---------------- */
function cholesky(A){
  const n = A.length, L = Array.from({length:n}, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++){
    for (let j = 0; j <= i; j++){
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][j] = Math.sqrt(Math.max(s, 1e-12));
      else         L[i][j] = s / (L[j][j] || 1e-12);
    }
  }
  return L;
}
const mean = xs => xs.reduce((a,b) => a + b, 0) / xs.length;
function sdSample(xs, m){                       // 標本標準偏差 (n-1)
  if (xs.length < 2) return 0;
  const mu = m ?? mean(xs);
  return Math.sqrt(xs.reduce((s,x) => s + (x - mu) ** 2, 0) / (xs.length - 1));
}
const rmse = xs => Math.sqrt(xs.reduce((s,x) => s + x * x, 0) / xs.length);
function quantile(sorted, q){
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function softmax(z){
  const mx = Math.max(...z);
  const e = z.map(v => Math.exp(v - mx));
  const s = e.reduce((a,b) => a + b, 0);
  return e.map(v => v / s);
}

/* ---------------- 既定パラメータ ----------------
   すべて「どこから来た数字か」を明記する。推定できていないものは
   0 を置くか無効化し、データが揃うまで有効にしない。               */
const DEFAULT_PARAMS = {
  sampler: 'logisticNormal',      // 'logisticNormal' | 'dirichlet'

  share: {
    /* 得票率の標準偏差(pt)。バックテストの残差から類型別に推定する。
       ★残差は「モデルに載せた候補だけで正規化し直して」から取ること。
         そうしないと未モデル化候補の取りこぼしが σ に混入し、
         下の other 成分と同じ誤差を二重に数えてしまう。            */
    pooledSdPt: 5.0,              // フォールバック（fitParams が上書き）
    byType: {},                   // { '保守分裂': 4.7, ... }
    shrinkK: 4,                   // 経験ベイズ的な縮小（類型別 n が小さいため）
    splitRho: -0.5,               // 保守分裂した2人に入れる追加の負相関。★未推定
  },

  turnout: {
    // 投票総数 = 想定値 × biasCorrection × LogNormal(0, sigmaLog)
    biasCorrection: 1.0,          // fitParams が実測で上書き
    sigmaLog: 0.10,               // 〃
    betaCompetitiveness: 0.0,     // 接戦ほど投票率が上がる効果。★未推定のため 0。
                                  //   前回投票率を race データに持たせて初めて推定できる。
  },

  other: {
    /* 「その他・未モデル化候補」成分。
       候補ごとの得票率のブレとは種類が違う不確実性で、
       「想定していなかった候補がそもそも出てくるか」を表す。

       ★形が重要。これは零過剰の混合分布で、対数正規1本では表せない。
           ・確率 presence で「未モデル化候補がいる」
           ・いる場合の規模は 対数正規(median, sigmaLog)
         単一の対数正規に潰すと中央値が下がりすぎ、
         実際に20%を得た候補が裾に収まらなくなる。                 */
    presenceUnconfirmed: 0.50,    // 告示前（fitParams が実測で上書き）
    presenceConfirmed:   0.02,    // 告示後・名簿確定 → ほぼ起きない
    medianGivenPresent:  0.030,   // 〃
    sigmaLog:            0.90,    // 〃
    floor:               0.002,   // 「いない」ときに置く最小質量
  },

  structural: {
    /* 前回得票率からの平均回帰。λ が大きいほど 1/K へ引き戻す。
       ★既定 0。center に既存モデルの出力を入れている場合、そちらが
         すでに平均回帰を織り込んでいるので二重適用になる。
         center を「前回得票率そのもの」に差し替えたときに 0.07 前後から推定。 */
    shrinkLambda: 0.0,
    // ★n が minN に届くまで既定で無効。この規模で当てにいくのは過学習。
    incumbency: { biasPt: 0, n: 0, enabled: false, minN: 30 },
  },

  /* ロジット空間の分布の裾の厚み。正規=Infinity、小さいほど裾が厚い。
     ★ν は少数データでは推定できないため固定値。安全側に倒している。 */
  tailNu: 5,

  /* --- レース間で相関する誤差 ---
     同日・同年のレースは全国的なムードを共有するため、誤差は独立でない。
     入れないと「今年は8戦6勝の見込み」のような集約的な主張が過信になる。
     方向は「現職に対する全国的な追い風/逆風」として与える。          */
  national: {
    sigmaLogit: 0.10,   // ★未推定。同日開催のレースが複数揃うまで推定できない。
    enabled: true,      // 個別レースの区間は保たれ、集約時にだけ効く（下記の控除参照）
  },

  /* --- 情勢調査の取り込み --- */
  poll: {
    enabled: true,
    // 実効誤差 = サンプリング誤差 ⊕ ハウスエフェクト。
    // 日本の情勢調査は設計効果が大きいので既定を厚めに置く。★未推定。
    houseErrorPt: 3.5,
    /* 定性的な表現（「優位」など）に割り当てる対数オッズ上のナッジと不確実性。
       ★数値が無い調査は情報量が乏しい。大きな sd を与えて過信を防ぐ。   */
    qualitative: {
      '優位': { nudge: 0.25, sdPt: 12 },
      '先行': { nudge: 0.15, sdPt: 12 },
      '接戦': { nudge: 0.00, sdPt: 10 },
      '追う': { nudge:-0.15, sdPt: 12 },
    },
  },

  sims: 30000,
  seed: 20260807,
};

/* ---------------- 情勢調査で中心値を更新 ----------------
   事前（構造モデルの出力）と調査を、ロジット空間で精度加重して混ぜる。
   調査が無ければ base をそのまま返す。                              */
function applyPolls(base, race, P, names){
  if (!P.poll || !P.poll.enabled || !race.polls || !race.polls.length){
    return { center: base, used: [] };
  }
  const K = base.length;
  const logit = p => Math.log(Math.max(p,1e-6) / Math.max(1-p,1e-6));
  const z = base.map(logit);
  const priorSdPt = P.share.byType[race.type] ?? P.share.pooledSdPt;
  const ptToLogitSd = (sdPt, p) => (sdPt/100) / Math.max(p*(1-p), 0.02);
  const used = [];

  for (const poll of race.polls){
    for (let i = 0; i < K; i++){
      const nm = names[i];
      let obsZ = null, obsSdPt = null;

      if (poll.shares && poll.shares[nm] != null){
        const p = poll.shares[nm] / 100;
        const samplingPt = poll.n ? Math.sqrt(p*(1-p)/poll.n)*100 : 4.0;
        obsSdPt = Math.sqrt(samplingPt**2 + P.poll.houseErrorPt**2);
        obsZ = logit(p);
      } else if (poll.lean && poll.lean[nm]){
        const q = P.poll.qualitative[poll.lean[nm]];
        if (q){ obsZ = z[i] + q.nudge; obsSdPt = q.sdPt; }   // 事前からのナッジとして扱う
      }
      if (obsZ == null) continue;

      const pi = Math.max(base[i], 1e-6);
      const priorSd = ptToLogitSd(priorSdPt, pi);
      const obsSd   = ptToLogitSd(obsSdPt,  pi);
      const wp = 1/(priorSd*priorSd), wo = 1/(obsSd*obsSd);
      z[i] = (z[i]*wp + obsZ*wo) / (wp + wo);
    }
    used.push({ source: poll.source, date: poll.date, quantitative: !!poll.shares });
  }
  const back = z.map(v => 1/(1+Math.exp(-v)));
  const s = back.reduce((a,b) => a+b, 0);
  return { center: back.map(v => v/s), used };
}

/* ---------------- バックテストからの係数推定 ----------------
   history の各要素:
     { name, date, type, fieldConfirmed,
       cands:[{name, incumbent, predicted, actual}],
       predTotal, actTotal, winnerName, predTopName, winProb?, winProbOn? }  */
function fitParams(history, base){
  const P = JSON.parse(JSON.stringify(base ?? DEFAULT_PARAMS));
  const graded = history.filter(h => h.cands.some(c => c.predicted != null));

  /* --- 投票総数のバイアスとばらつき（対数比で見る） --- */
  const logRatios = graded
    .filter(h => h.predTotal > 0 && h.actTotal > 0)
    .map(h => Math.log(h.predTotal / h.actTotal));
  if (logRatios.length >= 2){
    const m = mean(logRatios);
    P.turnout.biasCorrection = Math.exp(-m);      // 系統的な過大/過小を打ち消す
    P.turnout.sigmaLog = sdSample(logRatios, m);
    P.turnout.n = logRatios.length;
  }

  /* --- 未モデル化候補が実際に取った得票率 → other 成分 --- */
  const missMass = graded.map(h => {
    const un = h.cands.filter(c => c.predicted == null && c.actual != null);
    return un.reduce((s,c) => s + c.actual, 0) / 100;
  });
  if (missMass.length >= 2){
    const present = missMass.filter(v => v > 0.01);   // 1%超を「いた」とみなす
    P.other.presenceUnconfirmed = present.length / missMass.length;
    if (present.length >= 2){
      const lg = present.map(Math.log);
      const m  = mean(lg);
      P.other.medianGivenPresent = Math.exp(m);
      P.other.sigmaLog = sdSample(lg, m);
    }
    P.other.n = missMass.length;
    P.other.nPresent = present.length;
    P.other.observed = missMass.map(v => v * 100);
  }

  /* --- 得票率の残差 → 類型別 σ（プールへ縮小） ---
     ★モデルに載せた候補だけで両側を正規化し直してから残差を取る。
       未モデル化候補の取りこぼしは other 成分が担当するので、
       ここで一緒に数えると同じ誤差を二度カウントすることになる。      */
  const allErr = [];
  const byType = {};
  for (const h of graded){
    const modeled = h.cands.filter(c => c.predicted != null && c.actual != null);
    if (modeled.length < 2) continue;
    const pSum = modeled.reduce((s,c) => s + c.predicted, 0);
    const aSum = modeled.reduce((s,c) => s + c.actual, 0);
    if (pSum <= 0 || aSum <= 0) continue;
    for (const c of modeled){
      const e = (c.actual / aSum - c.predicted / pSum) * 100;   // 正規化後の残差(pt)
      allErr.push(e);
      (byType[h.type] ??= []).push(e);
    }
  }
  if (allErr.length >= 2){
    const pooled = rmse(allErr);
    P.share.pooledSdPt = pooled;
    P.share.n = allErr.length;
    for (const [t, es] of Object.entries(byType)){
      const r = rmse(es), n = es.length, k = P.share.shrinkK;
      P.share.byType[t] = Math.sqrt((n * r * r + k * pooled * pooled) / (n + k));
    }
  }

  /* --- 現職バイアス（符号が揃うか見るだけ。既定では適用しない） --- */
  const incErr = graded.flatMap(h => h.cands
    .filter(c => c.incumbent && c.predicted != null && c.actual != null)
    .map(c => c.actual - c.predicted));
  if (incErr.length){
    P.structural.incumbency.biasPt = mean(incErr);
    P.structural.incumbency.n = incErr.length;
    P.structural.incumbency.enabled = incErr.length >= P.structural.incumbency.minN;
  }
  return P;
}

/* ---------------- 予測本体 ----------------
   race:
     { name, type, fieldConfirmed, assumedTotalVotes, polls?,
       candidates:[{ name, center, incumbent, splitGroup? }] }
     center … 中心となる得票率(%)。合計100でなくても正規化される。      */
function forecast(race, P, opts = {}){
  const sims    = opts.sims ?? P.sims;
  const rng     = mulberry32(opts.seed ?? race.seed ?? P.seed);
  const sampler = opts.sampler ?? P.sampler;

  const field = race.candidates.filter(c => c.center != null);
  if (field.length < 2) return null;

  /* --- 中心 shares：正規化 → 平均回帰 → （任意で）現職補正 --- */
  const raw = field.map(c => c.center);
  const rawSum = raw.reduce((a,b) => a + b, 0);
  let base = raw.map(v => v / rawSum);

  const K = base.length;
  const lam = P.structural.shrinkLambda;
  if (lam > 0) base = base.map(p => p + lam * (1 / K - p));

  if (P.structural.incumbency.enabled){
    const b = P.structural.incumbency.biasPt / 100;
    base = base.map((p,i) => Math.max(1e-6, p + (field[i].incumbent ? b : -b / (K - 1))));
    const s = base.reduce((a,x) => a + x, 0);
    base = base.map(v => v / s);
  }

  /* --- 情勢調査があれば中心値を更新 --- */
  const pollRes = applyPolls(base, race, P, field.map(c => c.name));
  base = pollRes.center;

  /* --- 構造：候補間の「相対シェア q」と「その他質量 m」を分けて引く ---
       p_i = q_i × (1 - m) ,  p_other = m
     q は掲載候補だけの単体上に住む。σ を「掲載候補だけで正規化し直した
     残差」から推定しているので、q の分散として使うのが定義上正しい。
     m を同じ単体に第K+1成分として混ぜると、桁違いの σ が候補側へ
     漏れて質量を吸い込む。分離が正解。                              */

  /* --- 類型別 σ(pt) → ロジット空間の σ（デルタ法） ---
     softmax の勾配は ∂q_i/∂z_i = q_i(1-q_i) なので sd(q_i) ≈ q_i(1-q_i)·σ_i。
     σ を候補ごとに sd/(q(1-q)) と置くと q が小さい候補で発散するため、
     レース共通の σ を1つ置き「首位候補のばらつきが目標σに一致」するよう較正する。 */
  const sdPt = P.share.byType[race.type] ?? P.share.pooledSdPt;
  const sdPtIsFallback = !(race.type in P.share.byType);
  const qTop = Math.max(...base);
  const sigmaTotal = (sdPt / 100) / Math.max(qTop * (1 - qTop), 0.02);

  /* ★全国共通ショックは σ に「上乗せ」してはいけない。
     σ は過去の残差から推定した値で、当時の全国的なムードもすでに中に
     含まれている。上から足すと同じ不確実性を二度数え、個別レースの
     勝率が不当に 50% へ寄る。総分散を保ったまま分解する。

     控除量は「差（マージン）の分散」で合わせる必要がある。ショックは
     現職に +nat、他候補に -nat/(K-1) と入るので、現職と他候補の差には
     nat·K/(K-1) が乗り、その分散は σ_nat²K²/(K-1)²。
     局所成分は候補ごとに独立なので差の分散は 2σ_local²。
       2σ_local² + σ_nat²K²/(K-1)² = 2σ_total²
     K=2 なら σ_local² = σ_total² − 2σ_nat²。
     σ_nat² だけ引く素朴な実装では控除が足りない。                  */
  const sigNat = (P.national && P.national.enabled) ? P.national.sigmaLogit : 0;
  const natContrast = K > 1 ? (sigNat*sigNat) * (K*K) / (2 * (K-1)*(K-1)) : 0;
  const sigmaCommon = Math.sqrt(
    Math.max(sigmaTotal*sigmaTotal - natContrast, (0.25*sigmaTotal)**2));

  /* --- 共分散行列：保守分裂など、票を奪い合う組に追加の負相関 --- */
  const Sig = Array.from({length:K}, () => new Array(K).fill(0));
  for (let i = 0; i < K; i++) Sig[i][i] = sigmaCommon * sigmaCommon;
  for (let i = 0; i < K; i++){
    for (let j = i + 1; j < K; j++){
      const gi = field[i]?.splitGroup, gj = field[j]?.splitGroup;
      if (gi && gj && gi === gj){
        Sig[i][j] = Sig[j][i] = P.share.splitRho * sigmaCommon * sigmaCommon;
      }
    }
  }
  const L  = cholesky(Sig);
  const mu = base.map(p => Math.log(Math.max(p, 1e-9)));

  /* --- その他質量 m の混合分布 --- */
  const oPresence = race.fieldConfirmed ? P.other.presenceConfirmed : P.other.presenceUnconfirmed;
  const oMedian   = P.other.medianGivenPresent;
  const oSigma    = P.other.sigmaLog;
  const drawOther = () => rng() < oPresence
    ? Math.min(oMedian * Math.exp(randn(rng) * oSigma), 0.60)   // 60%で頭打ち
    : P.other.floor;

  /* --- 投票総数 --- */
  const assumed = race.assumedTotalVotes ?? null;
  const tMul = P.turnout.biasCorrection *
               Math.exp(P.turnout.betaCompetitiveness * (race.competitiveness ?? 0));
  const tSig = P.turnout.sigmaLog;

  /* --- Dirichlet 用の κ（目標分散から逆算: Var(q)=q(1-q)/(κ+1)） --- */
  const kappa = Math.max(1, qTop * (1 - qTop) / Math.pow(sdPt / 100, 2) - 1);

  /* --- シミュレーション --- */
  const shareDraws = Array.from({length:K}, () => new Float64Array(sims));
  const voteDraws  = Array.from({length:K}, () => new Float64Array(sims));
  const otherDraws = new Float64Array(sims);
  const marginDraw = new Float64Array(sims);
  const turnDraw   = new Float64Array(sims);
  const wins       = new Array(K).fill(0);

  // 上位2名は中心値で決めておく（マージンの定義を全シミュレーションで固定）
  const order = base.map((p,i) => [p,i]).sort((a,b) => b[0] - a[0]);
  const iA = order[0][1], iB = order[1][1];

  for (let s = 0; s < sims; s++){
    let q;
    if (sampler === 'dirichlet'){
      const g = base.map(x => gammaSample(rng, Math.max(x * kappa, 1e-3)));
      const t = g.reduce((a,b) => a + b, 0);
      q = g.map(x => x / t);
    } else {
      // 多変量 t：スケールを1シミュレーションで共有し、相関構造を保つ
      const scale = mvtScale(rng, P.tailNu);
      const w = Array.from({length:K}, () => randn(rng));
      /* 全国共通ショック。forecastAll から shocks[] が渡された場合は
         全レースで同じ列を使うので、レース間の誤差が相関する。      */
      const nat = (P.national && P.national.enabled)
        ? (opts.shocks ? opts.shocks[s] : randn(rng) * P.national.sigmaLogit)
        : 0;
      const z = new Array(K);
      for (let i = 0; i < K; i++){
        let acc = 0;
        for (let k = 0; k <= i; k++) acc += L[i][k] * w[k];
        z[i] = mu[i] + acc * scale + (field[i].incumbent ? nat : -nat / Math.max(K - 1, 1));
      }
      q = softmax(z);
    }

    const m = drawOther();
    const p = q.map(v => v * (1 - m));
    otherDraws[s] = m * 100;

    const T = assumed != null
      ? assumed * tMul * Math.exp(randn(rng) * tSig - tSig * tSig / 2)  // 平均を想定値に合わせる
      : null;
    turnDraw[s] = T ?? 0;

    for (let i = 0; i < K; i++){
      shareDraws[i][s] = p[i] * 100;
      if (T != null) voteDraws[i][s] = p[i] * T;
    }
    marginDraw[s] = (p[iA] - p[iB]) * 100;

    /* 勝者は掲載候補の中の最大値。
       ★限界: 「未モデル化の候補が勝つ」ケースは構造上表現できない。
         その他成分は複数候補の合計として扱っているため。
         だからこそ告示後の候補者名簿を読むという運用が要る。       */
    let best = 0;
    for (let i = 1; i < K; i++) if (q[i] > q[best]) best = i;
    wins[best]++;
  }

  /* --- 要約 --- */
  const sorted = arr => Float64Array.from(arr).sort();
  const out = field.map((c,i) => {
    const ss = sorted(shareDraws[i]);
    const vs = assumed != null ? sorted(voteDraws[i]) : null;
    return {
      name: c.name,
      incumbent: !!c.incumbent,
      share:    mean(Array.from(ss)),
      shareCI: [quantile(ss, 0.05), quantile(ss, 0.95)],
      // 後から較正を測れるよう分位点を残す。区間だけだと
      // 「どのくらい外したか」を再構成できない。
      shareQ: { q05:quantile(ss,0.05), q25:quantile(ss,0.25), q50:quantile(ss,0.50),
                q75:quantile(ss,0.75), q95:quantile(ss,0.95) },
      votes:   vs ? Math.round(mean(Array.from(vs))) : null,
      votesCI: vs ? [Math.round(quantile(vs,0.05)), Math.round(quantile(vs,0.95))] : null,
      winProb: wins[i] / sims * 100,
      winCount: wins[i],
    };
  });
  const ms = sorted(marginDraw);
  const ts = assumed != null ? sorted(turnDraw) : null;
  const os = sorted(otherDraws);

  return {
    race: race.name,
    sims,
    sdPtUsed: sdPt,
    sdPtIsFallback,                   // その類型の過去データが無くプール値を使った
    pollsUsed: pollRes.used,
    candidates: out,
    other: {
      presence: oPresence * 100,
      median:   quantile(os, 0.50),
      p95:      quantile(os, 0.95),
      mean:     mean(Array.from(os)),
    },
    margin: {
      leader:   field[iA].name,
      runnerUp: field[iB].name,
      point: mean(Array.from(ms)),
      ci:   [quantile(ms, 0.05), quantile(ms, 0.95)],
      // 「リードが逆転しない確率」を同時サンプルから直接数える
      prob: Array.from(ms).filter(v => v > 0).length / sims * 100,
    },
    turnout: ts ? {
      mean: Math.round(mean(Array.from(ts))),
      ci:  [Math.round(quantile(ts,0.05)), Math.round(quantile(ts,0.95))],
      assumed,
    } : null,
  };
}

/* ---------------- 複数レースを相関させて同時に予測 ----------------
   全レースで同じ「全国ショック」の列を共有する。個々のレースの区間は
   （上の分散控除により）ほぼ変わらないが、「何勝できるか」の分布が
   正しく広がる。独立と仮定すると勝ち数の分散を過小評価する。       */
function forecastAll(races, P, opts = {}){
  const sims = opts.sims ?? P.sims;
  const srng = mulberry32(opts.shockSeed ?? (P.seed + 991));
  const shocks = (P.national && P.national.enabled)
    ? Array.from({length:sims}, () => randn(srng) * P.national.sigmaLogit)
    : new Array(sims).fill(0);

  const out = {};
  for (const r of races) out[r.id ?? r.name] = forecast(r, P, { ...opts, sims, shocks });
  return { forecasts: out, shocks };
}

/* ---------------- スコアリング ----------------
   当たり外れの二値ではなく、確率予測としての良し悪しを測る。       */
const brier   = (p, outcome) => Math.pow(p - (outcome ? 1 : 0), 2);
const logLoss = (p, outcome) => {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return -(outcome ? Math.log(q) : Math.log(1 - q));
};

/* 90%区間の被覆率。較正できているなら 0.9 に近づくはず。 */
function coverage(records){
  const usable = records.filter(r => r.ci && r.actual != null);
  if (!usable.length) return { n: 0, rate: null };
  const inside = usable.filter(r => r.actual >= r.ci[0] && r.actual <= r.ci[1]).length;
  return { n: usable.length, rate: inside / usable.length };
}

/* ---------------- 交差検証 ----------------
   ★これが無いと、係数を推定したのと同じデータで自己採点することになり、
     必ず甘い数字が出る。

   mode:
     'loo'          … 1レースずつ伏せ、残り全部で係数を推定して予測
     'walkforward'  … 日付順に「それ以前のレースだけ」で係数を推定して予測。
                      実運用と同じ条件で、唯一完全に正直な評価。
   各レースについて当時の予測値を中心値として forecast() を丸ごと回し、
   実際の得票率が90%区間に入ったかを見る。                          */
function crossValidate(history, opts = {}){
  const mode     = opts.mode ?? 'loo';
  const minTrain = opts.minTrain ?? 2;
  const sims     = opts.sims ?? 4000;      // CV は回数を落として速く回す

  const sorted = history.slice().sort((a,b) => (a.date ?? '') < (b.date ?? '') ? -1 : 1);
  const folds = [];

  for (let i = 0; i < sorted.length; i++){
    const held  = sorted[i];
    const train = mode === 'walkforward' ? sorted.slice(0, i) : sorted.filter((_,j) => j !== i);
    if (train.length < minTrain) continue;

    const modeled = held.cands.filter(c => c.predicted != null && c.actual != null);
    if (modeled.length < 2) continue;

    const trainP = fitParams(train, opts.paramsBase);
    trainP.sims  = sims;

    const f = forecast({
      name: held.name, type: held.type,
      // 当時その名簿を確認済みだったか。不明なら false（保守的）。
      fieldConfirmed: held.fieldConfirmed ?? false,
      assumedTotalVotes: held.predTotal ?? null,
      candidates: modeled.map(c => ({ name:c.name, center:c.predicted, incumbent:c.incumbent })),
    }, trainP);
    if (!f) continue;

    const cands = modeled.map(c => {
      const fc = f.candidates.find(x => x.name === c.name);
      return {
        name: c.name, actual: c.actual,
        ci: fc.shareCI, predicted: fc.share,
        inside: c.actual >= fc.shareCI[0] && c.actual <= fc.shareCI[1],
        winProb: fc.winProb,
      };
    });
    const top = cands.reduce((a,b) => a.winProb > b.winProb ? a : b);
    folds.push({
      race: held.name, date: held.date,
      trainN: train.length,
      sdPt: trainP.share.byType[held.type] ?? trainP.share.pooledSdPt,
      candidates: cands,
      predictedWinner: top.name,
      actualWinner: held.winnerName,
      hit: top.name === held.winnerName,
      brier: brier(top.winProb / 100, top.name === held.winnerName),
    });
  }

  const allC   = folds.flatMap(f => f.candidates);
  const inside = allC.filter(c => c.inside).length;
  const sds    = folds.map(f => f.sdPt);
  return {
    mode, folds,
    coverage: allC.length ? inside / allC.length : null,
    coverageN: allC.length,
    hitRate: folds.length ? folds.filter(f => f.hit).length / folds.length : null,
    hits: folds.filter(f => f.hit).length,
    n: folds.length,
    brier: folds.length ? folds.reduce((s,f) => s + f.brier, 0) / folds.length : null,
    sdRange: sds.length ? [Math.min(...sds), Math.max(...sds)] : null,
  };
}

/* ベースライン戦略。これに勝てて初めてモデルに意味がある。 */
const BASELINES = {
  alwaysIncumbent: h => {
    const inc = h.cands.find(c => c.incumbent);
    return inc ? inc.name : null;               // 現職不在の空席レースは対象外
  },
  alwaysPriorTop: h => {
    const cs = h.cands.filter(c => c.priorShare != null);
    return cs.length ? cs.reduce((a,b) => a.priorShare > b.priorShare ? a : b).name : null;
  },
};

function scoreStrategy(history, pick){
  let n = 0, hit = 0;
  for (const h of history){
    const p = pick(h);
    if (!p) continue;
    n++;
    if (p === h.winnerName) hit++;
  }
  return { n, hit, rate: n ? hit / n * 100 : null };
}
/* ===== ENGINE:END ====================================================== */

if (typeof module !== 'undefined') module.exports = {
  mulberry32, randn, randt, mvtScale, gammaSample, cholesky, quantile, softmax,
  mean, sdSample, rmse,
  DEFAULT_PARAMS, fitParams, forecast, forecastAll, applyPolls,
  brier, logLoss, coverage, crossValidate, BASELINES, scoreStrategy,
};
