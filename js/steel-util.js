// ============================================================
// 鋼材セクション 共通定義 — 拠点・種類・段構成・品名生成・同一性キー
//
// 設計メモ:
// ・絞り込みの「段構成」は STEEL_CATEGORIES の levels にデータとして持つ。
//   種類が増えても、この配列に1行足すだけで対応できる（画面側は触らない）。
// ・品目の同一性は「種類＋材質＋サイズ＋スケジュール」で決まり、
//   それをそのまま Firestore のドキュメントIDにする。
//   CSVを何度取り込んでも二重登録にならないのはこのため。
// ・拠点は SITES に定義。増えても在庫ドキュメントにキーが増えるだけで済む。
// ============================================================

import { num } from './util.js?v=18';

// ---------- 拠点 ----------

export const SITES = [
  { key: 'matsumae', label: '松前工場' },
  { key: 'iyo', label: '伊予工場' },
  { key: 'toho', label: '東方工場' },
];
export const SITE_KEYS = SITES.map((s) => s.key);

export function siteLabel(key) {
  if (key === 'total') return '合計';
  const s = SITES.find((x) => x.key === key);
  return s ? s.label : '';
}

// ---------- 種類と段構成 ----------
// levels: 種類を選んだ後に出すチップの段。並べた順に絞り込み、最後まで選ぶと品目一覧になる。
//   配管   … 材質 → 呼び径 → 品目一覧（Sch違いが並ぶ）
//   樹脂・銅管 … 材質 → サイズ → 品目一覧（塩ビ管・TS継手・銅管継手）
//   アングル・形鋼 … 材質 → 品目一覧（サイズ違いが並ぶ）
//   フランジ … 材質 → 呼び圧力 → 呼び径 → 品目一覧

export const STEEL_CATEGORIES = [
  { key: '配管', label: '配管', levels: ['material', 'size'] },
  { key: '樹脂・銅管', label: '樹脂・銅管', levels: ['material', 'size'] },
  { key: 'フランジ', label: 'フランジ', levels: ['material', 'pressure', 'size'] },
  { key: 'アングル', label: 'アングル', levels: ['material'] },
  { key: '溶接継手', label: '溶接継手', levels: ['material', 'size'] },
  { key: 'ねじ込み継手', label: 'ねじ込み継手', levels: ['material', 'size'] },
  { key: '形鋼', label: '鋼材(平鋼等)', levels: ['material'] },
  { key: 'パッキン', label: 'パッキン', levels: ['material'] },
  { key: 'ボルト', label: 'ボルト', levels: ['material'] },
];

export const CATEGORY_KEYS = STEEL_CATEGORIES.map((c) => c.key);

export function catMeta(key) {
  return STEEL_CATEGORIES.find((c) => c.key === key) || null;
}
export function catLabelOf(key) {
  const m = catMeta(key);
  return m ? m.label : key;
}
export function levelsOf(key) {
  const m = catMeta(key);
  return m ? m.levels : ['material'];
}

// 段のフィールド名 → 見出し（パンくず・空状態の文言に使う）
export const LEVEL_LABEL = {
  material: '材質',
  size: 'サイズ',
  pressure: '呼び圧力',
};

// ---------- 同一性キー（＝ドキュメントID） ----------
// 「種類＋材質＋サイズ＋スケジュール」。Firestore のIDに使えない '/' だけ全角に逃がす。

export function itemKey(r) {
  const part = (v) => String(v == null ? '' : v).trim().replaceAll('/', '／');
  return [part(r.category), part(r.material), part(r.size), part(r.sch)].join('_');
}

// ---------- 表示名・寸法の自動生成 ----------
// CSVで「品名」「寸法表示」が空欄のときに使う（README 6章の生成ルール）

export function genName(r) {
  const material = String(r.material || '').trim();
  const size = String(r.size || '').trim();
  const sch = String(r.sch || '').trim();
  if (r.category === '配管') {
    const m = material === 'SUS304' ? 'SUS304TP' : material;
    return [m, size, sch].filter(Boolean).join(' ');
  }
  // 樹脂・銅管は配管と同じ並び（VP 20 / TS継手 20 / 銅管 20 など）。
  // 種類名を挟むと「VP 樹脂・銅管 20」になって読みにくいため分けている
  if (r.category === '樹脂・銅管') return [material, size, sch].filter(Boolean).join(' ');
  if (r.category === 'アングル') return `${material}アングル ${size}`.trim();
  if (r.category === '形鋼') return `${material}平鋼 ${size}`.trim();
  return [material, r.category, size].filter(Boolean).join(' ');
}

export function genDims(r) {
  const parts = [];
  if (r.od != null && r.t != null) parts.push(`外径${r.od}mm × 肉厚${r.t}mm`);
  else {
    const seg = [];
    if (r.thickness != null) seg.push(`厚${r.thickness}`);
    if (r.width != null) seg.push(`幅${r.width}`);
    if (r.height != null) seg.push(`高${r.height}`);
    if (seg.length) parts.push(seg.join(' × ') + 'mm');
    else if (r.size) parts.push(`${r.size}mm`);
  }
  if (r.length != null) parts.push(`長さ${r.length}mm`);
  return parts.join(' ／ ');
}

// 単位重量の表示（重量単位が空なら kg/m 扱い）
export function unitWeightLabel(r) {
  if (r.unitWeight == null) return '—';
  return `${r.unitWeight} ${r.weightUnit || 'kg/m'}`;
}

// ---------- 在庫の判定 ----------

// 拠点在庫の合計
export function totalQty(s) {
  return SITE_KEYS.reduce((t, k) => t + num(s[k]), 0);
}

// 不足判定: （松前＋伊予＋東方）< 適正在庫
// 適正在庫が未設定(0)のものは不足にしない（カタログ投入直後に全件が赤くなるのを防ぐ）
export function isShort(s) {
  const safety = num(s.safety);
  return safety > 0 && totalQty(s) < safety;
}

// 在庫一覧に出す対象か
export function inStockList(s) {
  return !!s && s.inInventory === true && s.hidden !== true;
}

// ---------- 並び替え ----------
// 「15A → 20A → 100A」「25×3 → 32×4.5」のように先頭の数値を見て並べる。
// 数値が取れないものは文字列比較にフォールバック。

export function compareSize(a, b) {
  const na = parseFloat(String(a).replace(/[^\d.]/, '') || 'NaN');
  const nb = parseFloat(String(b).replace(/[^\d.]/, '') || 'NaN');
  if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b), 'ja');
}

// 品目の並び: 並び順(sortOrder) → サイズ → スケジュール → 品名
export function compareItems(a, b) {
  const oa = a.sortOrder == null ? Number.MAX_SAFE_INTEGER : a.sortOrder;
  const ob = b.sortOrder == null ? Number.MAX_SAFE_INTEGER : b.sortOrder;
  if (oa !== ob) return oa - ob;
  return compareSize(a.size || '', b.size || '')
    || String(a.sch || '').localeCompare(String(b.sch || ''), 'ja')
    || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
}
