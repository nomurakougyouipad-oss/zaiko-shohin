// ============================================================
// 玄関（スタート画面）— スプラッシュ直後に出る、鋼材／消耗品の入口
//
// ・タイルに「品目数」と「⚠不足◯件」を出す（朝いちの状況ボードとして使う）
// ・下部は横断検索。鋼材と消耗品をまたいで品名で探し、結果から直接詳細へ飛べる
// ・カテゴリが増えたら TILES に1件足すだけで済むようにしてある
//
// 消耗品側のデータは app.js が持っているので、init() で読み出し口を受け取る。
// ============================================================

import * as steel from './steel.js?v=21';
import { esc } from './util.js?v=21';

const H = { q: '' };

let _render = () => {};
let _consumables = { stats: () => ({ total: 0, short: 0, loading: true }), search: () => [] };

export function init({ render, consumables }) {
  _render = render;
  if (consumables) _consumables = consumables;
  bindEvents();
}

export function view() {
  const st = steel.stats();
  const cs = _consumables.stats();

  const tile = (cls, label, s, act) => `
    <button class="home-tile ${cls}" data-hact="${act}">
      <span class="ht-name">${esc(label)}</span>
      <span class="ht-stats">
        <span class="ht-count">${s.loading ? '—' : s.total + '品目'}</span>
        <span class="ht-short${s.short ? ' warn' : ''}">${s.loading ? '' : (s.short ? `⚠不足 ${s.short}件` : '不足なし')}</span>
      </span>
    </button>`;

  const q = H.q.trim();
  let results = '';
  if (q) {
    const rows = [...steel.search(q), ..._consumables.search(q)];
    results = rows.length
      ? `<div class="home-results">${rows.map((r) => `
          <button class="st-row" data-hact="goto" data-hash="${esc(r.hash)}">
            <span>
              <span class="r-name" style="font-size:14px">${esc(r.name)}</span>
              <span class="r-sub" style="display:block;font-size:12px">${esc(r.sub)}</span>
            </span>
            ${r.isShort ? `<span class="st-tag st-tag-accent">不足</span>` : ''}
          </button>`).join('')}</div>`
      : `<div class="home-results"><div class="home-empty">「${esc(q)}」に一致する品目はありません。</div></div>`;
  }

  return `
  <div class="home">
    <div class="home-spacer"></div>

    <div class="home-brand">
      <div class="home-logo">STK</div>
    </div>

    <div class="home-spacer"></div>

    <div class="home-tiles">
      ${tile('steelish', '鋼材', st, 'go-steel')}
      ${tile('greenish', '消耗品', cs, 'go-shohin')}
    </div>

    <div class="home-spacer"></div>

    <div class="home-hr"></div>
    <form class="home-search" data-hform="search">
      <input id="homeq" class="st-input" type="search" name="q" value="${esc(H.q)}"
        placeholder="品名で検索（鋼材・消耗品）" data-hinput="q" autocomplete="off">
    </form>
    ${results}
  </div>`;
}

// ---------- イベント ----------

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-hact]');
    if (!el) return;
    switch (el.dataset.hact) {
      case 'go-steel': steel.enter(); break;
      case 'go-shohin': location.hash = '#/shohin'; break;
      case 'goto': location.hash = el.dataset.hash; break;
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-hinput]');
    if (!el) return;
    if (el.dataset.hinput === 'q') { H.q = el.value; _render(); }
  });

  // 検索欄で Enter を押しても画面が再読み込みされないようにする
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-hform]');
    if (!form) return;
    e.preventDefault();
    const el = document.getElementById('homeq');
    if (el) el.blur(); // スマホのキーボードを閉じる
  });
}
