// ============================================================
// 共通ユーティリティ — 状態判定・金額・日付・CSV・エスケープ
// ============================================================

export const CATEGORIES = ['保護具', '溶接材料', '刃物・砥石', '資材', '清掃用品'];
export const UNITS = ['双', '箱', '袋', '枚', '個', '本', '巻', '組'];
export const ORDER_STATES = ['未発注', '様子見', '発注済'];

export const GREEN = '#0e7a45';
export const ORANGE = '#c77a0b';
export const RED = '#c22b1a';

// 状態判定: stock < min → 要発注 / stock < min*1.5 → 少ない / それ以外 → 十分
export function statusOf(it) {
  const stock = num(it.stock), min = num(it.min);
  if (stock < min) return { status: '要発注', color: RED, bg: 'rgba(194,43,26,.08)', rank: 0 };
  if (stock < min * 1.5) return { status: '少ない', color: ORANGE, bg: 'rgba(199,122,11,.08)', rank: 1 };
  return { status: '十分', color: GREEN, bg: 'transparent', rank: 2 };
}

// 発注推奨数 = max(min*2 - stock, min)
export function recommendQty(it) {
  return Math.max(num(it.min) * 2 - num(it.stock), num(it.min));
}

export function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

export const YEN = (n) => '¥' + Math.round(num(n)).toLocaleString('ja-JP');

// Firestore Timestamp / Date / null → Date か null
export function toDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

const p2 = (n) => String(n).padStart(2, '0');

export function fmtDate(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}

export function fmtDateJa(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${fmtDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtTime(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${fmtDateJa(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 今月・前月の開始日時
export function monthStart(offset = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1);
}

// HTMLエスケープ（ユーザー入力の描画は必ずこれを通す）
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// CSV出力（UTF-8 BOM付き → Excelでそのまま開ける）
export function downloadCsv(filename, rows) {
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// 端末側の記憶（担当者・モード・並び順）
export const local = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('zaiko:' + key); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('zaiko:' + key, value); } catch (_) { /* 無視 */ }
  },
};
