/* test.js — バックエンドの端から端までの検証。
     node server/test.js

   検証したいこと:
     1. 不正な観測を確実に弾く（黙って通さない）
     2. 追記専用として振る舞う（上書きされない・履歴が残る）
     3. 時刻断面を正しく再構成できる
     4. 開票の進行に沿って推定が真値へ収束する
     5. API が期待どおりの応答を返す
   一時ディレクトリで動かし、本物の data/ には触らない。            */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const assert = require('assert');

/* --- 隔離: DATA_DIR を一時ディレクトリへ差し替える --- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'politisaber-test-'));
const storePath = require.resolve('./store.js');
const storeSrc  = fs.readFileSync(storePath, 'utf8')
  .replace("path.join(__dirname, '..', 'data')", JSON.stringify(TMP));
const storeMod  = new module.constructor();
storeMod._compile(storeSrc, storePath);
require.cache[storePath] = storeMod;

const store    = require('./store.js');
const pipeline = require('./pipeline.js');
const sources  = require('./sources/index.js');
const E        = require('../engine.js');
const LC       = require('../livecount.js');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m,e) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}\n      ${e}`); };
function t(name, fn){ try { fn(); ok(name); } catch(e){ bad(name, e.message); } }

/* --- 合成レースを用意（正解が分かっている世界） --- */
const RACE_ID = 'testrace';
const rng = E.mulberry32(99);
const CANDS = ['候補A','候補B'];
const munis = Array.from({length:40}, (_,i) => {
  const electorate = Math.round(Math.exp(8.4 + E.randn(rng)*1.2));
  const urban = 1/(1+Math.exp(-(Math.log(electorate)-9.2)));
  const a = Math.min(Math.max(0.70 - 0.20*urban + E.randn(rng)*0.05, 0.35), 0.90);
  return { name:`市町村${String(i+1).padStart(2,'0')}`, electorate, priorShares:[a, 1-a] };
});
fs.mkdirSync(path.join(TMP,'races'), { recursive:true });
fs.writeFileSync(path.join(TMP,'races',`${RACE_ID}.json`), JSON.stringify({
  raceId:RACE_ID, name:'テスト県知事選', candidates:CANDS, baseTurnout:0.55, municipalities:munis,
}, null, 2));

const race  = pipeline.loadRace(RACE_ID);
const truth = LC.lcSimulateTruth(
  { name:'t', candidates:CANDS, baseTurnout:0.55, municipalities:race.municipalities },
  { rng:E.mulberry32(7), trueSwing:[0.22,-0.05], tau:0.12 });
const grand = truth.reduce((s,m) => s + m.total, 0);
const trueShareA = truth.reduce((s,m) => s + m.votes[0], 0) / grand * 100;

console.log('\n══ PolitiSABER backend tests ══');
console.log(`  一時領域: ${TMP}`);
console.log(`  合成レース: ${munis.length}自治体 / 総投票 ${grand.toLocaleString()} / 真の得票率A ${trueShareA.toFixed(2)}%\n`);

/* ---------- 1. 入力検証 ---------- */
console.log('1. 入力検証');
t('raceId が無い観測を弾く', () => {
  assert.throws(() => store.append({ municipality:'x', votes:{'候補A':1}, source:'t' }), /raceId/);
});
t('votes が空の観測を弾く', () => {
  assert.throws(() => store.append({ raceId:RACE_ID, municipality:'x', votes:{}, source:'t' }), /votes/);
});
t('得票数が非整数なら弾く', () => {
  assert.throws(() => store.append({ raceId:RACE_ID, municipality:'x', votes:{'候補A':1.5}, source:'t' }), /非負整数/);
});
t('得票数が負なら弾く', () => {
  assert.throws(() => store.append({ raceId:RACE_ID, municipality:'x', votes:{'候補A':-3}, source:'t' }), /非負整数/);
});
t('appendAll は1件でも不正なら何も書かない（全か無か）', () => {
  const before = store.readAll(RACE_ID).length;
  assert.throws(() => store.appendAll([
    { raceId:RACE_ID, municipality:'市町村01', votes:{'候補A':10,'候補B':5}, source:'t' },
    { raceId:RACE_ID, municipality:'市町村02', votes:{'候補A':-1}, source:'t' },
  ]));
  assert.strictEqual(store.readAll(RACE_ID).length, before, '部分的に書き込まれました');
});

/* ---------- 2. 追記専用 ---------- */
console.log('\n2. 追記専用としての振る舞い');
t('同じ自治体を2回書くと履歴が2件残る', () => {
  store.append({ raceId:RACE_ID, municipality:'市町村01', votes:{'候補A':100,'候補B':50},
                 source:'t1', observedAt:'2026-09-13T20:00:00.000Z' });
  store.append({ raceId:RACE_ID, municipality:'市町村01', votes:{'候補A':120,'候補B':60},
                 source:'t2', observedAt:'2026-09-13T21:00:00.000Z' });
  const all = store.readAll(RACE_ID).filter(o => o.municipality === '市町村01');
  assert.strictEqual(all.length, 2, `履歴が ${all.length} 件しかありません`);
});
t('最新断面は新しい方を採用する', () => {
  const snap = store.snapshotAt(RACE_ID).filter(o => o.municipality === '市町村01');
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].votes['候補A'], 120);
});
t('過去断面は当時の値を返す（訂正前が復元できる）', () => {
  const snap = store.snapshotAt(RACE_ID, '2026-09-13T20:30:00.000Z')
                    .filter(o => o.municipality === '市町村01');
  assert.strictEqual(snap[0].votes['候補A'], 100, '過去断面が復元できていません');
});

/* ---------- 3. CSV 取り込み ---------- */
console.log('\n3. CSV 取り込み');
const csvPath = path.join(TMP, 'in.csv');
t('候補者列がレース定義と違えば弾く', () => {
  fs.writeFileSync(csvPath, 'municipality,候補A,誰か\n市町村02,10,20\n');
  assert.throws(() => sources.parseCsv(fs.readFileSync(csvPath,'utf8'), race, 'x'), /一致しません/);
});
t('定義に無い自治体名を弾く', () => {
  fs.writeFileSync(csvPath, 'municipality,候補A,候補B\n存在しない市,10,20\n');
  assert.throws(() => sources.parseCsv(fs.readFileSync(csvPath,'utf8'), race, 'x'), /定義に無い/);
});
t('表計算ソフトが囲む桁区切り "1,234" を正しく読む', () => {
  fs.writeFileSync(csvPath, 'municipality,候補A,候補B\n市町村03,"1,234",567\n');
  const obs = sources.parseCsv(fs.readFileSync(csvPath,'utf8'), race, 'x');
  assert.strictEqual(obs[0].votes['候補A'], 1234);
  assert.strictEqual(obs[0].votes['候補B'], 567);
});
t('引用符が閉じていない CSV を弾く', () => {
  assert.throws(() => sources.parseCsv('municipality,候補A,候補B\n市町村03,"12,34\n', race, 'x'), /引用符/);
});

/* ---------- 4. 推定の収束 ---------- */
console.log('\n4. 開票の進行に沿った推定');
// 一度きれいにして、小さい自治体から順に投入する
fs.writeFileSync(store.fileFor(RACE_ID), '');
const order = LC.lcCountingOrder(
  { municipalities: race.municipalities }, E.mulberry32(5));
const results = [];
let counted = 0, step = 0;
for (const mi of order){
  const m = truth[mi];
  store.append({ raceId:RACE_ID, municipality:race.municipalities[mi].name,
    votes:{ '候補A':m.votes[0], '候補B':m.votes[1] }, counted:true, source:'sim',
    observedAt:new Date(Date.UTC(2026,8,13,20,0,0) + (++step)*60000).toISOString() });
  counted += m.total;
  const pct = counted/grand*100;
  if ([10,30,60,90].some(x => pct >= x && (results[results.length-1]?.target ?? 0) < x)){
    const target = [10,30,60,90].filter(x => pct >= x).pop();
    const e = pipeline.estimate(RACE_ID, { particles:3000 });
    results.push({ target, pct, est:e });
  }
}
for (const r of results){
  const c = r.est.candidates[0];
  const inside = trueShareA >= c.shareCI[0] && trueShareA <= c.shareCI[1];
  const errM = Math.abs(c.share - trueShareA), errN = Math.abs(c.naiveShare - trueShareA);
  console.log(`  開票率${String(r.target).padStart(2)}%  推定 ${c.share.toFixed(2)}% [${c.shareCI[0].toFixed(1)}–${c.shareCI[1].toFixed(1)}]` +
              `  真値 ${trueShareA.toFixed(2)}%  誤差 ${errM.toFixed(2)}pt（素朴 ${errN.toFixed(2)}pt）  ${inside?'区間内':'区間外'}`);
}
t('推定が真値へ収束する（開票90%で誤差1pt未満）', () => {
  const last = results[results.length-1].est.candidates[0];
  const err = Math.abs(last.share - trueShareA);
  assert.ok(err < 1.0, `誤差 ${err.toFixed(2)}pt`);
});
t('素朴な按分より正確（序盤ほど差が大きい）', () => {
  const f = results[0].est.candidates[0];
  assert.ok(Math.abs(f.share-trueShareA) < Math.abs(f.naiveShare-trueShareA),
    `モデル ${Math.abs(f.share-trueShareA).toFixed(2)}pt vs 素朴 ${Math.abs(f.naiveShare-trueShareA).toFixed(2)}pt`);
});
t('開票が進むと区間が狭まる', () => {
  const w = results.map(r => r.est.candidates[0].shareCI[1] - r.est.candidates[0].shareCI[0]);
  assert.ok(w[w.length-1] < w[0], `区間幅 ${w[0].toFixed(2)} → ${w[w.length-1].toFixed(2)}`);
});
t('巻き戻しで各時点の推定を再現できる', () => {
  const rp = pipeline.replay(RACE_ID, { particles:800 });
  assert.ok(rp.length >= 10, `${rp.length} 時点`);
  assert.ok(rp[0].countedPct < rp[rp.length-1].countedPct, '開票率が単調に増えていません');
});

/* ---------- 5. API ---------- */
console.log('\n5. API');
const { handler } = require('./api.js');
function call(method, url, body){
  return new Promise(resolve => {
    const chunks = [];
    const req = { method, url, headers:{host:'localhost'},
      on(ev, cb){ if (ev === 'data' && body) cb(Buffer.from(JSON.stringify(body)));
                  if (ev === 'end') cb(); return req; },
      destroy(){} };
    const res = { writeHead(code, h){ this.code = code; this.headers = h; },
      end(b){ if (b) chunks.push(b); resolve({ code:this.code,
        body:(()=>{ try { return JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString()); }
                    catch { return Buffer.concat(chunks.map(Buffer.from)).toString(); } })() }); } };
    handler(req, res);
  });
}
(async () => {
  const r1 = await call('GET','/api/races');
  t('GET /api/races がレース一覧を返す', () => {
    assert.strictEqual(r1.code, 200);
    assert.ok(r1.body.races.some(x => x.raceId === RACE_ID));
  });
  const r2 = await call('GET',`/api/races/${RACE_ID}/estimate?particles=1500`);
  t('GET /estimate が推定を返す', () => {
    assert.strictEqual(r2.code, 200);
    assert.ok(r2.body.candidates.length === 2);
    assert.ok(r2.body.countedPct > 0);
  });
  const r3 = await call('GET','/api/races/nonexistent/estimate');
  t('存在しないレースは 400 を返す', () => assert.strictEqual(r3.code, 400));
  const r4 = await call('POST',`/api/races/${RACE_ID}/observations`,
    { observations:[{ municipality:'存在しない市', votes:{'候補A':1,'候補B':2}, source:'t' }] });
  t('定義に無い自治体の POST を 400 で弾く', () => {
    assert.strictEqual(r4.code, 400);
    assert.ok(r4.body.unknown.includes('存在しない市'));
  });
  const before = store.readAll(RACE_ID).length;
  const r5 = await call('POST',`/api/races/${RACE_ID}/observations`,
    { observations:[{ municipality:'市町村01', votes:{'候補A':999,'候補B':111}, source:'api-test' }] });
  t('正しい POST は追記される', () => {
    assert.strictEqual(r5.code, 201);
    assert.strictEqual(store.readAll(RACE_ID).length, before + 1);
  });
  const r6 = await call('GET',`/api/races/${RACE_ID}/observations`);
  t('GET /observations が生ログを返す', () => {
    assert.strictEqual(r6.code, 200);
    assert.ok(r6.body.observations.length > 0);
  });

  console.log(`\n══ 結果: ${pass} 成功 / ${fail} 失敗 ══\n`);
  fs.rmSync(TMP, { recursive:true, force:true });
  process.exit(fail ? 1 : 0);
})();
