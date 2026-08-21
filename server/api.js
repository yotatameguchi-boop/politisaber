/* api.js — 開票速報の HTTP API。外部依存なし（node:http のみ）。

     node server/api.js            … ポート 8787 で起動
     PORT=9000 node server/api.js

   エンドポイント:
     GET  /api/races                     レース一覧
     GET  /api/races/:id                 レース定義（自治体・基準線）
     GET  /api/races/:id/estimate        現在の推定（?asOf=ISO で過去断面）
     GET  /api/races/:id/observations    生の観測ログ
     GET  /api/races/:id/replay          開票の進行に沿った推定の推移
     POST /api/races/:id/observations    観測の追加（追記のみ・上書き不可）
     GET  /                              静的配信（politisaber.html）

   ★推定は毎回その場で計算する。キャッシュしていないのは、
     途中経過が数分おきに変わる前提で、古い数字を返す方が害が大きいため。
     20000粒子で数百ms程度。負荷が問題になったら短期キャッシュを足す。 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const store    = require('./store.js');
const pipeline = require('./pipeline.js');

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = path.join(__dirname, '..');

const json = (res, code, body) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(s),
    'Cache-Control':'no-store',
  });
  res.end(s);
};
const fail = (res, code, message, extra) => json(res, code, { error:message, ...extra });

function readBody(req, limit = 2_000_000){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit){ reject(new Error('本文が大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.json':'application/json; charset=utf-8', '.css':'text/css; charset=utf-8' };

function serveStatic(res, urlPath){
  const rel = urlPath === '/' ? 'politisaber.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  // ルート外へ出る経路を塞ぐ
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'politisaber.html')){
    return fail(res, 403, '禁止されたパスです');
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return fail(res, 404, '見つかりません');
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

const handler = async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return fail(res, 400, 'URL が不正です'); }
  const p = url.pathname;

  try {
    if (p === '/api/races' && req.method === 'GET'){
      return json(res, 200, { races: pipeline.listRaces().map(id => {
        try { const r = pipeline.loadRace(id);
              return { raceId:id, name:r.name, candidates:r.candidates,
                       municipalities:r.municipalities.length }; }
        catch (e){ return { raceId:id, error:e.message }; }
      })});
    }

    const m = p.match(/^\/api\/races\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/);
    if (m){
      const raceId = m[1], sub = m[2];

      if (!sub && req.method === 'GET'){
        return json(res, 200, pipeline.loadRace(raceId));
      }
      if (sub === '/estimate' && req.method === 'GET'){
        return json(res, 200, pipeline.estimate(raceId, {
          asOf: url.searchParams.get('asOf') ?? undefined,
          particles: Number(url.searchParams.get('particles')) || undefined,
        }));
      }
      if (sub === '/observations' && req.method === 'GET'){
        return json(res, 200, { raceId, observations: store.readAll(raceId) });
      }
      if (sub === '/replay' && req.method === 'GET'){
        return json(res, 200, { raceId, replay: pipeline.replay(raceId) });
      }
      if (sub === '/observations' && req.method === 'POST'){
        const race = pipeline.loadRace(raceId);           // 存在確認を先に
        const body = JSON.parse(await readBody(req) || '{}');
        const arr = Array.isArray(body) ? body : body.observations;
        if (!Array.isArray(arr)) return fail(res, 400, 'observations 配列が必要です');

        const known = new Set(race.municipalities.map(x => x.name));
        const bad = arr.filter(o => o.municipality && !known.has(o.municipality))
                       .map(o => o.municipality);
        if (bad.length) return fail(res, 400, 'レース定義に無い自治体です', { unknown:[...new Set(bad)] });

        const written = store.appendAll(arr.map(o => ({ ...o, raceId })));
        return json(res, 201, { appended: written.length, observations: written });
      }
      return fail(res, 405, 'メソッドが許可されていません');
    }

    if (req.method === 'GET') return serveStatic(res, p);
    return fail(res, 404, '見つかりません');

  } catch (e){
    const code = /がありません|不正|一致しません/.test(e.message) ? 400 : 500;
    return fail(res, code, e.message);
  }
};

const server = http.createServer((req, res) => { handler(req, res); });

if (require.main === module){
  server.listen(PORT, () => {
    console.log(`\nPolitiSABER API  http://localhost:${PORT}`);
    console.log(`  GET  /api/races`);
    console.log(`  GET  /api/races/:id/estimate`);
    console.log(`  POST /api/races/:id/observations`);
    console.log(`  GET  /  （politisaber.html を配信）\n`);
    const ids = pipeline.listRaces();
    console.log(ids.length ? `  レース定義: ${ids.join(', ')}` : '  ⚠ data/races/ にレース定義がありません');
    console.log('');
  });
}

module.exports = { server, handler, PORT };
