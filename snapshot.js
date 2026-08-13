/* snapshot.js — 予測を「投開票前に」凍結して forecasts/ へ書き出す。

   較正(90%区間の被覆率)や Brier スコアは、予測時点の数字が残っていて
   初めて測れる。過去レースは記録が無く、永久に採点できない。
   これはそれを断ち切るための仕組み。

     node snapshot.js            … 未実施レースの予測を保存（既存は上書きしない）
     node snapshot.js --verify   … 確定済みレースをスナップショットと突き合わせて採点
     node snapshot.js --list     … 保存済みの一覧
     node snapshot.js --force    … 上書きを許可（原則使わない）

   ★上書きしないのが肝。投開票後に予測を書き換えられると、較正もスコアも
     意味を失う。「予測欄に結果が入っている」事故を構造的に防ぐ。      */
const fs   = require('fs');
const path = require('path');

const DIR   = __dirname;
const BUILT = path.join(DIR, 'politisaber.html');
const OUT   = path.join(DIR, 'forecasts');
const SCHEMA_VERSION = 1;

/* --- ビルド済み HTML からモデルとデータを取り出す --------------------
   HTML が単一の真実。ここから読むことで、実際に公開されている数字と
   スナップショットが必ず一致する。                                    */
function loadModel(){
  const html = fs.readFileSync(BUILT, 'utf8');
  const script = html.split('<script>')[1].split('</scr' + 'ipt>')[0];
  const cut = script.indexOf('/* ---------- ボード ---------- */');
  if (cut < 0) throw new Error('politisaber.html の構造が想定と違います（先に node build.js）');
  return new Function(script.slice(0, cut) +
    '\nreturn {RACES, HISTORY, PARAMS, FORECASTS, LAST_UPDATED};')();
}

const fileFor = r => path.join(OUT, `${r.date}_${r.id}.json`);

function snapshot(force){
  const M = loadModel();
  fs.mkdirSync(OUT, { recursive:true });
  let written = 0, skipped = 0;

  for (const r of M.RACES){
    if (r.status !== 'pending') continue;
    const f = M.FORECASTS[r.id];
    if (!f){ console.log(`  ⚠ ${r.name}: 予測が生成されていません`); continue; }

    const file = fileFor(r);
    if (fs.existsSync(file) && !force){
      console.log(`  · ${r.name}: 既存のスナップショットを保持（上書きしません）`);
      skipped++; continue;
    }

    const rec = {
      schemaVersion: SCHEMA_VERSION,
      recordedAt: new Date().toISOString(),
      dataLastUpdated: M.LAST_UPDATED,
      race: { id:r.id, name:r.name, date:r.date, type:r.type, fieldConfirmed:!!r.fieldConfirmed },
      model: {
        sampler: M.PARAMS.sampler, sims: f.sims, seed: M.PARAMS.seed,
        tailNu: M.PARAMS.tailNu,
        sdPtUsed: f.sdPtUsed, sdPtIsFallback: f.sdPtIsFallback,
        trainedOn: M.HISTORY.map(h => h.name),
        trainingN: M.HISTORY.length,
      },
      polls: f.pollsUsed ?? [],
      candidates: f.candidates.map(c => ({
        name: c.name, incumbent: c.incumbent,
        share: c.share, shareQ: c.shareQ,
        votes: c.votes, votesCI: c.votesCI,
        winProb: c.winProb,
      })),
      other:   f.other,
      margin:  f.margin,
      turnout: f.turnout,
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    console.log(`  ✓ ${r.name}: ${path.basename(file)} を保存`);
    written++;
  }
  console.log(`\n  保存 ${written} 件 / 保持 ${skipped} 件`);
  if (skipped) console.log('  （上書きしたい場合のみ --force。原則として使わないでください）');
}

function verify(){
  const M = loadModel();
  if (!fs.existsSync(OUT)){ console.log('  forecasts/ がまだありません。先に node snapshot.js'); return; }

  const rows = [], missing = [];
  for (const r of M.RACES.filter(x => x.status === 'decided')){
    const file = fileFor(r);
    if (!fs.existsSync(file)){ missing.push(r); continue; }
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const sc of snap.candidates){
      const cand = r.candidates.find(c => c.name === sc.name);
      if (!cand || cand.actual == null) continue;
      rows.push({
        race:r.name, name:sc.name, actual:cand.actual,
        q05:sc.shareQ.q05, q95:sc.shareQ.q95,
        inside: cand.actual >= sc.shareQ.q05 && cand.actual <= sc.shareQ.q95,
        winProb: sc.winProb, won: cand.winner === true,
      });
    }
  }

  console.log('\n  ── スナップショットとの突き合わせ ──');
  if (!rows.length) console.log('  採点できる確定レースがまだありません。');
  else {
    for (const x of rows){
      console.log(`    ${x.race} ${x.name}  実際 ${x.actual.toFixed(1)}%  予測区間 ${x.q05.toFixed(1)}–${x.q95.toFixed(1)}  ${x.inside?'✓ 区間内':'✗ 区間外'}`);
    }
    const cov = rows.filter(x => x.inside).length / rows.length;
    const bs  = rows.reduce((s,x) => s + Math.pow(x.winProb/100 - (x.won?1:0), 2), 0) / rows.length;
    console.log(`\n    90%区間の被覆率 : ${(cov*100).toFixed(0)}%  (${rows.filter(x=>x.inside).length}/${rows.length})`);
    console.log(`    Brier           : ${bs.toFixed(3)}`);
  }

  console.log('\n  ── スナップショットが無い確定レース ──');
  if (!missing.length) console.log('    なし');
  else {
    for (const r of missing) console.log(`    ✗ ${r.name} (${r.date})  ← 予測時の記録が無く、永久に採点できません`);
    console.log(`\n    ${missing.length} 件。過去分は復元できないので、今後は必ず投開票前に snapshot を取ってください。`);
  }
}

function list(){
  if (!fs.existsSync(OUT)){ console.log('  forecasts/ はまだありません。'); return; }
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.json')).sort();
  if (!files.length){ console.log('  スナップショットはまだありません。'); return; }
  console.log('');
  for (const f of files){
    const s = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    const lead = s.candidates.reduce((a,b) => a.winProb > b.winProb ? a : b);
    console.log(`  ${f}`);
    console.log(`    記録 ${s.recordedAt.slice(0,16).replace('T',' ')}  学習${s.model.trainingN}件  σ=${s.model.sdPtUsed.toFixed(2)}pt`);
    console.log(`    ${lead.name} ${lead.share.toFixed(1)}% (${lead.shareQ.q05.toFixed(1)}–${lead.shareQ.q95.toFixed(1)})  勝率 ${lead.winProb.toFixed(1)}%`);
  }
  console.log('');
}

const args = process.argv.slice(2);
console.log('\nPolitiSABER snapshot');
try {
  if (args.includes('--verify'))    verify();
  else if (args.includes('--list')) list();
  else                              snapshot(args.includes('--force'));
} catch (e){
  console.error('  エラー: ' + e.message);
  process.exit(1);
}
console.log('');
