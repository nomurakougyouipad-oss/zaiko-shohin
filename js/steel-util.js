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

import { num } from './util.js?v=25';

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
// 全20種類とも 種類 → 材質 → サイズ → 品目一覧 の3段。
//
// ※ key はそのままドキュメントIDの一部になり、CSVの「種類」列と
//   1文字でも違うと別の品目として扱われる。カッコは半角、中黒は「・」。
//   ここを直すときは必ずCSV側と揃えること。

export const STEEL_CATEGORIES = [
  { key: '配管', label: '配管', levels: ['material', 'size'] },
  { key: '角パイプ', label: '角パイプ', levels: ['material', 'size'] },
  { key: '丸パイプ', label: '丸パイプ', levels: ['material', 'size'] },
  { key: 'アングル', label: 'アングル', levels: ['material', 'size'] },
  { key: '平鋼(フラットバー)', label: '平鋼(フラットバー)', levels: ['material', 'size'] },
  { key: '溝形鋼(チャンネル)', label: '溝形鋼(チャンネル)', levels: ['material', 'size'] },
  { key: 'Cチャンネル(軽量)', label: 'Cチャンネル(軽量)', levels: ['material', 'size'] },
  { key: 'H形鋼', label: 'H形鋼', levels: ['material', 'size'] },
  { key: '丸鋼・棒鋼', label: '丸鋼・棒鋼', levels: ['material', 'size'] },
  { key: '鋼板', label: '鋼板', levels: ['material', 'size'] },
  { key: '縞鋼板', label: '縞鋼板', levels: ['material', 'size'] },
  { key: 'エキスパンドメタル', label: 'エキスパンドメタル', levels: ['material', 'size'] },
  { key: 'グレーチング', label: 'グレーチング', levels: ['material', 'size'] },
  { key: 'パンチングメタル', label: 'パンチングメタル', levels: ['material', 'size'] },
  { key: 'フランジ', label: 'フランジ', levels: ['material', 'size'] },
  { key: '溶接継手', label: '溶接継手', levels: ['material', 'size'] },
  { key: 'ねじ込み継手', label: 'ねじ込み継手', levels: ['material', 'size'] },
  { key: 'パッキン', label: 'パッキン', levels: ['material', 'size'] },
  { key: 'ボルト', label: 'ボルト', levels: ['material', 'size'] },
  { key: '樹脂・銅管', label: '樹脂・銅管', levels: ['material', 'size'] },
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
  // アングル・平鋼は材質と種類をくっつけるのが現場の呼び方（SS400アングル 40×40×3）
  if (r.category === 'アングル') return `${material}アングル ${size}`.trim();
  if (String(r.category).startsWith('平鋼')) return `${material}平鋼 ${size}`.trim();
  // 残りは 材質 + 種類 + サイズ（SS400 角パイプ 50×50×2.3 など）。
  // カッコ付きの種類名はカッコ内を落として品名を短くする
  const cat = String(r.category || '').replace(/\(.*?\)/g, '').trim();
  return [material, cat, size].filter(Boolean).join(' ');
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

// ---------- 検索 ----------
// 現場は入力がまちまちなので、比較する前に表記を揃える。
//   ・半角カナ → 全角カタカナ（ｴﾙﾎﾞ → エルボ）
//   ・全角の英数記号 → 半角（２０Ａ → 20a）
//   ・大文字小文字 → 小文字
//   ・ひらがな → カタカナ（えるぼ → エルボ）
//   ・寸法の区切り（× ✕ ＊ *）→ x（3×25 / 3x25 / 3*25 を同じ形にする）
// 空白区切りは searchTerms で AND 条件になる。
// ただし数字だけが並ぶときは dimensionTerm が寸法として組み直す。

// 半角カナ → 全角カタカナ（ｴﾙﾎﾞ → エルボ）。濁点・半濁点は1文字にまとめる。
const HANKAKU_KANA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const ZENKAKU_KANA = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';

function kanaToZenkaku(s) {
  return s
    .replace(/ｳﾞ/g, 'ヴ')
    // 濁点つき（ｶﾞ→ガ）。全角カタカナは清音の次のコードが濁音なので +1 で作れる
    .replace(/([ｶ-ﾄﾊ-ﾎ])ﾞ/g, (_, c) => String.fromCharCode(ZENKAKU_KANA.charCodeAt(HANKAKU_KANA.indexOf(c)) + 1))
    // 半濁点つき（ﾊﾟ→パ）は +2
    .replace(/([ﾊ-ﾎ])ﾟ/g, (_, c) => String.fromCharCode(ZENKAKU_KANA.charCodeAt(HANKAKU_KANA.indexOf(c)) + 2))
    .replace(/[ｦ-ﾝ]/g, (c) => ZENKAKU_KANA[HANKAKU_KANA.indexOf(c)] || c);
}

export function normSearch(s) {
  return kanaToZenkaku(String(s == null ? '' : s))
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .toLowerCase()
    // ひらがな → カタカナ（えるぼ → エルボ）。品名はカタカナ表記なので寄せ先はカタカナ
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[×✕✖*]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

// 検索対象の文字列（品名・材質・サイズ・規格・スケジュール）
export function searchHaystack(r) {
  return normSearch([r.name, r.material, r.size, r.jis, r.sch].filter(Boolean).join(' '));
}

// スペース区切りは AND 条件。「SUS 3×25」で両方を含むものだけに絞る
export function searchTerms(q) {
  return normSearch(q).split(' ').filter(Boolean);
}

export function matchesTerms(hay, terms) {
  for (const t of terms) if (hay.indexOf(t) === -1) return false;
  return true;
}

// 「3 25」のように数字だけの語が2つ以上並んだときは、区切りを空白で打った寸法
// （＝3×25）とみなして 3x25 の形に組み直す。
// 単純なAND条件だと「3」と「25」を別々に含むものまで拾ってしまい、
// 3×25 を探しているのに数百件出てしまうため。
export function dimensionTerm(terms) {
  if (terms.length < 2) return null;
  if (!terms.every((t) => /^[\d.]+$/.test(t))) return null;
  return terms.join('x');
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
