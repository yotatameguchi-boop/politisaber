#!/usr/bin/env python3
"""都道府県選管の開票結果PDFから市町村別得票を抽出する。

    python3 tools/parse_senkan_pdf.py <pdf> --candidates 玉城デニー 佐喜真淳 下地ミキオ \
        [--expect 339767 274844 53677] [--out out.json]

なぜ Python か:
  予測モデル本体は JS（engine.js / livecount.js）で、ブラウザとサーバが同じ実装を
  共有している。そこを二重実装しない方針。一方でこういう「オフラインのデータ抽出」は
  分離された作業で、JS で書く理由がない。README に書いた分担
  （Python でオフライン処理 → JSON → JS が読む）の実例。

なぜ外部ライブラリを使わないか:
  対象PDFは埋め込みフォントの CID エンコーディングで、テキストがグリフ番号のまま
  入っている（<0BE7> Tj のような形）。pdftotext 等が無い環境でも動くよう、
  ToUnicode CMap を自前で読んで復号する。標準ライブラリだけで完結する。

★ --expect を必ず使うこと。
  公表されている全県計と突き合わせて一致しなければ異常終了する。
  この種のパースは「それらしい数字が取れてしまう」のが一番危ない。
"""
import argparse, json, re, sys, zlib


def decompress_streams(data: bytes):
    """PDF 内の全オブジェクトのストリームを展開して返す。"""
    out = {}
    for num, body in re.findall(rb"(\d+)\s+0\s+obj(.*?)endobj", data, re.S):
        m = re.search(rb"stream\r?\n(.*?)\r?\nendstream", body, re.S)
        if not m:
            continue
        raw = m.group(1)
        try:
            out[int(num)] = zlib.decompress(raw)
        except zlib.error:
            out[int(num)] = raw
    return out


def build_cmap(streams):
    """ToUnicode CMap（グリフ番号 → Unicode）を組み立てる。"""
    cmap = {}
    for blob in streams.values():
        if b"beginbfchar" not in blob and b"beginbfrange" not in blob:
            continue
        text = blob.decode("latin1")
        for blk in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
            for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
                cmap[int(src, 16)] = "".join(
                    chr(int(dst[i:i + 4], 16)) for i in range(0, len(dst), 4))
        for blk in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
            for lo, hi, dst in re.findall(
                    r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
                lo, hi, base = int(lo, 16), int(hi, 16), int(dst, 16)
                for i in range(lo, hi + 1):
                    cmap[i] = chr(base + (i - lo))
    return cmap


def decode_text(streams, cmap):
    """内容ストリームのテキスト演算子を復号し、行に組み直す。"""
    lines, cur, cur_y = [], [], None
    for blob in streams.values():
        if b"BT" not in blob or b"Tj" not in blob:
            continue
        content = blob.decode("latin1")
        for tok in re.finditer(
                r"<([0-9A-Fa-f]+)>\s*Tj|[\d.\-]+\s+([\d.\-]+)\s+Tm", content):
            if tok.group(1):
                h = tok.group(1)
                cur.append("".join(
                    cmap.get(int(h[i:i + 4], 16), "") for i in range(0, len(h), 4)))
            elif tok.group(2) is not None:
                y = float(tok.group(2))
                if cur_y is None or abs(y - cur_y) > 2:
                    if cur:
                        lines.append("".join(cur))
                    cur, cur_y = [], y
    if cur:
        lines.append("".join(cur))
    return "\n".join(l for l in lines if l.strip())


NUM = lambda s: int(s.replace(",", ""))
FMT = lambda n: f"{n:,}"


def parse_rows(text, n_cands, max_seq=None):
    """市町村行を抽出する。

    選管PDFの数値列は区切り無しで連結されており（"136,3881,369137,757..."）、
    単純な正規表現では桁を取り違える。そこで
      有効投票 = 候補者得票の合計
    が先頭に来ることを使って自己検証しながら1列ずつ剥がす。
    """
    cand_pat = r"([\d,]+)\.000" * n_cands
    zero_pat = r"(?:0\.000)*"
    pat = re.compile(r"(\d{1,3})([^\d]+?)" + cand_pat + zero_pat + r"([\d,\.]+)")
    name_ok = re.compile(r"^[^\d,]{1,8}[市区町村]$")

    best = {}
    for m in pat.finditer(text):
        seq = int(m.group(1))
        if max_seq and not (1 <= seq <= max_seq):
            continue
        name = re.sub(r"[\s　]", "", m.group(2))
        votes = [NUM(m.group(3 + i)) for i in range(n_cands)]
        valid = sum(votes)
        tail = m.group(3 + n_cands)
        if not tail.startswith(FMT(valid)):
            continue                                  # 有効投票と一致しない＝誤マッチ
        rest = tail[len(FMT(valid)):]
        hit = None
        for L in range(1, 9):                          # 無効投票の桁数を総当たり
            piece = rest[:L]
            if len(rest) < L or piece.endswith(","):
                continue
            try:
                inv = NUM(piece)
            except ValueError:
                continue
            if rest[L:].startswith(FMT(valid + inv)):  # 次が投票総数なら確定
                hit = (inv, valid + inv)
                break
        if not hit:
            continue
        row = dict(seq=seq, name=name, votes=votes,
                   valid=valid, invalid=hit[0], total=hit[1])
        # 数値列からの誤マッチより、市町村名らしい方を優先
        if seq not in best or (name_ok.match(name) and not name_ok.match(best[seq]["name"])):
            best[seq] = row
    return [best[k] for k in sorted(best)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--candidates", nargs="+", required=True,
                    help="PDF の列順に候補者名を並べる")
    ap.add_argument("--expect", nargs="+", type=int,
                    help="公表されている全県計。突き合わせて一致しなければ異常終了する")
    ap.add_argument("--max-seq", type=int, default=None, help="市町村数（小計行の除外に使う）")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    data = open(args.pdf, "rb").read()
    streams = decompress_streams(data)
    cmap = build_cmap(streams)
    if not cmap:
        sys.exit("ToUnicode CMap が見つかりません。このPDFはこの方法では読めません。")
    text = decode_text(streams, cmap)
    rows = parse_rows(text, len(args.candidates), args.max_seq)

    if not rows:
        sys.exit("市町村行を1件も抽出できませんでした。")

    totals = [sum(r["votes"][i] for r in rows) for i in range(len(args.candidates))]
    print(f"抽出 {len(rows)} 市町村", file=sys.stderr)
    for i, c in enumerate(args.candidates):
        line = f"  {c}: {totals[i]:,}"
        if args.expect:
            ok = totals[i] == args.expect[i]
            line += f"  公表 {args.expect[i]:,}  {'一致' if ok else '★不一致'}"
        print(line, file=sys.stderr)

    if args.expect:
        if len(args.expect) != len(args.candidates):
            sys.exit("--expect の数が --candidates と一致しません")
        if totals != args.expect:
            sys.exit("\n公表値と一致しません。抽出が誤っている可能性が高いので中断します。")
        print("  ✓ 全候補が公表値と一致", file=sys.stderr)
    else:
        print("  ⚠ --expect が無いので検証していません。必ず公表値と突き合わせてください。",
              file=sys.stderr)

    out = [dict(name=r["name"],
                votes={c: r["votes"][i] for i, c in enumerate(args.candidates)},
                valid=r["valid"], invalid=r["invalid"], total=r["total"]) for r in rows]
    text_out = json.dumps(out, ensure_ascii=False, indent=1)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text_out)
        print(f"  → {args.out}", file=sys.stderr)
    else:
        print(text_out)


if __name__ == "__main__":
    main()
