/* cli.js — 開票当日の操作口。

     node server/cli.js ingest <raceId> <file.csv>   観測を取り込む
     node server/cli.js estimate <raceId>            現在の推定を表示
     node server/cli.js replay <raceId>              開票の進行に沿った推移
     node server/cli.js races                        レース一覧
     node server/cli.js init <raceId>                レース定義の雛形を作る

   開票当日はこれを繰り返すだけ:
     途中経過を CSV に書く → ingest → estimate                     */
const fs   = require('fs');
const path = require('path');
const store    = require('./store.js');
const pipeline = require('./pipeline.js');
const sources  = require('./sources/index.js');

const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
const pad = (s,n) => String(s).padStart(n);

async function ingest(raceId, file){
  const race = pipeline.loadRace(raceId);
  const obs  = await sources.manual.fetchObservations(race, { file });
  const written = store.appendAll(obs);
  console.log(`\n  ${written.length} 件を取り込みました（追記のみ・既存は変更しません）`);
  const snap = store.snapshotAt(raceId);
  console.log(`  開票済み自治体: ${snap.length} / ${race.municipalities.length}\n`);
}

function showEstimate(raceId, opts){
  const e = pipeline.estimate(raceId, opts);
  console.log('');
  console.log(`  ${e.name}   ${e.asOf.slice(0,19).replace('T',' ')}`);
  console.log(`  開票 ${e.municipalities.reported}/${e.municipalities.total} 自治体`);
  if (e.status === 'waiting'){ console.log(`\n  ${e.message}\n`); return; }
  console.log(`  開票率 ${e.countedPct.toFixed(1)}%  (${e.countedVotes.toLocaleString()} / 推定総数 ${e.projectedTotal.toLocaleString()})`);
  if (e.unknownMunicipalities.length){
    console.log(`  \x1b[33m⚠ 定義に無い自治体: ${e.unknownMunicipalities.join(', ')}\x1b[0m`);
  }
  console.log('');
  console.log(`  ${'候補'.padEnd(12,'　')} ${pad('推定',7)} ${pad('90%区間',16)} ${pad('勝率',8)}   ${pad('素朴な按分',10)}`);
  console.log('  ' + '─'.repeat(66));
  for (const c of e.candidates){
    const diff = c.share - c.naiveShare;
    console.log(`  ${c.name.padEnd(12,'　')} ${pad(c.share.toFixed(2)+'%',7)} ` +
      `${pad(`${c.shareCI[0].toFixed(1)}–${c.shareCI[1].toFixed(1)}`,16)} ${pad(c.winProb.toFixed(1)+'%',8)}   ` +
      `${pad(c.naiveShare.toFixed(2)+'%',10)} (${sgn(diff)})`);
  }
  console.log('');
  if (e.called) console.log(`  \x1b[32m■ 当選確実: ${e.called}\x1b[0m（勝率 ${e.leaderProb.toFixed(2)}% ≥ 99.9%）`);
  else console.log(`  首位 ${e.leader}（勝率 ${e.leaderProb.toFixed(1)}%）— 当確の閾値 99.9% に未達`);
  console.log(`  \x1b[90m有効粒子数 ${Math.round(e.ess)} / ${e.particles}\x1b[0m`);
  console.log('');
}

function showReplay(raceId){
  const rows = pipeline.replay(raceId);
  if (!rows.length){ console.log('\n  観測がありません\n'); return; }
  console.log(`\n  ${'時刻'.padEnd(20)} ${pad('開票率',7)}  ${pad('首位',10)} ${pad('勝率',8)}  当確`);
  console.log('  ' + '─'.repeat(62));
  for (const r of rows){
    console.log(`  ${r.asOf.slice(0,19).replace('T',' ').padEnd(20)} ${pad((r.countedPct??0).toFixed(1)+'%',7)}  ` +
      `${pad(r.leader ?? '—',10)} ${pad(r.leaderProb!=null?r.leaderProb.toFixed(1)+'%':'—',8)}  ${r.called ?? ''}`);
  }
  console.log('');
}

function init(raceId){
  fs.mkdirSync(pipeline.RACES_DIR, { recursive:true });
  const f = path.join(pipeline.RACES_DIR, `${raceId}.json`);
  if (fs.existsSync(f)){ console.log(`\n  既にあります: ${f}\n`); return; }
  fs.writeFileSync(f, JSON.stringify({
    raceId, name:'（レース名）',
    candidates:['候補1','候補2'],
    baseTurnout:0.55,
    _comment:'priorShares は前回選挙のその自治体での得票率。candidates と同じ順・同じ長さ。合計は自動で正規化される。',
    municipalities:[
      { name:'（自治体名）', electorate:100000, priorShares:[0.5,0.5] },
    ],
  }, null, 2));
  console.log(`\n  雛形を作りました: ${path.relative(process.cwd(), f)}`);
  console.log('  ★市区町村別の前回得票率を埋めないと開票速報モデルは動きません。\n');
}

const [cmd, a, b] = process.argv.slice(2);
(async () => {
  try {
    switch (cmd){
      case 'ingest':   if (!a || !b) throw new Error('使い方: ingest <raceId> <file.csv>');
                       await ingest(a, b); break;
      case 'estimate': if (!a) throw new Error('使い方: estimate <raceId>');
                       showEstimate(a, { asOf: b }); break;
      case 'replay':   if (!a) throw new Error('使い方: replay <raceId>');
                       showReplay(a); break;
      case 'races':    { const ids = pipeline.listRaces();
                         console.log(ids.length ? '\n  ' + ids.join('\n  ') + '\n' : '\n  レース定義がありません（cli.js init <raceId>）\n'); break; }
      case 'init':     if (!a) throw new Error('使い方: init <raceId>');
                       init(a); break;
      default:
        console.log(`\n使い方:
  node server/cli.js races
  node server/cli.js init     <raceId>
  node server/cli.js ingest   <raceId> <file.csv>
  node server/cli.js estimate <raceId> [asOf]
  node server/cli.js replay   <raceId>
`);
    }
  } catch (e){
    console.error(`\n  エラー: ${e.message}\n`);
    process.exit(1);
  }
})();
