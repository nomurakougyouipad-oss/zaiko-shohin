// ============================================================
// 鋼材セクション — 画面描画・段階絞り込み・在庫操作・CSV取込
//
// 画面構成:
//   #/steel                 段階絞り込み（種類を選ぶ）
//   #/steel/b/{種類}/{...}   絞り込みの途中／品目一覧
//   #/steel/i/{id}          品目詳細
//   #/steel/set             鋼材の設定（CSV取込・書き出し・非表示品目）
//
// 消耗品側（app.js / store.js）とは状態もコレクションも完全に分けている。
// app.js からは init() → start() → onRoute()/view() の順で呼ばれる。
//
// イベントは data-sact / data-sinput / data-schange / data-sform で受ける。
// （消耗品側の data-act などとは名前を分けてあるので、委譲が衝突しない）
// ============================================================

import * as sstore from './steel-store.js?v=20';
import {
  STEEL_CATEGORIES, SITES, SITE_KEYS,
  catLabelOf, levelsOf, siteLabel,
  totalQty, isShort, inStockList, compareSize, compareItems, unitWeightLabel,
} from './steel-util.js?v=20';
import { esc, num, YEN, fmtDateTime, local, downloadCsv } from './util.js?v=20';
import { parseCatalogCsv, decodeCsv, buildCatalogRows } from './csv.js?v=20';

// ---------- 状態 ----------

const T = {
  stock: null,            // 在庫（常時購読）。null = 読み込み中
  catalog: null,          // カタログ（カタログモードに入ったときだけ読む）
  catalogState: 'idle',   // 'idle' | 'loading' | 'ready' | 'error'

  mode: 'inventory',      // 'inventory'（在庫）| 'catalog'（品目追加）
  site: 'matsumae',       // 表示中の拠点（'total' で合計）
  path: [],               // 絞り込みの選択（[種類, 段1, 段2...]）

  route: { view: 'browse' },
  detailId: null,
  detailSite: 'matsumae',
  detailLogs: [],
  detailUnsub: null,

  add: null,              // 在庫に追加モーダル { id, site, qty }
  imp: null,              // CSV取込モーダル { name, rows, errors, unknownHeaders, summary, running, doneCount }
  del: null,              // 差分削除モーダル { name, targets, keptInStock, errors, csvCount, running, doneCount }
  toastMsg: null,
};

let _render = () => {};
let _toastTimer = null;
let started = false;

export function init({ render }) {
  _render = render;
  bindEvents();
}

// 匿名サインイン完了後に app.js から呼ばれる
export function start() {
  if (started) return;
  started = true;
  sstore.watchStock((rows) => { T.stock = rows; _render(); },
    (e) => { console.error('鋼材在庫の購読エラー:', e); T.stock = []; _render(); });
}

function toast(msg, ms = 2200) {
  T.toastMsg = msg;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { T.toastMsg = null; _render(); }, ms);
  _render();
}

const person = () => local.get('person', '');
const isOffice = () => local.get('mode', 'office') === 'office';

// ---------- ルーティング ----------

// app.js から呼ばれる。鋼材のハッシュなら true を返す。
export function onRoute(hash) {
  if (!/^#\/steel(\/|$)/.test(hash)) return false;

  const rest = hash.replace(/^#\/steel\/?/, '');
  const seg = rest ? rest.split('/').map((s) => decodeURIComponent(s)) : [];

  if (seg[0] === 'i' && seg[1]) T.route = { view: 'item', id: seg.slice(1).join('/') };
  else if (seg[0] === 'set') T.route = { view: 'settings' };
  else if (seg[0] === 'b') { T.route = { view: 'browse' }; T.path = seg.slice(1).filter((s) => s !== ''); }
  else { T.route = { view: 'browse' }; T.path = []; }

  // 品目詳細の履歴購読を張り替え
  const wantId = T.route.view === 'item' ? T.route.id : null;
  if (wantId !== T.detailId) {
    if (T.detailUnsub) { T.detailUnsub(); T.detailUnsub = null; }
    T.detailId = wantId;
    T.detailLogs = [];
    if (wantId) {
      T.detailUnsub = sstore.watchItemLogs(wantId, (rows) => { T.detailLogs = rows; _render(); },
        (e) => console.error('鋼材履歴の購読エラー:', e));
      // 直接開かれた・カタログ側の品目のときはカタログが要る
      const inStock = (T.stock || []).some((s) => s.id === wantId);
      if (!inStock) ensureCatalog();
    }
  }
  return true;
}

// 玄関から鋼材に入るときの初期化（在庫モード・絞り込みなしに戻す）
export function enter() {
  T.mode = 'inventory';
  T.path = [];
  T.site = 'matsumae';
  location.hash = '#/steel';
}

function goPath(path) {
  const p = path.filter((s) => s != null && s !== '');
  location.hash = p.length ? '#/steel/b/' + p.map(encodeURIComponent).join('/') : '#/steel';
}

// ---------- カタログの遅延読み込み ----------

function ensureCatalog() {
  if (T.catalogState === 'loading' || T.catalogState === 'ready') return;
  T.catalogState = 'loading';
  _render();
  sstore.loadCatalog()
    .then((rows) => { T.catalog = rows; T.catalogState = 'ready'; _render(); })
    .catch((e) => {
      console.error('カタログの読み込みに失敗:', e);
      T.catalog = []; T.catalogState = 'error'; _render();
    });
}

// ---------- データの組み立て ----------

function stockMap() {
  return new Map((T.stock || []).map((s) => [s.id, s]));
}

// 現在のモードで対象になる品目の一覧
function records() {
  if (T.mode === 'inventory') {
    return (T.stock || []).filter(inStockList);
  }
  const byId = stockMap();
  return (T.catalog || []).map((c) => {
    const s = byId.get(c.id);
    return { ...c, ...(s || {}), id: c.id, inInventory: !!(s && s.inInventory) };
  });
}

// 単一品目を引く（在庫 → カタログの順に探す）
function findRecord(id) {
  const s = (T.stock || []).find((x) => x.id === id);
  const c = (T.catalog || []).find((x) => x.id === id);
  if (s && c) return { ...c, ...s, id, inInventory: !!s.inInventory };
  if (s) return { ...s, inInventory: !!s.inInventory };
  if (c) return { ...c, inInventory: false };
  return null;
}

// 絞り込みの現在地に該当する品目
function scopedRecords() {
  const all = records();
  const cat = T.path[0];
  if (!cat) return all;
  const levels = levelsOf(cat);
  const chosen = T.path.slice(1);
  return all.filter((r) => {
    if ((r.category || '') !== cat) return false;
    for (let i = 0; i < chosen.length && i < levels.length; i++) {
      if (String(r[levels[i]] || '') !== chosen[i]) return false;
    }
    return true;
  });
}

const shortCountOf = (list) => (T.mode === 'inventory' ? list.filter(isShort).length : 0);

function displayQty(r) {
  if (T.site === 'total') return totalQty(r);
  return num(r[T.site]);
}

// ---------- 共通パーツ ----------

const ICON_HOME = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path></svg>`;
const ICON_BACK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"></path></svg>`;
const ICON_GEAR = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"></circle><path d="M12 2.8v2.4M12 18.8v2.4M4.5 4.5l1.7 1.7M17.8 17.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.5 19.5l1.7-1.7M17.8 6.2l1.7-1.7"></path></svg>`;
const ICON_X = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"></path></svg>`;

function header({ title, back = null, gear = false }) {
  return `
  <div class="st-header">
    ${back ? `<button class="st-hbtn" data-sact="${back}" aria-label="もどる">${ICON_BACK}<span>もどる</span></button>` : ''}
    <button class="st-hbtn icon" data-sact="home" aria-label="ホーム">${ICON_HOME}</button>
    <div class="st-title">${esc(title)}</div>
    ${gear ? `<div class="st-right"><button class="st-hbtn icon" data-sact="goto-settings" aria-label="鋼材の設定">${ICON_GEAR}</button></div>` : ''}
  </div>`;
}

function toastHtml() {
  return T.toastMsg ? `<div class="st-toast">${esc(T.toastMsg)}</div>` : '';
}

// ---------- 画面: 段階絞り込み・一覧 ----------

function viewBrowse() {
  const cat = T.path[0];
  const levels = cat ? levelsOf(cat) : [];
  const chosen = T.path.slice(1);
  const scoped = scopedRecords();
  const loading = T.mode === 'inventory' ? T.stock === null : T.catalogState === 'loading';

  // ---- チップ（種類 or 段） ----
  let chips = '';
  let showList = false;

  if (!cat) {
    const all = records();
    chips = STEEL_CATEGORIES.map((m) => {
      const subset = all.filter((r) => (r.category || '') === m.key);
      return chip(m.label, subset.length, shortCountOf(subset), false,
        subset.length ? `sact="pick" data-v="${esc(m.key)}" data-lv="0"` : null);
    }).join('');
  } else if (chosen.length < levels.length) {
    const field = levels[chosen.length];
    const values = Array.from(new Set(scoped.map((r) => String(r[field] || '')).filter(Boolean)))
      .sort(compareSize);
    chips = values.map((v) => {
      const subset = scoped.filter((r) => String(r[field] || '') === v);
      return chip(v, subset.length, shortCountOf(subset), false,
        `sact="pick" data-v="${esc(v)}" data-lv="${chosen.length + 1}"`);
    }).join('');
    if (!values.length) showList = true; // その段の値が無い＝これ以上絞れない
  } else {
    showList = true;
  }

  // ---- 品目一覧 ----
  let list = '';
  if (showList) {
    const items = scoped.slice().sort(compareItems);
    list = items.length
      ? `<div class="st-list">${items.map(rowHtml).join('')}</div>`
      : `<div class="st-empty">該当する品目がありません。</div>`;
  }

  // ---- パンくず ----
  const crumbs = [`<button class="st-crumb" data-sact="crumb" data-n="0">鋼材</button>`];
  T.path.forEach((v, i) => {
    const label = i === 0 ? catLabelOf(v) : v;
    const last = i === T.path.length - 1;
    crumbs.push(`<span class="sep">&gt;</span>`);
    crumbs.push(last
      ? `<button class="st-crumb" disabled>${esc(label)}</button>`
      : `<button class="st-crumb" data-sact="crumb" data-n="${i + 1}">${esc(label)}</button>`);
  });

  const emptyState = emptyStateHtml();

  return `
  <div class="steel">
    ${header({
      title: T.mode === 'inventory' ? '在庫を見る' : '品目を追加',
      back: T.path.length ? 'back-level' : null,
      gear: true,
    })}
    <div class="st-body">
      <div style="padding-top:12px">
        <button class="st-btn st-btn-block" data-sact="toggle-mode">
          ${T.mode === 'inventory' ? '＋ 品目追加' : '在庫一覧に戻る'}
        </button>
      </div>

      ${T.mode === 'inventory' ? siteSegHtml() : ''}

      <div class="st-crumbs">${crumbs.join('')}</div>

      ${loading
        ? `<div class="st-empty">読み込んでいます…</div>`
        : emptyState || `<div class="st-panel">${chips ? `<div class="st-chips">${chips}</div>` : ''}${list}</div>`}
    </div>
  </div>`;
}

function chip(label, count, short, on, actAttr) {
  const dis = actAttr ? '' : 'disabled';
  return `
  <button class="st-chip${on ? ' on' : ''}" ${dis} ${actAttr ? 'data-' + actAttr : ''}>
    <span>${esc(label)}</span>
    <span class="c-sub">
      <span class="c-n">${count}</span>
      ${short ? `<span class="c-short">⚠${short}</span>` : ''}
    </span>
  </button>`;
}

function rowHtml(r) {
  const short = T.mode === 'inventory' && isShort(r);
  const sub = [r.jis, r.sch].filter(Boolean).join(' ／ ');
  return `
  <button class="st-row" data-sact="open-item" data-id="${esc(r.id)}">
    <span>
      <span class="r-name">${esc(r.name || r.id)}</span>
      ${sub ? `<span class="r-sub" style="display:block">${esc(sub)}</span>` : ''}
    </span>
    <span class="r-right">
      ${T.mode === 'inventory' ? `<span class="r-qty">${displayQty(r)}${esc(r.unit || '')}</span>` : ''}
      ${short ? `<span class="st-tag st-tag-accent">不足</span>` : ''}
      ${T.mode === 'catalog' && !r.inInventory ? `<span class="st-tag st-tag-outline">未登録</span>` : ''}
    </span>
  </button>`;
}

function siteSegHtml() {
  const opts = [...SITES.map((s) => s.key), 'total'];
  return `
  <div class="st-seg" style="margin-top:12px">
    ${opts.map((k) => `
      <button class="st-seg-opt${T.site === k ? ' on' : ''}" data-sact="set-site" data-site="${k}">${esc(siteLabel(k))}</button>
    `).join('')}
  </div>`;
}

// カタログ未投入・在庫ゼロのときの案内
function emptyStateHtml() {
  if (T.mode === 'catalog') {
    if (T.catalogState === 'error') {
      return `<div class="st-empty">カタログを読み込めませんでした。電波状況を確認して、画面を開き直してください。</div>`;
    }
    if (T.catalogState === 'ready' && !(T.catalog || []).length) {
      return `<div class="st-empty">
        品目カタログがまだ空です。<br><br>
        ${isOffice()
          ? `右上の設定（⚙）から <strong>CSV取込</strong> でカタログを投入してください。<br>
             <button class="st-btn st-btn-primary" style="margin-top:16px" data-sact="goto-settings">鋼材の設定を開く</button>`
          : `事務所モードでCSV取込を行ってください。`}
      </div>`;
    }
    return '';
  }
  if (T.stock !== null && !(T.stock || []).filter(inStockList).length) {
    return `<div class="st-empty">
      在庫に登録された鋼材がまだありません。<br><br>
      上の「＋ 品目追加」からカタログを絞り込んで、扱う品目を在庫に追加してください。
    </div>`;
  }
  return '';
}

// ---------- 画面: 品目詳細 ----------

function viewItem() {
  const r = findRecord(T.route.id);
  if (!r) {
    const loading = T.stock === null || T.catalogState === 'loading';
    return `<div class="steel">${header({ title: '品目', back: 'back-browse' })}
      <div class="st-empty">${loading ? '読み込んでいます…' : 'この品目は見つかりませんでした。'}</div></div>`;
  }

  const inStock = !!r.inInventory;
  const short = inStock && isShort(r);
  const site = T.detailSite;
  const qty = num(r[site]);

  const logs = T.detailLogs.slice(0, 20).map((l) => `
    <div class="h-row">
      <span class="st-tag ${l.qty >= 0 ? 'st-tag-neutral' : 'st-tag-outline'}">${esc(l.kind)}</span>
      <span class="h-qty">${l.qty > 0 ? '+' : ''}${l.qty}${esc(r.unit || '')}</span>
      <span>${esc(l.site ? siteLabel(l.site) : '')}</span>
      <span class="h-meta">${esc(fmtDateTime(l.at))}${l.person ? '<br>' + esc(l.person) : ''}</span>
    </div>`).join('');

  return `
  <div class="steel">
    ${header({ title: '品目詳細', back: 'back-browse' })}
    <div class="st-detail">
      <div>
        <div class="d-name">${esc(r.name || r.id)}</div>
        <div class="d-tags">
          <span class="st-tag st-tag-neutral">${esc(catLabelOf(r.category))}</span>
          <span class="st-tag st-tag-outline">${esc(r.material || '')}</span>
          ${!inStock ? `<span class="st-tag st-tag-outline">未登録</span>` : ''}
        </div>
      </div>

      <div class="st-card">
        <div class="st-card-title">仕様</div>
        <div class="st-kv"><span>規格</span><span>${esc(r.jis || '—')}</span></div>
        <div class="st-kv"><span>寸法</span><span>${esc(r.dims || '—')}</span></div>
        <div class="st-kv"><span>単位重量</span><span>${esc(unitWeightLabel(r))}</span></div>
        <div class="st-kv"><span>参考単価</span><span>${r.price != null ? esc(YEN(r.price)) + ' / ' + esc(r.unit || '') : '—'}</span></div>
        <div class="st-kv"><span>仕入先</span><span>${esc(r.supplier || '—')}</span></div>
        <div class="st-kv"><span>適正在庫</span><span>${inStock ? num(r.safety) + esc(r.unit || '') : '—'}</span></div>
        ${inStock && r.location ? `<div class="st-kv"><span>保管場所</span><span>${esc(r.location)}</span></div>` : ''}
      </div>

      ${inStock ? `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div class="st-label">拠点在庫</div>
          <div class="st-seg">
            ${SITES.map((s) => `
              <button class="st-seg-opt${site === s.key ? ' on' : ''}" data-sact="detail-site" data-site="${s.key}">${esc(s.label)}</button>
            `).join('')}
          </div>
          <div class="st-card" style="display:flex;flex-direction:column;gap:12px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div style="font-weight:700;font-size:14px">${esc(siteLabel(site))}</div>
              <div class="st-qty-big">${qty}${esc(r.unit || '')}</div>
            </div>
            <div class="st-steps st-office-only">
              <button class="st-stepbtn" data-sact="adj" data-n="-1">−1</button>
              <button class="st-stepbtn" data-sact="adj" data-n="1">+1</button>
              <button class="st-stepbtn" data-sact="adj" data-n="5">+5</button>
              <button class="st-stepbtn" data-sact="adj" data-n="10">+10</button>
            </div>
            <div style="font-size:12px;color:var(--st-n700)">
              3拠点の合計 ${totalQty(r)}${esc(r.unit || '')}
            </div>
          </div>
          ${short ? `<div class="st-warn">⚠ 不足：適正在庫を下回っています（発注対象）</div>` : ''}
        </div>

        <div class="st-office-only" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="st-btn" data-sact="edit-safety" style="flex:1">適正在庫を変更</button>
          <button class="st-btn" data-sact="toggle-hidden" style="flex:1">
            ${r.hidden ? '一覧に再表示する' : '一覧から非表示にする'}
          </button>
        </div>

        <div>
          <div class="st-label">入出庫の履歴</div>
          <div class="st-hist">${logs || '<div class="st-empty" style="padding:16px">まだ記録がありません。</div>'}</div>
        </div>
      ` : `
        <button class="st-btn st-btn-primary st-btn-block st-office-only" data-sact="open-add" data-id="${esc(r.id)}">
          在庫に追加する
        </button>
        <div class="st-note">在庫に追加すると、在庫一覧に表示され発注対象になります。</div>
      `}
    </div>
  </div>`;
}

// ---------- 画面: 鋼材の設定 ----------

function viewSettings() {
  const hidden = (T.stock || []).filter((s) => s.inInventory && s.hidden);
  const stockCount = (T.stock || []).filter(inStockList).length;
  const catCount = T.catalogState === 'ready' ? (T.catalog || []).length : null;

  return `
  <div class="steel">
    ${header({ title: '鋼材の設定', back: 'back-browse' })}
    <div class="st-body" style="padding-top:18px;display:flex;flex-direction:column;gap:16px">

      <div class="st-card">
        <div class="st-card-title">データの状況</div>
        <div class="st-kv"><span>カタログの品目数</span><span>${catCount == null ? '（未読込）' : catCount + ' 件'}</span></div>
        <div class="st-kv"><span>在庫に出している品目</span><span>${stockCount} 件</span></div>
        <div class="st-kv"><span>非表示にした品目</span><span>${hidden.length} 件</span></div>
      </div>

      <div class="st-card st-office-only">
        <div class="st-card-title">CSV一括取込</div>
        <div class="st-note" style="margin:0 0 12px">
          品目カタログをまとめて登録・更新します。文字コードは UTF-8 / Shift-JIS のどちらでも読み込めます。<br>
          同じ品目（種類・材質・サイズ・スケジュールが一致）は二重登録されず、上書き更新されます。
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="st-btn st-btn-primary st-btn-block" data-sact="pick-csv">CSVファイルを選ぶ</button>
          <button class="st-btn st-btn-block" data-sact="export-csv">現在の品目をCSVに書き出す</button>
          <button class="st-btn st-btn-block" data-sact="export-template">取込用テンプレート（見出しのみ）を書き出す</button>
        </div>
      </div>

      <div class="st-card st-office-only">
        <div class="st-card-title">差分削除（取込に無い品目を消す）</div>
        <div class="st-note" style="margin:0 0 12px">
          CSVに含まれない品目をカタログから削除します。<br>
          品目の見分けは「種類・材質・サイズ・スケジュール」で行うため、この4項目をCSV側で直すと
          古い品目がカタログに取り残されます。その掃除に使います。<br>
          <strong>在庫に出している品目は削除しません。</strong>
        </div>
        <button class="st-btn st-btn-danger st-btn-block" data-sact="pick-diff">CSVを選んで差分削除</button>
      </div>

      ${!isOffice() ? `<div class="st-warn">現場モードのため、CSV取込などの編集操作は使えません。設定から事務所モードに切り替えてください。</div>` : ''}

      <div class="st-card">
        <div class="st-card-title">非表示にした品目（${hidden.length}件）</div>
        ${hidden.length ? `<div class="st-list" style="border-top:none">
          ${hidden.sort(compareItems).map((s) => `
            <div class="st-row" style="cursor:default">
              <span>
                <span class="r-name">${esc(s.name || s.id)}</span>
                <span class="r-sub" style="display:block">合計 ${totalQty(s)}${esc(s.unit || '')}</span>
              </span>
              <span class="r-right">
                <button class="st-btn" data-sact="unhide" data-id="${esc(s.id)}" style="min-height:40px;padding:8px 12px;font-size:13px">再表示</button>
              </span>
            </div>`).join('')}
        </div>` : `<div class="st-note" style="margin:0">ありません。品目詳細から非表示にすると、ここに集まります。</div>`}
      </div>

    </div>
  </div>`;
}

// ---------- モーダル: 在庫に追加 ----------

function addModalHtml() {
  if (!T.add) return '';
  const r = findRecord(T.add.id);
  if (!r) return '';
  return `
  <div class="st-modal-back" data-sact="close-add">
    <div class="st-modal" data-sstop>
      <div class="st-modal-head">
        <div class="m-title">在庫に追加</div>
        <button class="st-modal-x" data-sact="close-add" aria-label="閉じる">${ICON_X}</button>
      </div>
      <div class="rows">
        <div>
          <div style="font-weight:800;font-size:17px">${esc(r.name || r.id)}</div>
          <div style="font-size:12px;color:var(--st-n700);margin-top:4px">${esc([r.jis, r.dims].filter(Boolean).join(' ／ '))}</div>
        </div>
        <div>
          <div class="st-label">拠点</div>
          <div class="st-seg">
            ${SITES.map((s) => `
              <button class="st-seg-opt${T.add.site === s.key ? ' on' : ''}" data-sact="add-site" data-site="${s.key}">${esc(s.label)}</button>
            `).join('')}
          </div>
        </div>
        <div>
          <div class="st-label">数量</div>
          <div class="st-qty-row">
            <button class="st-stepbtn" data-sact="add-qty" data-n="-1">−1</button>
            <div class="st-qty-value">${T.add.qty}${esc(r.unit || '')}</div>
            <button class="st-stepbtn" data-sact="add-qty" data-n="1">+1</button>
            <button class="st-stepbtn" data-sact="add-qty" data-n="5">+5</button>
            <button class="st-stepbtn" data-sact="add-qty" data-n="10">+10</button>
          </div>
        </div>
        <button class="st-btn st-btn-primary st-btn-block" data-sact="commit-add">在庫に追加する</button>
      </div>
    </div>
  </div>`;
}

// ---------- モーダル: CSV取込プレビュー ----------

function importModalHtml() {
  if (!T.imp) return '';
  const i = T.imp;
  const s = i.summary || { created: 0, updated: 0, stockRows: 0 };
  const okCount = i.rows.length;

  return `
  <div class="st-modal-back" data-sact="close-imp">
    <div class="st-modal" data-sstop>
      <div class="st-modal-head">
        <div class="m-title">CSV取込の確認</div>
        <button class="st-modal-x" data-sact="close-imp" aria-label="閉じる">${ICON_X}</button>
      </div>
      <div class="rows">
        <div style="font-size:13px;color:var(--st-n700)">${esc(i.name)}</div>

        <div class="st-prev">
          <div class="p-box"><div class="p-n">${s.created}</div><div class="p-l">新規</div></div>
          <div class="p-box"><div class="p-n">${s.updated}</div><div class="p-l">更新</div></div>
          <div class="p-box${i.errors.length ? ' err' : ''}"><div class="p-n">${i.errors.length}</div><div class="p-l">エラー</div></div>
        </div>

        ${s.stockRows ? `<div class="st-note" style="margin:0">うち ${s.stockRows} 件は在庫数の指定があります（空欄の拠点は現在の在庫数のまま）。</div>` : ''}

        ${i.unknownHeaders.length ? `
          <div class="st-note" style="margin:0">
            見出しが一致しない列は読み飛ばします: ${esc(i.unknownHeaders.join('、'))}
          </div>` : ''}

        ${i.errors.length ? `
          <div>
            <div class="st-label">エラー行（取り込まれません）</div>
            <div class="st-errlist">
              ${i.errors.slice(0, 200).map((e) => `<div>${e.line}行目: ${esc(e.reason)}</div>`).join('')}
              ${i.errors.length > 200 ? `<div>…ほか ${i.errors.length - 200} 件</div>` : ''}
            </div>
          </div>` : ''}

        ${i.running
          ? `<div class="st-note" style="margin:0">取り込んでいます… ${i.doneCount} / ${okCount}</div>`
          : `<div style="display:flex;flex-direction:column;gap:8px">
              <button class="st-btn st-btn-primary st-btn-block" data-sact="commit-imp" ${okCount ? '' : 'disabled'}>
                ${okCount ? `正常な ${okCount} 件を取り込む` : '取り込める行がありません'}
              </button>
              <button class="st-btn st-btn-block" data-sact="close-imp">中止する</button>
            </div>`}
      </div>
    </div>
  </div>`;
}

// ---------- モーダル: 差分削除の確認 ----------

function diffModalHtml() {
  if (!T.del) return '';
  const d = T.del;
  const n = d.targets.length;
  // エラー行がある状態で消すと、その品目まで「CSVに無い」と判定されてしまう
  const blocked = d.errors.length > 0;

  return `
  <div class="st-modal-back" data-sact="close-del">
    <div class="st-modal" data-sstop>
      <div class="st-modal-head">
        <div class="m-title">差分削除の確認</div>
        <button class="st-modal-x" data-sact="close-del" aria-label="閉じる">${ICON_X}</button>
      </div>
      <div class="rows">
        <div style="font-size:13px;color:var(--st-n700)">${esc(d.name)}</div>

        <div class="st-prev">
          <div class="p-box${n ? ' err' : ''}"><div class="p-n">${n}</div><div class="p-l">削除する</div></div>
          <div class="p-box"><div class="p-n">${d.keptInStock.length}</div><div class="p-l">在庫のため除外</div></div>
          <div class="p-box"><div class="p-n">${d.csvCount}</div><div class="p-l">CSVの品目</div></div>
        </div>

        ${blocked ? `
          <div class="st-warn">
            このCSVには取込エラーが ${d.errors.length} 件あります。<br>
            エラー行の品目まで「CSVに無い」と判定して消してしまうため、差分削除は実行できません。
            先にCSVのエラーを直してください。
          </div>` : ''}

        ${d.keptInStock.length ? `
          <div class="st-note" style="margin:0">
            在庫に出している ${d.keptInStock.length} 件は、CSVに無くても削除しません。
            不要なら品目詳細から非表示にしてください。
          </div>` : ''}

        ${n ? `
          <div>
            <div class="st-label">削除する品目</div>
            <div class="st-errlist">
              ${d.targets.slice(0, 200).map((c) => `<div>${esc(c.name || c.id)}</div>`).join('')}
              ${n > 200 ? `<div>…ほか ${n - 200} 件</div>` : ''}
            </div>
          </div>` : `<div class="st-note" style="margin:0">CSVに無い品目はありません。削除するものはありません。</div>`}

        ${d.running
          ? `<div class="st-note" style="margin:0">削除しています… ${d.doneCount} / ${n}</div>`
          : `<div style="display:flex;flex-direction:column;gap:8px">
              <button class="st-btn st-btn-danger st-btn-block" data-sact="commit-del" ${n && !blocked ? '' : 'disabled'}>
                ${n && !blocked ? `${n} 件を削除する` : '削除できる品目がありません'}
              </button>
              <button class="st-btn st-btn-block" data-sact="close-del">中止する</button>
            </div>`}
      </div>
    </div>
  </div>`;
}

// ---------- PC版（左ツリー＋表） ----------

function viewPc() {
  const all = records();
  const scoped = scopedRecords().slice().sort(compareItems);
  const cat = T.path[0];

  // ツリー（種類 → 段1 → 段2）を段構成の定義から組み立てる
  const tree = STEEL_CATEGORIES.map((m) => {
    const subset = all.filter((r) => (r.category || '') === m.key);
    const open = cat === m.key;
    const levels = levelsOf(m.key);
    let sub = '';
    if (open && levels.length) {
      const f1 = levels[0];
      const v1s = Array.from(new Set(subset.map((r) => String(r[f1] || '')).filter(Boolean))).sort(compareSize);
      sub = `<div class="st-tree-sub">${v1s.map((v1) => {
        const s1 = subset.filter((r) => String(r[f1] || '') === v1);
        const open1 = T.path[1] === v1;
        let sub2 = '';
        if (open1 && levels.length > 1) {
          const f2 = levels[1];
          const v2s = Array.from(new Set(s1.map((r) => String(r[f2] || '')).filter(Boolean))).sort(compareSize);
          sub2 = `<div class="st-tree-sub">${v2s.map((v2) => {
            const s2 = s1.filter((r) => String(r[f2] || '') === v2);
            return treeRow(v2, s2, T.path[2] === v2 ? 'on-3' : '', [m.key, v1, v2]);
          }).join('')}</div>`;
        }
        return treeRow(v1, s1, open1 && !T.path[2] ? 'on-2' : '', [m.key, v1]) + sub2;
      }).join('')}</div>`;
    }
    return treeRow(m.label, subset, open && !T.path[1] ? 'on' : '', [m.key], subset.length === 0) + sub;
  }).join('');

  const crumbs = [`<button class="st-crumb" data-sact="crumb" data-n="0">鋼材</button>`];
  T.path.forEach((v, i) => {
    const label = i === 0 ? catLabelOf(v) : v;
    crumbs.push(`<span class="sep">&gt;</span>`);
    crumbs.push(i === T.path.length - 1
      ? `<button class="st-crumb" disabled>${esc(label)}</button>`
      : `<button class="st-crumb" data-sact="crumb" data-n="${i + 1}">${esc(label)}</button>`);
  });

  const rows = scoped.map((r) => `
    <tr data-sact="open-item" data-id="${esc(r.id)}">
      <td style="font-weight:700">${esc(r.name || r.id)}</td>
      <td style="color:var(--st-n700);font-size:13px">${esc(r.jis || '')}</td>
      ${SITE_KEYS.map((k) => `<td class="num">${T.mode === 'inventory' ? num(r[k]) + esc(r.unit || '') : '—'}</td>`).join('')}
      <td>
        ${T.mode === 'inventory' && isShort(r) ? `<span class="st-tag st-tag-accent">不足</span>` : ''}
        ${T.mode === 'catalog' && !r.inInventory ? `<span class="st-tag st-tag-outline">未登録</span>` : ''}
      </td>
    </tr>`).join('');

  const empty = emptyStateHtml();

  return `
  <div class="steel">
    <div class="st-header">
      <button class="st-hbtn icon" data-sact="home" aria-label="ホーム">${ICON_HOME}</button>
      <div style="font-weight:800;font-size:20px;margin-left:8px">鋼材在庫</div>
      <div class="st-right">
        <button class="st-hbtn" data-sact="toggle-mode">${T.mode === 'inventory' ? '＋ 品目追加モード' : '在庫一覧モードに戻る'}</button>
        <button class="st-hbtn icon" data-sact="goto-settings" aria-label="鋼材の設定">${ICON_GEAR}</button>
      </div>
    </div>
    <div class="st-pc">
      <div class="st-tree">
        <div class="st-tree-head">
          <span class="t-label">絞り込み</span>
          <button class="st-crumb" data-sact="crumb" data-n="0" style="font-size:12px">全解除</button>
        </div>
        ${tree}
      </div>
      <div class="st-main">
        <div class="st-main-head">
          <div class="st-crumbs" style="padding:0">${crumbs.join('')}</div>
          <div class="st-counts">
            <span>${scoped.length}品目</span>
            ${T.mode === 'inventory' ? `<span class="warn">⚠不足 ${scoped.filter(isShort).length}件</span>` : ''}
          </div>
        </div>
        ${empty || `
        <div class="st-table-wrap">
          <table class="st-table">
            <thead><tr>
              <th>品目</th><th>規格</th>
              ${SITES.map((s) => `<th class="num" style="text-align:right">${esc(s.label)}</th>`).join('')}
              <th>状態</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${scoped.length ? '' : `<div class="st-empty">該当する品目がありません。</div>`}
        </div>`}
      </div>
    </div>
  </div>`;
}

function treeRow(label, subset, cls, path, disabled = false) {
  const short = shortCountOf(subset);
  return `
  <button class="st-tree-row ${cls}" ${disabled ? 'disabled' : `data-sact="tree" data-path="${esc(JSON.stringify(path))}"`}>
    <span>${esc(label)}</span>
    <span style="display:flex;align-items:center;gap:6px">
      <span class="t-n">${subset.length}</span>
      ${short ? `<span class="t-short">⚠${short}</span>` : ''}
    </span>
  </button>`;
}

// ---------- 描画の入口（app.js から呼ばれる） ----------

export function view() {
  let sp, pc;
  if (T.route.view === 'item') { sp = viewItem(); pc = viewItem(); }
  else if (T.route.view === 'settings') { sp = viewSettings(); pc = viewSettings(); }
  else { sp = viewBrowse(); pc = viewPc(); }

  // ファイル入力はスマホ版・PC版の外に1つだけ置く。
  // 画面本体は .st-sp と .st-pc-only に2回描画されるため、この中に入れると
  // 同じ id の要素が2つでき、getElementById が非表示側を掴んでしまう。
  return `
    <div class="st-sp">${sp}</div>
    <div class="st-pc-only">${pc}</div>
    <input type="file" id="st-csv-file" accept=".csv,text/csv" data-schange="csv-file" style="display:none">
    <input type="file" id="st-diff-file" accept=".csv,text/csv" data-schange="diff-file" style="display:none">
    ${addModalHtml()}
    ${importModalHtml()}
    ${diffModalHtml()}
    ${toastHtml()}`;
}

// 玄関のタイル用（品目数・不足件数）
export function stats() {
  const list = (T.stock || []).filter(inStockList);
  return { total: list.length, short: list.filter(isShort).length, loading: T.stock === null };
}

// 玄関の横断検索用（在庫にある鋼材から品名で探す）
export function search(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return (T.stock || []).filter(inStockList)
    .filter((r) => (String(r.name || '') + String(r.material || '') + String(r.size || '') + String(r.supplier || ''))
      .toLowerCase().includes(s))
    .sort(compareItems)
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      name: r.name || r.id,
      sub: '鋼材 ／ ' + [r.jis, `合計 ${totalQty(r)}${r.unit || ''}`].filter(Boolean).join(' ／ '),
      isShort: isShort(r),
      hash: '#/steel/i/' + encodeURIComponent(r.id),
    }));
}

// ---------- イベント ----------

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-sact]');
    if (!el) return;
    // モーダルの中身をクリックしたときに背景の「閉じる」が反応しないように
    const act = el.dataset.sact;
    if ((act === 'close-add' || act === 'close-imp' || act === 'close-del')
      && e.target.closest('[data-sstop]') && el.matches('.st-modal-back')) return;

    const id = el.dataset.id;

    switch (act) {
      case 'home': location.hash = '#/'; break;
      case 'goto-settings': location.hash = '#/steel/set'; break;
      case 'back-browse': goPath(T.path); break;
      case 'back-level': goPath(T.path.slice(0, -1)); break;
      case 'crumb': goPath(T.path.slice(0, parseInt(el.dataset.n, 10))); break;
      case 'pick': goPath([...T.path.slice(0, parseInt(el.dataset.lv, 10)), el.dataset.v]); break;
      case 'tree': goPath(JSON.parse(el.dataset.path)); break;
      case 'open-item': location.hash = '#/steel/i/' + encodeURIComponent(id); break;

      case 'toggle-mode':
        T.mode = T.mode === 'inventory' ? 'catalog' : 'inventory';
        if (T.mode === 'catalog') ensureCatalog();
        goPath([]);
        _render();
        break;

      case 'set-site': T.site = el.dataset.site; _render(); break;
      case 'detail-site': T.detailSite = el.dataset.site; _render(); break;

      case 'adj': {
        const r = findRecord(T.route.id);
        if (!r) break;
        const n = parseInt(el.dataset.n, 10);
        const done = sstore.adjustQty(r, T.detailSite, n, person());
        if (!done && n < 0) toast('これ以上減らせません（在庫0）');
        break;
      }

      case 'toggle-hidden': {
        const r = findRecord(T.route.id);
        if (!r) break;
        const msg = r.hidden
          ? 'この品目を一覧に再表示しますか？'
          : 'この品目を一覧から非表示にしますか？（在庫データは残ります）';
        if (!confirm(msg)) break;
        sstore.setHidden(r.id, !r.hidden);
        toast(r.hidden ? '再表示しました' : '非表示にしました');
        break;
      }
      case 'unhide': sstore.setHidden(id, false); toast('再表示しました'); break;

      case 'edit-safety': {
        const r = findRecord(T.route.id);
        if (!r) break;
        const input = prompt(`「${r.name}」の適正在庫（${r.unit || ''}）を入力してください。\n3拠点の合計がこの数を下回ると「不足」になります。`, String(num(r.safety)));
        if (input == null) break;
        const v = parseInt(String(input).trim(), 10);
        if (!isFinite(v) || v < 0) { toast('0以上の数値を入力してください'); break; }
        sstore.setSafety(r.id, v);
        toast('適正在庫を変更しました');
        break;
      }

      // 在庫に追加
      case 'open-add': T.add = { id, site: 'matsumae', qty: 1 }; _render(); break;
      case 'close-add': T.add = null; _render(); break;
      case 'add-site': if (T.add) { T.add.site = el.dataset.site; _render(); } break;
      case 'add-qty': if (T.add) { T.add.qty = Math.max(1, T.add.qty + parseInt(el.dataset.n, 10)); _render(); } break;
      case 'commit-add': {
        if (!T.add) break;
        const r = findRecord(T.add.id);
        if (!r) break;
        sstore.addToInventory(r, { site: T.add.site, qty: T.add.qty, person: person() });
        T.add = null;
        T.mode = 'inventory';
        toast('在庫に追加しました');
        goPath([]);
        break;
      }

      // CSV
      case 'pick-csv': {
        const f = document.getElementById('st-csv-file');
        if (f) { f.value = ''; f.click(); }
        break;
      }
      case 'export-csv': exportCsv(); break;
      case 'export-template': {
        downloadCsv('鋼材カタログ_取込テンプレート.csv', [buildCatalogRows([], new Map())[0]]);
        toast('テンプレートを書き出しました');
        break;
      }
      case 'close-imp': if (!T.imp?.running) { T.imp = null; _render(); } break;
      case 'commit-imp': runImport(); break;

      // 差分削除
      case 'pick-diff': {
        const f = document.getElementById('st-diff-file');
        if (f) { f.value = ''; f.click(); }
        break;
      }
      case 'close-del': if (!T.del?.running) { T.del = null; _render(); } break;
      case 'commit-del': runDiffDelete(); break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-schange]');
    if (!el) return;
    if (el.dataset.schange === 'csv-file') readCsvFile(el.files && el.files[0]);
    if (el.dataset.schange === 'diff-file') readDiffFile(el.files && el.files[0]);
  });
}

// ---------- CSV 取込・書き出しの処理 ----------

function readCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = decodeCsv(reader.result);
      const { rows, errors, unknownHeaders } = parseCatalogCsv(text);
      // 新規／更新の内訳を出すために、まずカタログの現状を読む
      const withSummary = (existingIds) => {
        T.imp = {
          name: file.name,
          rows, errors, unknownHeaders,
          summary: sstore.summarizeImport(rows, existingIds),
          running: false, doneCount: 0,
        };
        _render();
      };
      if (T.catalogState === 'ready') {
        withSummary(new Set((T.catalog || []).map((c) => c.id)));
      } else {
        sstore.loadCatalog()
          .then((cat) => {
            T.catalog = cat; T.catalogState = 'ready';
            withSummary(new Set(cat.map((c) => c.id)));
          })
          .catch(() => withSummary(new Set()));
      }
    } catch (err) {
      console.error('CSVの読み込みに失敗:', err);
      toast('CSVを読み込めませんでした');
    }
  };
  reader.onerror = () => toast('ファイルを読み込めませんでした');
  reader.readAsArrayBuffer(file);
}

async function runImport() {
  if (!T.imp || T.imp.running || !T.imp.rows.length) return;
  T.imp.running = true;
  _render();
  try {
    await sstore.importCatalog(T.imp.rows, {
      person: person(),
      stockById: stockMap(),
      onProgress: (done) => { if (T.imp) { T.imp.doneCount = done; _render(); } },
    });
    const n = T.imp.rows.length;
    T.imp = null;
    T.catalogState = 'idle'; // 次に開くときに読み直す
    T.catalog = null;
    toast(`${n} 件を取り込みました`);
  } catch (e) {
    console.error('CSV取込に失敗:', e);
    if (T.imp) T.imp.running = false;
    toast('取込に失敗しました。電波状況を確認してください');
  }
  _render();
}

// ---------- 差分削除の処理 ----------

function readDiffFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { rows, errors } = parseCatalogCsv(decodeCsv(reader.result));
      const build = (catalog) => {
        const csvKeys = new Set(rows.map((r) => r.key));
        const { targets, keptInStock } = sstore.planDiffDelete(catalog, csvKeys, stockMap());
        T.del = {
          name: file.name,
          targets: targets.sort(compareItems),
          keptInStock,
          errors,
          csvCount: rows.length,
          running: false, doneCount: 0,
        };
        _render();
      };
      toast('カタログを読み込んでいます…');
      sstore.loadCatalog()
        .then((cat) => { T.catalog = cat; T.catalogState = 'ready'; build(cat); })
        .catch((e) => {
          console.error('カタログの読み込みに失敗:', e);
          toast('カタログを読み込めませんでした');
        });
    } catch (err) {
      console.error('CSVの読み込みに失敗:', err);
      toast('CSVを読み込めませんでした');
    }
  };
  reader.onerror = () => toast('ファイルを読み込めませんでした');
  reader.readAsArrayBuffer(file);
}

async function runDiffDelete() {
  if (!T.del || T.del.running || !T.del.targets.length || T.del.errors.length) return;
  const n = T.del.targets.length;
  if (!confirm(`${n} 件を削除します。よろしいですか？\nこの操作は取り消せません。`)) return;

  T.del.running = true;
  _render();
  try {
    await sstore.deleteCatalogByIds(T.del.targets.map((c) => c.id), {
      onProgress: (done) => { if (T.del) { T.del.doneCount = done; _render(); } },
    });
    T.del = null;
    T.catalog = null;
    T.catalogState = 'idle'; // 次に開くときに読み直す
    toast(`${n} 件を削除しました`);
  } catch (e) {
    console.error('差分削除に失敗:', e);
    if (T.del) T.del.running = false;
    toast('削除に失敗しました。電波状況を確認してください');
  }
  _render();
}

function exportCsv() {
  const write = (cat) => {
    const rows = buildCatalogRows(cat.slice().sort(compareItems), stockMap());
    downloadCsv('鋼材カタログ.csv', rows);
    toast(`${cat.length} 件を書き出しました`);
  };
  if (T.catalogState === 'ready') { write(T.catalog || []); return; }
  toast('カタログを読み込んでいます…');
  sstore.loadCatalog()
    .then((cat) => { T.catalog = cat; T.catalogState = 'ready'; write(cat); })
    .catch(() => toast('カタログを読み込めませんでした'));
}
