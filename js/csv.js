// ============================================================
// CSV 読み書き（鋼材カタログの一括取込・書き出し）
//
// ・文字コードは UTF-8(BOM有無どちらも) / Shift-JIS を自動判定
// ・列は日本語見出しで定義。英語の列名でも受け付ける（別ツールからの出力対策）
// ・重複判定キーは「種類＋材質＋サイズ＋スケジュール」（steel-util の itemKey）
// ・在庫数の列は「空欄＝現在の在庫数を変更しない」。数値が書かれた時だけ上書きする
//   （カタログ情報だけ直したいときに、うっかり在庫を0にしてしまう事故を防ぐ）
// ============================================================

import { CATEGORY_KEYS, itemKey, genName, genDims } from './steel-util.js?v=25';

// ---------- 列定義 ----------
// key    … アプリ内部のフィールド名
// header … CSVの見出し（書き出しでもこの順・この名前で出す）
// type   … 'text' | 'num' | 'bool'
// alias  … 受け付ける別名の見出し

export const COLUMNS = [
  { key: 'code', header: '品目コード', type: 'text', alias: ['code'] },
  { key: 'category', header: '種類', type: 'text', alias: ['category'], required: true },
  { key: 'materialClass', header: '材質区分', type: 'text', alias: ['materialClass'] },
  { key: 'material', header: '材質', type: 'text', alias: ['material'], required: true },
  { key: 'size', header: 'サイズ', type: 'text', alias: ['size'], required: true },
  { key: 'sch', header: 'スケジュール', type: 'text', alias: ['sch', 'schedule'] },
  { key: 'name', header: '品名', type: 'text', alias: ['name'] },
  { key: 'jis', header: '規格', type: 'text', alias: ['jis'] },
  { key: 'od', header: '外径mm', type: 'num', alias: ['od', '外径'] },
  { key: 't', header: '肉厚mm', type: 'num', alias: ['t', '肉厚'] },
  { key: 'thickness', header: '厚みmm', type: 'num', alias: ['thickness', '厚み'] },
  { key: 'width', header: '幅mm', type: 'num', alias: ['width', '幅'] },
  { key: 'height', header: '高さmm', type: 'num', alias: ['height', '高さ'] },
  { key: 'length', header: '長さmm', type: 'num', alias: ['length', '長さ'] },
  { key: 'pressure', header: '呼び圧力', type: 'text', alias: ['pressure'] },
  { key: 'faceType', header: '形式', type: 'text', alias: ['faceType'] },
  { key: 'dims', header: '寸法表示', type: 'text', alias: ['dims'] },
  { key: 'unitWeight', header: '単位重量', type: 'num', alias: ['unitWeight'] },
  { key: 'weightUnit', header: '重量単位', type: 'text', alias: ['weightUnit'] },
  { key: 'unit', header: '単位', type: 'text', alias: ['unit'], required: true },
  { key: 'price', header: '参考単価', type: 'num', alias: ['price'] },
  { key: 'supplier', header: '仕入先', type: 'text', alias: ['supplier'] },
  { key: 'safety', header: '適正在庫', type: 'num', alias: ['safety'] },
  { key: 'sortOrder', header: '並び順', type: 'num', alias: ['sortOrder'] },
  { key: 'inInventory', header: '在庫に登録', type: 'bool', alias: ['inInventory'] },
  { key: 'matsumae', header: '松前工場', type: 'num', alias: ['matsumae'] },
  { key: 'iyo', header: '伊予工場', type: 'num', alias: ['iyo'] },
  { key: 'toho', header: '東方工場', type: 'num', alias: ['toho'] },
  { key: 'location', header: '保管場所', type: 'text', alias: ['location'] },
];

export const HEADER_ROW = COLUMNS.map((c) => c.header);

// カタログ側に保存するフィールド（在庫側の列は除く）
const CATALOG_KEYS = COLUMNS
  .map((c) => c.key)
  .filter((k) => !['inInventory', 'matsumae', 'iyo', 'toho', 'location', 'safety'].includes(k));

// ---------- 文字コード判定つきデコード ----------

export function decodeCsv(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buffer.slice(3)); // UTF-8 BOM付き
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer); // 正しいUTF-8か
  } catch (_) {
    return new TextDecoder('shift_jis').decode(buffer); // 崩れるなら Shift-JIS とみなす
  }
}

// ---------- CSV → 二次元配列 ----------
// 引用符つきセル（カンマ・改行・"" を含む）に対応

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } // "" → " のエスケープ
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // 末尾の空行を落とす
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

// ---------- 見出し行 → 列の対応表 ----------

function mapHeaders(headerCells) {
  const norm = (s) => String(s || '').replace(/^﻿/, '').trim().toLowerCase();
  const index = {};
  const unknown = [];
  headerCells.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const col = COLUMNS.find((c) => norm(c.header) === n || (c.alias || []).some((a) => norm(a) === n));
    if (col) { if (index[col.key] == null) index[col.key] = i; }
    else unknown.push(String(h).trim());
  });
  return { index, unknown };
}

// ---------- 値の変換 ----------

const TRUE_WORDS = ['1', 'true', 'はい', '○', '◯', 'yes', 'y', '要', 'あり'];
const FALSE_WORDS = ['', '0', 'false', 'いいえ', '×', 'no', 'n', 'なし'];

// 全角数字・カンマ区切り・余分な空白を吸収して数値にする
function toNumber(raw) {
  const s = String(raw)
    .replace(/[０-９．－]/g, (c) => '0123456789.-'['０１２３４５６７８９．－'.indexOf(c)])
    .replace(/,/g, '')
    .trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  return isFinite(n) ? { ok: true, value: n } : { ok: false };
}

function toBool(raw) {
  const s = String(raw).trim().toLowerCase();
  if (TRUE_WORDS.includes(s)) return { ok: true, value: true };
  if (FALSE_WORDS.includes(s)) return { ok: true, value: false };
  return { ok: false };
}

// ---------- 取込用のパース ----------
// 戻り値:
//   { rows: [{ line, key, catalog, stock }], errors: [{ line, reason }], unknownHeaders: [] }
// stock.qty は { matsumae: n|null, ... }。null は「変更しない」の意味。

export function parseCatalogCsv(text) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], errors: [{ line: 0, reason: 'ファイルが空です' }], unknownHeaders: [] };

  const { index, unknown } = mapHeaders(table[0]);
  const missing = COLUMNS.filter((c) => c.required && index[c.key] == null).map((c) => c.header);
  if (missing.length) {
    return {
      rows: [], unknownHeaders: unknown,
      errors: [{ line: 1, reason: `必須の列が見つかりません: ${missing.join('・')}` }],
    };
  }

  const rows = [];
  const errors = [];
  const seen = new Map(); // key → 行番号（同じファイル内の重複を検出）

  for (let r = 1; r < table.length; r++) {
    const line = r + 1; // 画面には1始まり（見出し=1行目）の行番号で出す
    const cells = table[r];
    if (cells.every((c) => String(c).trim() === '')) continue; // 空行は読み飛ばす

    const get = (key) => {
      const i = index[key];
      return i == null ? '' : String(cells[i] == null ? '' : cells[i]).trim();
    };

    const rec = {};
    let bad = null;
    for (const col of COLUMNS) {
      const raw = get(col.key);
      if (col.type === 'num') {
        const p = toNumber(raw);
        if (!p.ok) { bad = `「${col.header}」が数値ではありません（${raw}）`; break; }
        rec[col.key] = p.value;
      } else if (col.type === 'bool') {
        const p = toBool(raw);
        if (!p.ok) { bad = `「${col.header}」は 1／0（またははい／いいえ）で入力してください（${raw}）`; break; }
        rec[col.key] = p.value;
      } else {
        rec[col.key] = raw;
      }
    }
    if (bad) { errors.push({ line, reason: bad }); continue; }

    // 必須チェック
    const emptyRequired = COLUMNS.filter((c) => c.required && !String(rec[c.key] || '').trim());
    if (emptyRequired.length) {
      errors.push({ line, reason: `${emptyRequired.map((c) => `「${c.header}」`).join('・')}が空欄です` });
      continue;
    }
    if (!CATEGORY_KEYS.includes(rec.category)) {
      errors.push({ line, reason: `「種類」が対応していない値です（${rec.category}）。使える値: ${CATEGORY_KEYS.join('・')}` });
      continue;
    }

    const key = itemKey(rec);
    if (seen.has(key)) {
      errors.push({ line, reason: `${seen.get(key)}行目と同じ品目です（種類・材質・サイズ・スケジュールが一致）` });
      continue;
    }
    seen.set(key, line);

    // 空欄なら自動生成
    if (!rec.name) rec.name = genName(rec);
    if (!rec.dims) rec.dims = genDims(rec);

    const catalog = {};
    for (const k of CATALOG_KEYS) catalog[k] = rec[k] === '' ? null : rec[k];

    const qty = {};
    let hasQty = false;
    for (const k of ['matsumae', 'iyo', 'toho']) {
      qty[k] = rec[k]; // null なら「変更しない」
      if (rec[k] != null) hasQty = true;
    }

    rows.push({
      line, key, catalog,
      stock: {
        // 在庫数がひとつでも書かれていれば、在庫に登録する意思とみなす
        inInventory: rec.inInventory === true || hasQty,
        explicitInInventory: rec.inInventory === true,
        safety: rec.safety,
        location: rec.location || '',
        qty,
      },
    });
  }

  return { rows, errors, unknownHeaders: unknown };
}

// ---------- 書き出し ----------
// カタログ＋在庫を、取込と同じ列構成の二次元配列にする（downloadCsv にそのまま渡せる）

export function buildCatalogRows(catalogItems, stockById) {
  const out = [HEADER_ROW.slice()];
  for (const c of catalogItems) {
    const s = stockById.get(c.id) || {};
    const v = (x) => (x == null ? '' : x);
    out.push(COLUMNS.map((col) => {
      switch (col.key) {
        case 'inInventory': return s.inInventory ? 1 : 0;
        case 'matsumae': case 'iyo': case 'toho': return s.inInventory ? v(s[col.key] ?? 0) : '';
        case 'safety': return s.inInventory ? v(s.safety) : v(c.safety);
        case 'location': return v(s.location);
        default: return v(c[col.key]);
      }
    }));
  }
  return out;
}
