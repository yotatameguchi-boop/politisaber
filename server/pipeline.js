/* pipeline.js — 観測 → 開票速報の推定。

   store の時刻断面を livecount.js が食える形に変換して推定を回す。
   ここが「開票速報ボード」の当日動く部分の本体。

   レース定義（data/races/<raceId>.json）が要る:
     {
       "raceId": "okinawa2026",
       "name": "沖縄県知事選",
       "candidates": ["玉城デニー","古謝玄太","下地幹郎"],
       "baseTurnout": 0.55,
       "municipalities": [
         { "name":"那覇市", "electorate":260000, "priorShares":[0.52,0.42,0.06] },
         ...
       ]
     }
   priorShares … 前回選挙のその自治体での得票率（基準線）。合計1に正規化される。
   ★これが無いと開票速報モデルは動かない。市区町村別の過去データが
     このプロジェクトの最大のボトルネック。                       */
const fs   = require('fs');
const path = require('path');
const store = require('./store.js');
const LC    = require('../livecount.js');

const RACES_DIR = path.join(store.DATA_DIR, 'races');

function loadRace(raceId){
  const f = path.join(RACES_DIR, `${raceId}.json`);
  if (!fs.existsSync(f)) throw new Error(`レース定義がありません: ${path.relative(process.cwd(), f)}`);
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));

  const errs = [];
  if (!Array.isArray(r.candidates) || r.candidates.length < 2) errs.push('candidates が2件以上必要です');
  if (!Array.isArray(r.municipalities) || !r.municipalities.length) errs.push('municipalities が空です');
  else r.municipalities.forEach((m,i) => {
    if (!m.name) errs.push(`municipalities[${i}].name がありません`);
    if (!(m.electorate > 0)) errs.push(`${m.name || i}: electorate が正の数ではありません`);
    if (!Array.isArray(m.priorShares) || m.priorShares.length !== (r.candidates||[]).length){
      errs.push(`${m.name || i}: priorShares の長さが candidates と一致しません`);
    }
  });
  if (errs.length) throw new Error(`${raceId} のレース定義が不正: ` + errs.join(' / '));

  // priorShares を正規化（合計1でなくても受け付ける）
  r.municipalities = r.municipalities.map(m => {
    const s = m.priorShares.reduce((a,b) => a + b, 0);
    return { ...m, priorShares: m.priorShares.map(v => v / (s || 1)) };
  });
  r.baseTurnout = r.baseTurnout ?? 0.55;
  return r;
}

const listRaces = () => fs.existsSync(RACES_DIR)
  ? fs.readdirSync(RACES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
  : [];

/* ---------- 観測を livecount の reported 形式へ ---------- */
function toReported(race, observations){
  const idx = new Map(race.municipalities.map((m,i) => [m.name, i]));
  const reported = [];
  const unknown = [];
  for (const o of observations){
    if (!o.counted) continue;                       // 途中の自治体は使わない
    const i = idx.get(o.municipality);
    if (i == null){ unknown.push(o.municipality); continue; }
    const votes = race.candidates.map(c => o.votes[c] ?? 0);
    const total = votes.reduce((a,b) => a + b, 0);
    if (total <= 0) continue;
    reported.push({ index:i, votes, total });
  }
  return { reported, unknown: [...new Set(unknown)] };
}

/* ---------- 推定 ----------
   asOf を渡すとその時点での推定を再現できる（事後検証用）。      */
function estimate(raceId, opts = {}){
  const race = loadRace(raceId);
  const obs  = store.snapshotAt(raceId, opts.asOf);
  const { reported, unknown } = toReported(race, obs);

  const pref = {
    name: race.name,
    candidates: race.candidates,
    baseTurnout: race.baseTurnout,
    municipalities: race.municipalities,
  };

  const base = {
    raceId, name: race.name,
    asOf: opts.asOf ?? new Date().toISOString(),
    municipalities: { reported: reported.length, total: race.municipalities.length },
    unknownMunicipalities: unknown,     // 定義に無い自治体名が来たら黙って捨てず報告する
  };

  if (reported.length === 0){
    return { ...base, status:'waiting', message:'まだ開票済みの自治体がありません', candidates:null };
  }

  const est   = LC.lcEstimate(pref, reported, {
    particles: opts.particles ?? 20000,
    seed: opts.seed ?? 20260913,
    callThreshold: opts.callThreshold ?? 99.9,
  });
  const naive = LC.lcNaive(pref, reported);

  const countedVotes = reported.reduce((s,r) => s + r.total, 0);

  return {
    ...base,
    status: est.called ? 'called' : 'counting',
    countedVotes,
    countedPct: est.countedPct,
    projectedTotal: est.projectedTotal,
    candidates: est.candidates.map((c,i) => ({
      ...c,
      naiveShare: naive[i].share,      // 素朴な按分との差を常に見せる
    })),
    leader: est.leader,
    leaderProb: est.leaderProb,
    called: est.called,
    ess: est.ess,
    particles: opts.particles ?? 20000,
  };
}

/* ---------- 巻き戻し ----------
   観測が入った各時刻で推定を回し直す。開票の進行に沿って
   推定がどう動いたかを後から検証できる。                       */
function replay(raceId, opts = {}){
  return store.timeline(raceId).map(t => {
    const e = estimate(raceId, { ...opts, asOf: t, particles: opts.particles ?? 4000 });
    return {
      asOf: t,
      countedPct: e.countedPct ?? 0,
      status: e.status,
      leader: e.leader ?? null,
      leaderProb: e.leaderProb ?? null,
      called: e.called ?? null,
      candidates: e.candidates,
    };
  });
}

module.exports = { RACES_DIR, loadRace, listRaces, toReported, estimate, replay };
