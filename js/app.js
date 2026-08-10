// ============================================================
// よつば在庫 — 画面描画・ルーティング・操作（消耗品セクション＋全体のルーター）
// 画面構成:
//   #/            玄関（鋼材／消耗品を選ぶスタート画面）→ home.js
//   #/steel...    鋼材セクション → steel.js
//   #/shohin      区分メニュー（KPI＋横断検索＋区分タイル）＝消耗品在庫一覧のトップ
//   #/list        在庫一覧・全品目（PC: テーブル／スマホ: カード） + 棚卸モード
//   #/list/{区分} 在庫一覧・区分で絞り込み
//   #/item/{id}   品目詳細（PC/スマホ）
//   #/orders      発注アラート
//   #/settings    設定（モード切替・現場/担当者マスタ）
//   モーダル: 入出庫記録・品目の新規登録/編集
// ============================================================

// ※ import の ?v= は sw.js の VERSION・index.html の ?v= と揃えて更新する
//   （Service Worker の旧キャッシュと新コードが混在して起動に失敗するのを防ぐ）
import { ready } from './firebase.js?v=15';
import * as store from './store.js?v=15';
import * as steel from './steel.js?v=15';
import * as home from './home.js?v=15';
import {
  statusOf, recommendQty, YEN, num, toDate,
  fmtDate, fmtDateJa, fmtDateTime, monthStart,
  esc, downloadCsv, local,
  CATEGORIES, UNITS, ORDER_STATES, GREEN, ORANGE, RED,
} from './util.js?v=15';

const appEl = document.getElementById('app');
const modalEl = document.getElementById('modal-root');
const toastEl = document.getElementById('toast-root');

// ---------- アプリ状態 ----------
const S = {
  items: null,          // null = 読み込み中
  recentLogs: [],
  sites: [],
  persons: [],
  categories: [],       // 区分マスタ [{id, name, order}]
  locsMaster: [],       // 保管場所マスタ [{id, name, order}]
  masterEdit: null,     // 名前変更中 { kind:'cat'|'loc', id, name }
  syncedAt: null,
  authError: false,

  route: { view: 'home' },
  listHash: '#/list',   // 直前に見ていた一覧（品目詳細から戻る先）

  // 一覧（PC）※ cat は URL（区分メニューで選んだ区分）から設定される
  q: '', cat: 'すべて', loc: 'すべて', onlyShort: false,
  sortKey: '', sortDir: 'asc', page: 1, pageSize: 50,

  // 一覧（スマホ）
  spCount: 12,
  spSort: local.get('spSort', 'status'), // 'status' | 'recent'

  // 棚卸モード
  stocktake: null, // { counts: { itemId: '数えた数(文字列)' } }

  // 品目詳細
  detailItemId: null,
  detailLogs: [],
  detailUnsub: null,

  // 発注アラート 選択状態
  orderSel: null, // Set<itemId> | null(未初期化)
};

// 入出庫モーダルの状態（null = 閉）
let M = null; // { itemId, kind, qty, person, site, memo, memoTouched }
// 品目フォームの状態（null = 閉）
let F = null; // { id } id=null なら新規

const mode = () => local.get('mode', 'office'); // 'office' | 'field'

// ---------- 起動画面（スプラッシュ） ----------
// 初回データ到着でフェードアウト。一瞬で消えてチラつかないよう最低0.8秒は表示する。
// 読み込みに失敗した場合もエラー表示が見えるよう、必ず消す（保険の8秒タイムアウト付き）。

const SPLASH_MIN_MS = 800;
const splashShownAt = Date.now();

function hideSplash() {
  const el = document.getElementById('splash');
  if (!el || el.dataset.hiding) return;
  el.dataset.hiding = '1';
  const rest = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  setTimeout(() => {
    el.classList.add('splash-hide'); // 文字がズームイン(scale 1→9)しつつフェードアウト
    setTimeout(() => el.remove(), 500); // アニメーション(0.45s)後にDOMから除去
  }, rest);
}

setTimeout(hideSplash, 8000); // 保険: 何かに失敗しても起動画面で固まらない

// ---------- 起動 ----------
// ※ 購読は必ず匿名サインイン完了後に開始する（未認証だと permission-denied で
//    リスナーが終了し、その後サインインしても復活しないため）

let authOk = false;
let mastersSeeded = false;

// 玄関・鋼材セクションに描画関数を渡す（render は関数宣言なのでここで参照できる）
steel.init({ render });
home.init({
  render,
  consumables: {
    // 玄関タイル用: 消耗品の品目数と在庫不足件数
    stats: () => {
      const items = S.items;
      if (items === null) return { total: 0, short: 0, loading: true };
      return { total: items.length, short: items.filter((i) => statusOf(i).rank < 2).length, loading: false };
    },
    // 玄関の横断検索用: 消耗品を品名・型番などから探す
    search: (q) => {
      const s = q.trim();
      if (!s) return [];
      return (S.items || [])
        .filter((it) => ((it.name || '') + (it.model || '') + (it.location || '') + (it.supplier || '')).includes(s))
        .slice(0, 8)
        .map((it) => ({
          id: it.id,
          name: it.name || '',
          sub: '消耗品 ／ ' + [it.category, `在庫 ${num(it.stock)}${it.unit || ''}`].filter(Boolean).join(' ／ '),
          isShort: statusOf(it).rank < 2,
          hash: '#/item/' + encodeURIComponent(it.id),
        }));
    },
  },
});

ready.then(() => {
  authOk = true;
  steel.start(); // 鋼材の在庫購読（消耗品とは別コレクション）
  store.watchItems((items) => {
    S.items = items;
    S.syncedAt = new Date();
    // 区分・保管場所マスタが未作成なら、現在の選択肢＋使用中の値で自動作成
    if (!mastersSeeded && items.length) { mastersSeeded = true; store.ensureMasters(items); }
    render();
    hideSplash(); // 初回読み込み完了 → 起動画面をフェードアウト
  }, (e) => { console.error('items購読エラー:', e); S.authError = true; render(); hideSplash(); });

  store.watchRecentLogs((logs) => { S.recentLogs = logs; render(); },
    (e) => console.error('logs購読エラー:', e));
  store.watchSites((sites) => { S.sites = sites; render(); },
    (e) => console.error('sites購読エラー:', e));
  store.watchPersons((persons) => { S.persons = persons; render(); },
    (e) => console.error('persons購読エラー:', e));
  store.watchCategories((rows) => { S.categories = rows; render(); },
    (e) => console.error('categories購読エラー:', e));
  store.watchLocations((rows) => { S.locsMaster = rows; render(); },
    (e) => console.error('locations購読エラー:', e));

  onRoute(); // 品目詳細を直接開いた場合の履歴購読を認証後にやり直す
}).catch(() => { S.authError = true; render(); hideSplash(); });

window.addEventListener('hashchange', onRoute);
// ※ 初回の onRoute() はファイル末尾で呼ぶ（後方の const 宣言より先に実行させないため）

// スマホ一覧の無限スクロール（12件ずつ追加）
window.addEventListener('scroll', () => {
  if (S.route.view !== 'list' || window.innerWidth > 900) return;
  if (window.innerHeight + window.scrollY < document.body.scrollHeight - 240) return;
  const total = spSortedItems().length;
  if (S.spCount < total) { S.spCount += 12; render(); }
}, { passive: true });

function onRoute() {
  const h = location.hash || '#/';

  // 鋼材セクションのハッシュは steel.js が受け持つ（内部の絞り込み位置もそちらが解釈する）
  let route;
  if (steel.onRoute(h)) {
    route = { view: 'steel' };
  } else {
    route = { view: 'home' };   // 未知のハッシュは玄関に落とす
    const mItem = h.match(/^#\/item\/(.+)$/);
    const mList = h.match(/^#\/list(?:\/(.*))?$/);
    if (mItem) route = { view: 'item', id: decodeURIComponent(mItem[1]) };
    else if (mList) route = { view: 'list', cat: hashToCat(mList[1]) };
    else if (h === '#/orders') route = { view: 'orders' };
    else if (h === '#/settings') route = { view: 'settings' };
    else if (h === '#/shohin') route = { view: 'menu' };
  }
  S.route = route;

  if (route.view === 'list') {
    S.cat = route.cat;      // 区分は URL 側が持つ（一覧内には区分切替を置かない）
    S.page = 1;
    S.spCount = 12;
    S.listHash = h;         // 品目詳細から「戻る」でこの一覧に帰れるように覚えておく
  }

  // 品目詳細の履歴購読を張り替え（認証完了後のみ。完了時に onRoute が再実行される）
  const wantId = route.view === 'item' && authOk ? route.id : null;
  if (wantId !== S.detailItemId) {
    if (S.detailUnsub) { S.detailUnsub(); S.detailUnsub = null; }
    S.detailItemId = wantId;
    S.detailLogs = [];
    if (wantId) {
      S.detailUnsub = store.watchItemLogs(wantId, (logs) => { S.detailLogs = logs; render(); },
        (e) => console.error('履歴購読エラー:', e));
    }
  }
  if (route.view !== 'orders') S.orderSel = null;
  window.scrollTo(0, 0);
  render();
}

// ---------- 共通部品 ----------

const MARK_SVG = `<svg viewBox="0 0 100 100"><path d="M30 12 h14 v40 h14 L37 78 L16 52 h14 z"></path><path d="M70 88 h-14 v-40 h-14 L63 22 L84 48 h-14 z"></path></svg>`;

// ロゴマーク＝玄関に戻るボタン（README 1章「各セクションのヘッダー左上にホームアイコン」）
const HOME_MARK = `<span class="brand-mark home-mark" data-nav="#/" role="button" tabindex="0"
  aria-label="玄関にもどる" title="玄関にもどる">${MARK_SVG}</span>`;

function decorate(it) {
  const st = statusOf(it);
  return { ...it, ...st, priceLabel: YEN(it.price), valueLabel: YEN(num(it.price) * num(it.stock)) };
}

function kindColor(kind) {
  return kind === '入庫' ? GREEN : kind === '棚卸調整' ? ORANGE : '#10140f';
}

function toast(msg, ms = 2600) {
  toastEl.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.innerHTML = ''; }, ms);
}

// PCヘッダー
function pcHeader(active) {
  const navLink = (href, label) =>
    `<a data-nav="${href}" class="${active === href ? 'on' : ''}">${label}</a>`;
  return `
  <header class="pc-header pc-only">
    <span class="brand">
      ${HOME_MARK}
      <span class="brand-name">よつば建設工業</span>
      <span class="brand-sub">消耗品在庫管理</span>
    </span>
    <nav class="pc-nav">
      ${navLink('#/', '玄関')}
      ${navLink('#/shohin', '在庫一覧')}
      <a data-act="open-move">入出庫記録</a>
      ${navLink('#/orders', '発注アラート')}
      ${navLink('#/settings', '設定')}
    </nav>
    <span class="who">${mode() === 'office' ? '事務所モード' : '現場モード'}</span>
  </header>`;
}

// スマホ下部タブバー
function tabbar(active) {
  const tab = (key, href, label, act) => {
    const attr = act ? `data-act="${act}"` : `data-nav="${href}"`;
    return `<a ${attr} class="${active === key ? 'on' : ''}">${label}</a>`;
  };
  return `
  <nav class="tabbar sp-only">
    ${tab('list', '#/shohin', '在庫')}
    ${tab('move', null, '入出庫', 'open-move')}
    ${tab('orders', '#/orders', '発注')}
    ${tab('settings', '#/settings', '設定')}
  </nav>`;
}

function connBanner() {
  return S.authError
    ? `<div class="conn-error">Firebaseに接続できません。電波状況をご確認のうえ、ページを再読み込みしてください。</div>`
    : '';
}

// ---------- 一覧: 区分とURL ----------
// #/list → すべて ／ #/list/{区分名} → その区分 ／ #/list/_none_ → 区分が未設定の品目
// （区分名そのものが "_none_" の場合は衝突するが、実運用ではまず起きない想定）

const NOCAT = '_none_';

function catHref(cat) {
  if (cat === 'すべて') return '#/list';
  return '#/list/' + encodeURIComponent(cat === '' ? NOCAT : cat);
}

function hashToCat(raw) {
  if (raw == null || raw === '') return 'すべて';
  return raw === NOCAT ? '' : decodeURIComponent(raw);
}

// 区分の表示名（'' は区分未設定の品目）
const catLabel = (cat) => (cat === '' ? '（区分なし）' : cat);

// ---------- 一覧: フィルタ・並び替え ----------

function filteredItems() {
  const q = S.q.trim();
  const rank = (it) => statusOf(it).rank;
  let list = (S.items || []).filter((it) =>
    (S.cat === 'すべて' || (it.category || '') === S.cat) &&
    (S.loc === 'すべて' || it.location === S.loc) &&
    (!S.onlyShort || rank(it) < 2) &&
    (!q || ((it.name || '') + (it.model || '') + (it.location || '') + (it.supplier || '')).includes(q))
  );
  if (S.sortKey) {
    const k = S.sortKey, dir = S.sortDir === 'asc' ? 1 : -1;
    const val = (x) => (
      k === 'status' ? statusOf(x).rank :
      k === 'value' ? num(x.price) * num(x.stock) :
      k === 'last' ? (toDate(x.last) ? toDate(x.last).getTime() : 0) :
      x[k]);
    list = list.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va ?? '').localeCompare(String(vb ?? ''), 'ja') * dir;
    });
  }
  return list;
}

function spSortedItems() {
  const list = filteredItems().slice();
  if (S.spSort === 'recent') {
    list.sort((a, b) => (toDate(b.last)?.getTime() || 0) - (toDate(a.last)?.getTime() || 0));
  } else {
    list.sort((a, b) => statusOf(a).rank - statusOf(b).rank || num(b.min) - num(a.min));
  }
  return list;
}

// 区分の選択肢 = マスタ（未作成の間は従来の固定リスト）＋ 品目で使用中の値
function categoryNames() {
  const names = S.categories.length ? S.categories.map((c) => c.name) : [...CATEGORIES];
  for (const it of (S.items || [])) if (it.category && !names.includes(it.category)) names.push(it.category);
  return names;
}

// 保管場所の選択肢 = マスタ ＋ 品目で使用中の値
function locationNames() {
  const names = S.locsMaster.map((l) => l.name);
  for (const it of (S.items || [])) if (it.location && !names.includes(it.location)) names.push(it.location);
  if (!S.locsMaster.length) names.sort((a, b) => a.localeCompare(b, 'ja'));
  return names;
}

// ---------- 画面1: 区分メニュー（在庫一覧のトップ） ----------
// 品目が増えて1本の長い一覧が見にくくなったため、まず区分を選ぶ画面を挟む。
// 上部は従来のKPIカード、その下に横断検索、さらに下に区分タイル。

function viewMenu() {
  const items = S.items || [];
  const shortage = items.filter((i) => statusOf(i).rank < 2);
  const reorder = items.filter((i) => statusOf(i).rank === 0);
  const ordering = items.filter((i) => i.orderStatus === '発注済');
  const m0 = monthStart(0).getTime(), m1 = monthStart(-1).getTime();
  const outThis = S.recentLogs.filter((l) => l.kind === '出庫' && (toDate(l.at)?.getTime() || 0) >= m0).length;
  const outPrev = S.recentLogs.filter((l) => {
    const t = toDate(l.at)?.getTime() || 0;
    return l.kind === '出庫' && t >= m1 && t < m0;
  }).length;
  const diff = outThis - outPrev;
  const stockValue = items.reduce((t, i) => t + num(i.price) * num(i.stock), 0);

  // 区分ごとの品目数・在庫不足件数（1回のループで集計）
  const stat = new Map();
  for (const it of items) {
    const k = it.category || '';
    let e = stat.get(k);
    if (!e) { e = { n: 0, short: 0 }; stat.set(k, e); }
    e.n++;
    if (statusOf(it).rank < 2) e.short++;
  }

  const cats = categoryNames();
  const tile = (cat, label, sum) => {
    const e = sum || stat.get(cat) || { n: 0, short: 0 };
    return `
    <div class="cat-tile${sum ? ' all' : ''}${e.short ? ' short' : ''}" data-act="goto-cat" data-cat="${esc(cat)}">
      <div class="ct-name">${esc(label)}</div>
      <div class="ct-count"><strong class="num">${e.n}</strong> 品目</div>
      <div class="ct-short${e.short ? ' warn' : ''}">${e.short ? `在庫不足 ${e.short} 件` : '在庫不足なし'}</div>
    </div>`;
  };
  const noCat = stat.get('');
  const tiles = [
    tile('すべて', 'すべて', { n: items.length, short: shortage.length }),
    ...cats.map((c) => tile(c, c, null)),
    ...(noCat && noCat.n ? [tile('', catLabel(''), null)] : []),
  ].join('');

  return `
  ${pcHeader('#/shohin')}
  <div class="sp-only">
    <div class="sp-header">
      <div class="row">
        ${HOME_MARK}
        <span class="ttl">在庫一覧</span>
        <span class="badge">在庫不足 ${shortage.length} 件</span>
      </div>
    </div>
  </div>

  <div class="page">
    <div class="page-head pc-only">
      <h2>在庫一覧</h2>
      <div class="sub">最終同期 ${S.syncedAt ? fmtDateJa(S.syncedAt) + ' ' + String(S.syncedAt.getHours()).padStart(2, '0') + ':' + String(S.syncedAt.getMinutes()).padStart(2, '0') : '—'}</div>
      <div style="margin-left:auto" class="office-only">
        <button class="btn btn-primary" data-act="new-item">＋新規登録</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="k-label">登録品目数</div>
        <div class="k-value">${items.length}</div>
        <div class="k-note">区分 ${cats.length} 分類</div>
      </div>
      <div class="kpi">
        <div class="k-label">在庫不足</div>
        <div class="k-value ${shortage.length ? 'warn' : ''}">${shortage.length}</div>
        <div class="k-note">うち要発注 ${reorder.length} 件</div>
      </div>
      <div class="kpi">
        <div class="k-label">今月の出庫件数</div>
        <div class="k-value">${outThis}</div>
        <div class="k-note">前月比 ${diff >= 0 ? '+' : ''}${diff} 件</div>
      </div>
      <div class="kpi">
        <div class="k-label">在庫金額（概算）</div>
        <div class="k-value small">${YEN(stockValue)}</div>
        <div class="k-note">発注中 ${ordering.length} 件</div>
      </div>
    </div>

    <form class="menu-search" data-form="menu-search">
      <input id="menuq" class="input" type="search" name="q" value="${esc(S.q)}"
        placeholder="全区分から検索（品名・型番・保管場所・仕入先）">
      <button class="btn btn-primary" type="submit">検索</button>
    </form>

    <div class="menu-note">区分を選ぶとその区分の一覧を表示します</div>
    <div class="cat-grid">${tiles}</div>
  </div>
  <div class="sp-only">
    <button class="btn btn-primary fab office-only" data-act="new-item" aria-label="品目を新規登録" title="品目を新規登録">＋</button>
  </div>
  ${tabbar('list')}`;
}

// ---------- 画面1a/4: 在庫一覧（区分で絞り込み） ----------

function viewList() {
  const items = S.items || [];
  const inCat = S.cat === 'すべて' ? items : items.filter((i) => (i.category || '') === S.cat);
  const shortage = inCat.filter((i) => statusOf(i).rank < 2);
  const title = S.cat === 'すべて' ? 'すべての品目' : catLabel(S.cat);

  const visible = filteredItems();
  const total = visible.length;
  const pageCount = Math.max(1, Math.ceil(total / S.pageSize));
  const page = Math.min(S.page, pageCount);
  const paged = visible.slice((page - 1) * S.pageSize, page * S.pageSize).map(decorate);
  const visValue = visible.reduce((t, i) => t + num(i.price) * num(i.stock), 0);
  const st = S.stocktake;
  const mark = (k) => (S.sortKey !== k ? '' : S.sortDir === 'asc' ? ' ▲' : ' ▼');
  const th = (k, label, right) =>
    `<th class="sortable${right ? ' right' : ''}" data-sort="${k}">${label}${mark(k)}</th>`;

  // 棚卸: 入力済み・差異件数
  let stEntered = 0, stDiff = 0;
  if (st) {
    for (const it of items) {
      const v = st.counts[it.id];
      if (v == null || v === '') continue;
      stEntered++;
      if (parseInt(v, 10) !== num(it.stock)) stDiff++;
    }
  }

  const rowsHtml = paged.map((row) => {
    let opCell;
    if (st) {
      const v = st.counts[row.id] ?? '';
      const counted = v === '' ? null : parseInt(v, 10);
      const d = counted == null || isNaN(counted) ? null : counted - num(row.stock);
      const diffLabel = d == null ? '' :
        d === 0 ? `<span style="opacity:.6">差 0</span>` :
        `<span class="${d > 0 ? 'diff-plus' : 'diff-minus'}">差 ${d > 0 ? '+' : ''}${d}</span>`;
      opCell = `<td><span style="display:flex;gap:8px;align-items:center">
        <input type="number" min="0" inputmode="numeric" class="input stocktake-input" id="st-${esc(row.id)}"
          data-input="stocktake" data-id="${esc(row.id)}" value="${esc(v)}" placeholder="数えた数">
        <span class="num" style="font-size:12px;min-width:52px">${diffLabel}</span></span></td>`;
    } else {
      opCell = `<td><span style="display:flex;gap:4px">
        <button class="btn btn-sm" data-act="open-move" data-id="${esc(row.id)}" data-kind="入庫">入庫</button>
        <button class="btn btn-sm" data-act="open-move" data-id="${esc(row.id)}" data-kind="出庫">出庫</button></span></td>`;
    }
    const trCls = st && row.id in st.counts && st.counts[row.id] !== '' &&
      parseInt(st.counts[row.id], 10) !== num(row.stock) ? 'diff-row' : (st ? '' : 'clickable');
    return `
    <tr class="${trCls}" style="background:${row.bg}" ${st ? '' : `data-act="goto-item" data-id="${esc(row.id)}"`}>
      <td><div style="font-weight:700">${esc(row.name)}</div>
          <div style="font-size:12px;opacity:.65" class="num">${esc(row.model || '')}</div></td>
      <td style="font-size:13px">${esc(row.category || '')}</td>
      <td class="right num" style="font-weight:900;font-size:17px;color:${row.color}">${num(row.stock)}</td>
      <td class="right num" style="opacity:.7">${num(row.min)}</td>
      <td style="font-size:13px">${esc(row.unit || '')}</td>
      <td class="right num" style="font-size:13px">${row.priceLabel}</td>
      <td class="right num" style="font-size:13px;font-weight:700">${row.valueLabel}</td>
      <td style="font-size:13px">${esc(row.location || '')}</td>
      <td style="font-size:13px">${esc(row.supplier || '')}</td>
      <td style="font-size:13px" class="num">${fmtDate(row.last)}</td>
      <td><span class="tag" style="background:${row.color}">${row.status}</span></td>
      ${opCell}
    </tr>`;
  }).join('');

  const locs = locationNames();
  if (S.loc !== 'すべて' && !locs.includes(S.loc)) S.loc = 'すべて'; // 名前変更・削除後の保険
  const locOpts = ['すべて', ...locs].map((l) =>
    `<option value="${esc(l)}" ${S.loc === l ? 'selected' : ''}>${esc(l)}</option>`).join('');

  // ---- スマホ用カードリスト ----
  const spSorted = spSortedItems();
  const spShown = spSorted.slice(0, S.spCount).map(decorate);
  const spRemain = Math.max(0, spSorted.length - S.spCount);
  const spCards = spShown.map((row) => `
    <div class="sp-card" style="border-left-color:${row.color}" data-act="goto-item" data-id="${esc(row.id)}">
      <div class="top">
        <div style="min-width:0">
          <div class="nm">${esc(row.name)}</div>
          <div class="meta">${esc(row.model || '')}　${esc(row.location || '')}</div>
        </div>
        <span class="tag" style="margin-left:auto;background:${row.color};font-size:11px">${row.status}</span>
      </div>
      <div class="bottom">
        <div><span class="stock" style="color:${row.color}">${num(row.stock)}</span>
          <span style="font-size:12px;opacity:.7">　${esc(row.unit || '')}</span></div>
        <div class="sub">最低在庫 ${num(row.min)} ${esc(row.unit || '')}<br>単価 ${row.priceLabel}</div>
      </div>
    </div>`).join('');

  return `
  ${pcHeader('#/shohin')}
  <div class="sp-only">
    <div class="sp-header">
      <div class="row">
        ${HOME_MARK}
        <span class="back" data-nav="#/shohin">＜ 区分メニュー</span>
        <span class="ttl" style="margin-left:8px">${esc(title)}</span>
        <span class="badge">在庫不足 ${shortage.length} 件</span>
      </div>
    </div>
    <div class="sp-search">
      <input id="spkw" class="input" type="text" placeholder="品名・型番・保管場所・仕入先で検索" value="${esc(S.q)}" data-input="query">
    </div>
    <div class="sp-filters">
      <select id="basho-sp" class="input" data-change="loc" aria-label="保管場所で絞り込み">${locOpts}</select>
      <label class="check"><input type="checkbox" ${S.onlyShort ? 'checked' : ''} data-change="only-short">在庫不足のみ</label>
    </div>
    <div class="sp-sortnote">
      <span>${S.spSort === 'status' ? '要発注 → 少ない → 十分 の順に表示' : '最近入出庫した順に表示'}（全 ${spSorted.length} 件）</span>
      <select id="spsort" data-change="sp-sort" style="margin-left:auto">
        <option value="status" ${S.spSort === 'status' ? 'selected' : ''}>状態順</option>
        <option value="recent" ${S.spSort === 'recent' ? 'selected' : ''}>最近入出庫順</option>
      </select>
    </div>
    <div class="sp-list">
      ${spCards || `<div style="padding:24px 8px;font-size:13px;opacity:.7">該当する品目はありません。</div>`}
      ${spRemain > 0 ? `<button class="btn" style="justify-content:center;min-height:48px" data-act="sp-more">さらに読み込む（残り ${spRemain} 件）</button>` : ''}
    </div>
    <button class="btn btn-primary fab office-only" data-act="new-item" aria-label="品目を新規登録" title="品目を新規登録">＋</button>
  </div>

  <div class="page pc-only">
    <div style="font-size:13px;margin-bottom:12px"><a data-nav="#/">← 区分メニューに戻る</a></div>
    <div class="page-head">
      <h2>${esc(title)}</h2>
      <div class="sub">全 ${inCat.length} 品目／在庫不足 ${shortage.length} 件</div>
      <div class="sub">最終同期 ${S.syncedAt ? fmtDateJa(S.syncedAt) + ' ' + String(S.syncedAt.getHours()).padStart(2, '0') + ':' + String(S.syncedAt.getMinutes()).padStart(2, '0') : '—'}</div>
      <div style="margin-left:auto" class="office-only">
        <button class="btn btn-primary" data-act="new-item">＋新規登録</button>
      </div>
    </div>

    ${st ? `
    <div class="stocktake-band">
      <span style="font-size:18px">棚卸中</span>
      <span style="font-weight:500">倉庫の実物を数えて「数えた数」に入力してください（未入力の行は対象外）</span>
      <span class="num">入力 ${stEntered} 件／差異 ${stDiff} 件</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button class="btn" data-act="stocktake-cancel">棚卸を中止</button>
        <button class="btn btn-primary" data-act="stocktake-commit">棚卸を確定</button>
      </span>
    </div>` : ''}

    <div class="filters">
      <div class="field" style="flex:1;min-width:280px">
        <label for="kw">検索</label>
        <input id="kw" class="input" type="text" placeholder="品名・型番・保管場所・仕入先で検索" value="${esc(S.q)}" data-input="query">
      </div>
      <div class="field" style="width:180px">
        <label for="basho">保管場所</label>
        <select id="basho" class="input" data-change="loc">${locOpts}</select>
      </div>
      <label class="check" style="padding-bottom:8px">
        <input type="checkbox" ${S.onlyShort ? 'checked' : ''} data-change="only-short">在庫不足のみ表示
      </label>
    </div>

    <div class="toolbar">
      <span>全 <strong class="num">${total}</strong> 件中 <strong class="num">${total === 0 ? '0 件' : `${(page - 1) * S.pageSize + 1}〜${Math.min(page * S.pageSize, total)} 件目`}</strong>を表示</span>
      <span style="opacity:.7">列見出しをクリックで並び替え／行をクリックで品目詳細</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button class="btn" data-act="csv-list">CSV出力</button>
        ${st ? '' : `<button class="btn" data-act="stocktake-start">棚卸モード</button>`}
      </span>
    </div>

    <div class="table-wrap">
      <table class="table" style="min-width:1300px">
        <thead><tr>
          ${th('name', '品名・型番')}
          <th>区分</th>
          ${th('stock', '現在庫数', true)}
          <th class="right">最低在庫</th>
          <th>単位</th>
          ${th('price', '単価', true)}
          ${th('value', '在庫金額', true)}
          ${th('location', '保管場所')}
          <th>仕入先</th>
          ${th('last', '最終入出庫日')}
          ${th('status', '状態')}
          <th style="width:${st ? 170 : 110}px">${st ? '数えた数' : '操作'}</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      ${paged.length === 0 ? `<div style="padding:32px 8px;font-size:14px;opacity:.7">該当する品目はありません。検索条件または区分を変更してください。</div>` : ''}
    </div>

    <div class="pager">
      <button class="btn" data-act="page-prev" ${page <= 1 ? 'disabled' : ''}>前のページ</button>
      <span style="font-weight:700" class="num">${page} ／ ${pageCount} ページ</span>
      <button class="btn" data-act="page-next" ${page >= pageCount ? 'disabled' : ''}>次のページ</button>
      <span style="opacity:.7">1ページ ${S.pageSize} 件表示</span>
      <span style="margin-left:auto;font-weight:700">絞り込み条件の在庫金額合計（概算） ${YEN(visValue)}</span>
    </div>
  </div>
  ${tabbar('list')}`;
}

// ---------- 画面2/5: 品目詳細 ----------

function viewItem() {
  const item = (S.items || []).find((i) => i.id === S.route.id);
  if (!item) {
    return `${pcHeader('')}<div class="page">
      <div style="padding:32px 0;font-size:14px;opacity:.7">${S.items === null ? '読み込み中…' : 'この品目は見つかりません（削除された可能性があります）。'}</div>
      <a data-nav="${esc(S.listHash)}">← 在庫一覧へ戻る</a></div>${tabbar('list')}`;
  }
  const d = decorate(item);
  const photoInfo = item.photo
    ? `現物写真（${item.photoAt ? 'スマホで撮影 ' + fmtDateJa(item.photoAt) : '撮影日 不明'}${item.photoBy ? '／' + esc(item.photoBy) : ''}）`
    : '現物写真は未登録です。「写真を撮る／選ぶ」で登録できます（1品目1枚・上書き）';

  const histRows = S.detailLogs.map((h) => `
    <tr>
      <td class="num" style="font-size:13px">${fmtDateTime(h.at)}</td>
      <td><span class="tag" style="background:${kindColor(h.kind)}">${esc(h.kind)}</span></td>
      <td class="right num" style="font-weight:700">${h.kind === '棚卸調整' && h.qty > 0 ? '+' : ''}${num(h.qty)}</td>
      <td class="right num" style="opacity:.75">${num(h.after)}</td>
      <td style="font-size:13px">${esc(h.person || '—')}</td>
      <td style="font-size:13px">${esc(h.site || '—')}</td>
      <td style="font-size:13px;opacity:.8">${esc(h.memo || '—')}</td>
    </tr>`).join('');

  const histCards = S.detailLogs.map((h) => `
    <div class="h-row">
      <span class="tag" style="background:${kindColor(h.kind)};font-size:11px">${esc(h.kind)}</span>
      <span class="h-qty">${h.kind === '棚卸調整' && h.qty > 0 ? '+' : ''}${num(h.qty)}</span>
      ${h.site ? `<span style="font-size:11px;opacity:.75">${esc(h.site)}</span>` : ''}
      <span class="h-meta">${fmtDateTime(h.at)}<br>${esc(h.person || '—')}</span>
    </div>`).join('');

  return `
  ${pcHeader('#/shohin')}
  <div class="sp-only">
    <div class="sp-header">
      <div class="row">
        ${HOME_MARK}
        <span class="back" data-nav="${esc(S.listHash)}">＜ 在庫一覧</span>
        <span class="ttl" style="margin-left:auto;font-size:15px">品目詳細</span>
      </div>
    </div>
    <div>
      ${item.photo
        ? `<img class="sp-photo" src="${esc(item.photo)}" alt="現物写真（タップで拡大）" data-act="photo-view" data-id="${esc(item.id)}" style="cursor:zoom-in">`
        : `<div class="sp-photo-empty">写真を撮る／選ぶ で現物写真を登録</div>`}
      <div class="sp-photo-btns">
        <label class="btn btn-primary" for="photo-cam">写真を撮る</label>
        <label class="btn" for="photo-pick-sp" style="background:#fff">写真を選ぶ</label>
      </div>
      <input type="file" accept="image/*" capture="environment" id="photo-cam" data-change="photo" data-id="${esc(item.id)}" style="display:none">
      <input type="file" accept="image/*" id="photo-pick-sp" data-change="photo" data-id="${esc(item.id)}" style="display:none">
      <div style="font-size:11px;opacity:.7;padding:6px 16px 0">撮影した写真は品目マスタに保存され、PCの品目詳細にも反映されます</div>
      <div style="padding:16px">
        <div style="display:flex;align-items:flex-start;gap:8px;border-bottom:2px solid var(--text);padding-bottom:12px">
          <div>
            <div style="font-weight:900;font-size:20px">${esc(d.name)}</div>
            <div style="font-size:12px;opacity:.7">${esc(d.model || '')}　${esc(d.category || '')}</div>
          </div>
          <span class="tag" style="margin-left:auto;background:${d.color};font-size:11px">${d.status}</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:16px;padding:16px 0;border-bottom:2px solid var(--divider)">
          <div>
            <div style="font-size:12px;font-weight:700;opacity:.7">現在庫数</div>
            <span class="sp-bigstock" style="color:${d.color}">${num(d.stock)}</span>
            <span style="font-size:13px;opacity:.7">　${esc(d.unit || '')}</span>
          </div>
          <div style="font-size:12px;opacity:.75;padding-bottom:6px">
            最低在庫 ${num(d.min)}<br>保管場所 ${esc(d.location || '—')}<br>
            単価 ${d.priceLabel}／在庫金額（概算） ${d.valueLabel}
          </div>
        </div>
        <div class="sp-io-btns">
          <button class="btn btn-primary" data-act="open-move" data-id="${esc(item.id)}" data-kind="入庫">入庫</button>
          <button class="btn" data-act="open-move" data-id="${esc(item.id)}" data-kind="出庫" style="border-width:2px">出庫</button>
        </div>
        <div style="font-weight:900;font-size:15px;margin:8px 0">入出庫履歴</div>
        <div class="sp-hist">${histCards || '<div style="font-size:12px;opacity:.6">履歴はまだありません</div>'}</div>
      </div>
    </div>
  </div>

  <div class="page pc-only">
    <div style="font-size:13px;margin-bottom:12px"><a data-nav="${esc(S.listHash)}">在庫一覧</a><span style="opacity:.5">　＞　品目詳細</span></div>
    <div class="detail-grid">
      <div>
        <div class="photo-box">
          ${item.photo
            ? `<img class="ph" src="${esc(item.photo)}" alt="現物写真（クリックで拡大）" data-act="photo-view" data-id="${esc(item.id)}" style="cursor:zoom-in" title="クリックで拡大">`
            : `<div class="ph-empty">現物写真は未登録です</div>`}
        </div>
        <div style="font-size:12px;opacity:.65;margin-top:6px">${photoInfo}</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
          <button class="btn btn-primary btn-block" data-act="open-move" data-id="${esc(item.id)}" data-kind="入庫">入庫を記録する</button>
          <button class="btn btn-block" data-act="open-move" data-id="${esc(item.id)}" data-kind="出庫">出庫を記録する</button>
          <button class="btn btn-block office-only" data-act="order-request" data-id="${esc(item.id)}">発注依頼を作成</button>
          <label class="btn btn-block" for="photo-pick-pc" style="justify-content:center">写真を選ぶ（アップロード）</label>
          <input type="file" accept="image/*" id="photo-pick-pc" data-change="photo" data-id="${esc(item.id)}" style="display:none">
          <span style="display:flex;gap:8px" class="office-only">
            <button class="btn" style="flex:1;justify-content:center" data-act="edit-item" data-id="${esc(item.id)}">編集</button>
            <button class="btn btn-danger" style="flex:1;justify-content:center" data-act="delete-item" data-id="${esc(item.id)}">削除</button>
          </span>
        </div>
      </div>
      <div style="min-width:0">
        <div style="display:flex;align-items:flex-start;gap:16px;border-bottom:2px solid var(--text);padding-bottom:12px;margin-bottom:16px">
          <div>
            <h2 style="font-size:30px;margin-bottom:4px">${esc(d.name)}</h2>
            <div style="font-size:13px;opacity:.7">型番 ${esc(d.model || '—')}　／　区分 ${esc(d.category || '—')}　／　品目コード ${esc(d.id)}</div>
          </div>
          <span class="tag" style="margin-left:auto;font-size:13px;padding:6px 12px;background:${d.color}">${d.status}</span>
        </div>

        <div class="metrics">
          <div class="metric">
            <div class="m-label">現在庫数</div>
            <div class="m-value" style="color:${d.color}">${num(d.stock)}</div>
            <div class="m-note">単位：${esc(d.unit || '—')}</div>
          </div>
          <div class="metric">
            <div class="m-label">最低在庫</div>
            <div class="m-value">${num(d.min)}</div>
            <div class="m-note">下回ると要発注</div>
          </div>
          <div class="metric">
            <div class="m-label">保管場所</div>
            <div class="m-value text">${esc(d.location || '—')}</div>
            <div class="m-note">棚番 ${esc(d.shelf || '—')}</div>
          </div>
          <div class="metric">
            <div class="m-label">仕入先</div>
            <div class="m-value text">${esc(d.supplier || '—')}</div>
            <div class="m-note">標準納期 ${esc(d.lead || '—')}</div>
          </div>
          <div class="metric">
            <div class="m-label">単価</div>
            <div class="m-value mid">${d.priceLabel}</div>
            <div class="m-note">／${esc(d.unit || '—')}（税抜）</div>
          </div>
          <div class="metric">
            <div class="m-label">在庫金額（概算）</div>
            <div class="m-value mid">${d.valueLabel}</div>
            <div class="m-note">単価 × 現在庫数</div>
          </div>
        </div>

        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px">
          <h3 style="font-size:18px">入出庫履歴</h3>
          <span style="font-size:12px;opacity:.6">発注状況：${esc(item.orderStatus || '未発注')}／最終棚卸日：${fmtDate(item.lastCounted)}</span>
        </div>
        <div class="table-wrap" style="border-top:none">
          <table class="table">
            <thead><tr>
              <th>日時</th><th>区分</th><th class="right">数量</th><th class="right">記録後在庫</th>
              <th>担当者</th><th>使った現場</th><th>メモ</th>
            </tr></thead>
            <tbody>${histRows || `<tr><td colspan="7" style="opacity:.6">履歴はまだありません</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  ${tabbar('list')}`;
}

// ---------- 画面6: 発注アラート ----------

function viewOrders() {
  const items = S.items || [];
  const shortage = items.filter((i) => statusOf(i).rank < 2)
    .sort((a, b) => statusOf(a).rank - statusOf(b).rank || num(a.stock) / Math.max(1, num(a.min)) - num(b.stock) / Math.max(1, num(b.min)));
  const reorder = shortage.filter((i) => statusOf(i).rank === 0);
  const low = shortage.length - reorder.length;

  if (S.orderSel === null) S.orderSel = new Set(reorder.map((i) => i.id));

  const alerts = shortage.map((it) => {
    const d = decorate(it);
    const rec = recommendQty(it);
    return { ...d, recommend: rec, costLabel: YEN(rec * num(it.price)), cost: rec * num(it.price) };
  });
  const orderTotal = alerts.reduce((t, a) => t + a.cost, 0);
  const allChecked = alerts.length > 0 && alerts.every((a) => S.orderSel.has(a.id));

  const rows = alerts.map((a) => `
    <tr style="background:${a.bg}">
      <td><input type="checkbox" data-change="order-sel" data-id="${esc(a.id)}" ${S.orderSel.has(a.id) ? 'checked' : ''}></td>
      <td><div style="font-weight:700">${esc(a.name)}</div>
          <div style="font-size:12px;opacity:.65">${esc(a.model || '')}</div></td>
      <td style="font-size:13px">${esc(a.category || '')}</td>
      <td class="right num" style="font-weight:900;color:${a.color}">${num(a.stock)}</td>
      <td class="right num" style="opacity:.7">${num(a.min)}</td>
      <td class="right num" style="font-weight:700">${a.recommend}</td>
      <td class="right num" style="font-size:13px">${a.priceLabel}</td>
      <td class="right num" style="font-weight:700">${a.costLabel}</td>
      <td style="font-size:13px">${esc(a.supplier || '')}</td>
      <td style="font-size:13px">${esc(a.lead || '')}</td>
      <td>
        <select class="input office-only" style="min-height:32px;padding:4px 6px;width:auto" data-change="order-status" data-id="${esc(a.id)}">
          ${ORDER_STATES.map((s) => `<option ${(a.orderStatus || '未発注') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <span class="tag tag-outline field-only">${esc(a.orderStatus || '未発注')}</span>
      </td>
    </tr>`).join('');

  return `
  ${pcHeader('#/orders')}
  <div class="sp-only">
    <div class="sp-header">
      <div class="row">
        ${HOME_MARK}
        <span class="ttl">発注アラート</span>
        <span class="badge" style="background:${reorder.length ? 'var(--red)' : 'rgba(0,0,0,.28)'}">要発注 ${reorder.length} 件</span>
      </div>
    </div>
  </div>
  <div class="page">
    <div class="page-head pc-only">
      <h2>発注アラート</h2>
      <div class="sub">最低在庫を下回った品目：${reorder.length} 件／在庫が少ない品目：${low} 件</div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn" data-act="csv-orders">発注リストをCSV出力</button>
        <button class="btn btn-primary office-only" data-act="mark-ordered">選択した品目を「発注済」にする</button>
      </div>
    </div>
    <div class="sp-only" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn" data-act="csv-orders">発注リストをCSV出力</button>
      <button class="btn btn-primary office-only" data-act="mark-ordered">選択を「発注済」に</button>
    </div>

    <div class="alert-band">
      <span class="big">要発注 ${reorder.length} 件</span>
      <span style="font-size:14px">最低在庫を下回っています。仕入先へ発注を依頼してください。</span>
      <span class="total num">発注予定金額 合計 ${YEN(orderTotal)}</span>
    </div>

    <div class="table-wrap" style="border-top:none">
      <table class="table" style="min-width:1200px">
        <thead><tr>
          <th style="width:36px"><input type="checkbox" data-change="order-sel-all" ${allChecked ? 'checked' : ''}></th>
          <th>品名・型番</th><th>区分</th>
          <th class="right">現在庫</th><th class="right">最低在庫</th><th class="right">発注推奨数</th>
          <th class="right">単価</th><th class="right">発注予定金額</th>
          <th>仕入先</th><th>標準納期</th><th>発注状況</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="11" style="opacity:.6;padding:24px 8px">在庫不足の品目はありません。</td></tr>`}</tbody>
      </table>
    </div>

    <div class="legend">
      <div><span class="sw" style="background:${GREEN}"></span>十分</div>
      <div><span class="sw" style="background:${ORANGE}"></span>少ない</div>
      <div><span class="sw" style="background:${RED}"></span>要発注</div>
    </div>
    <div style="font-size:12px;opacity:.65;margin-top:8px">
      ※「発注済」の品目に入庫が記録されると、発注状況は自動で「未発注」に戻ります。<br>
      ※ CSVはExcelで開けます（電話・FAXでの発注にお使いください）。
    </div>
  </div>
  ${tabbar('orders')}`;
}

// ---------- 設定 ----------

function viewSettings() {
  const isOffice = mode() === 'office';

  // 区分・保管場所マスタの行（名前変更中の行は入力欄に切り替え）
  const useCount = (field, name) => (S.items || []).filter((i) => (i[field] || '') === name).length;
  const masterRows = (kind, field, list) => list.map((m) => {
    const editing = S.masterEdit && S.masterEdit.kind === kind && S.masterEdit.id === m.id;
    if (editing) {
      return `
      <div class="master-row">
        <input class="input" id="me-input" value="${esc(S.masterEdit.name)}" data-input="master-edit-name" style="flex:1">
        <button class="btn btn-sm btn-primary" data-act="master-save" data-kind="${kind}" data-id="${esc(m.id)}">保存</button>
        <button class="btn btn-sm" data-act="master-cancel">取消</button>
      </div>`;
    }
    const n = useCount(field, m.name);
    return `
      <div class="master-row">
        <span class="nm">${esc(m.name)}<span style="font-size:11px;opacity:.55">　使用 ${n} 件</span></span>
        <button class="btn btn-sm" data-act="master-edit" data-kind="${kind}" data-id="${esc(m.id)}" data-name="${esc(m.name)}">名前を変更</button>
        <button class="btn btn-sm btn-danger" data-act="master-del" data-kind="${kind}" data-id="${esc(m.id)}" data-name="${esc(m.name)}">削除</button>
      </div>`;
  }).join('');
  const masterEmptyNote = `<div style="font-size:13px;opacity:.6;padding:4px 0">
    マスタがまだ作成されていません。Firestoreルールを最新にした後、アプリを開き直すと現在の選択肢が自動で登録されます。</div>`;

  const masterCard = (kind, field, list, title, sub, addPlaceholder, formName) => `
    <div class="settings-card office-only">
      <h3>${title}</h3>
      ${masterRows(kind, field, list) || masterEmptyNote}
      <form data-form="${formName}" style="display:flex;gap:8px;margin-top:12px">
        <input class="input" name="name" type="text" placeholder="${addPlaceholder}" style="flex:1">
        <button class="btn btn-primary" type="submit">追加</button>
      </form>
      <div style="font-size:12px;opacity:.7;margin-top:8px">${sub}</div>
    </div>`;

  const sitesRows = S.sites.map((s) => `
    <div class="master-row">
      <span class="nm">${esc(s.name)}</span>
      <button class="btn btn-sm btn-danger office-only" data-act="del-site" data-id="${esc(s.id)}">削除</button>
    </div>`).join('');
  const personsRows = S.persons.map((p) => `
    <div class="master-row">
      <span class="nm">${esc(p.name)}</span>
      <button class="btn btn-sm btn-danger office-only" data-act="del-person" data-id="${esc(p.id)}">削除</button>
    </div>`).join('');

  return `
  ${pcHeader('#/settings')}
  <div class="sp-only">
    <div class="sp-header"><div class="row">
      ${HOME_MARK}<span class="ttl">設定</span>
    </div></div>
  </div>
  <div class="page" style="max-width:760px">
    <div class="page-head pc-only"><h2>設定</h2></div>

    <div class="settings-card">
      <h3>利用モード（この端末）</h3>
      <div class="seg">
        <span class="seg-opt ${isOffice ? 'on' : ''}" data-act="set-mode" data-mode="office">事務所モード</span>
        <span class="seg-opt ${!isOffice ? 'on' : ''}" data-act="set-mode" data-mode="field">現場モード</span>
      </div>
      <div style="font-size:12px;opacity:.7;margin-top:8px">
        現場モードでは、品目の新規登録・編集・削除と発注操作のボタンを隠します（誤操作防止の簡易な仕組みです）。
      </div>
    </div>

    <div class="settings-card">
      <h3>現場マスタ（出庫時の「使った現場」の選択肢）</h3>
      ${sitesRows || '<div style="font-size:13px;opacity:.6;padding:4px 0">まだ登録がありません</div>'}
      <form data-form="add-site" style="display:flex;gap:8px;margin-top:12px" class="office-only">
        <input class="input" name="name" type="text" placeholder="現場名（例：駅前ビル改修）" style="flex:1">
        <button class="btn btn-primary" type="submit">追加</button>
      </form>
    </div>

    <div class="settings-card">
      <h3>担当者マスタ（入出庫記録の担当者プルダウン）</h3>
      ${personsRows || '<div style="font-size:13px;opacity:.6;padding:4px 0">まだ登録がありません（未登録の間は手入力になります）</div>'}
      <form data-form="add-person" style="display:flex;gap:8px;margin-top:12px" class="office-only">
        <input class="input" name="name" type="text" placeholder="氏名（例：田中 剛）" style="flex:1">
        <button class="btn btn-primary" type="submit">追加</button>
      </form>
      <div style="font-size:12px;opacity:.7;margin-top:8px">前回選んだ担当者は端末ごとに記憶され、次回は最初から選択済みになります。</div>
    </div>

    ${masterCard('cat', 'category', S.categories,
      '区分マスタ（品目の区分の選択肢）',
      '名前を変更すると、その区分を使っている品目もまとめて新しい名前に更新されます。使用中の区分は削除できません。',
      '区分名（例：塗料）', 'add-cat')}

    ${masterCard('loc', 'location', S.locsMaster,
      '保管場所マスタ（品目の保管場所の選択肢）',
      '名前を変更すると、その保管場所を使っている品目もまとめて新しい名前に更新されます。使用中の保管場所は削除できません。',
      '保管場所名（例：松前工場）', 'add-loc')}

    <div class="settings-card office-only">
      <h3>データ</h3>
      <div style="font-size:13px;margin-bottom:12px">登録品目数：<strong class="num">${(S.items || []).length}</strong> 件</div>
      <button class="btn" data-act="seed">サンプルデータを投入（動作確認用・8品目）</button>
      <div style="font-size:12px;opacity:.7;margin-top:8px">画面の動きを確認するためのサンプル品目を登録します。不要になったら各品目の詳細画面から削除できます。</div>
    </div>

    <div class="settings-card">
      <h3>このアプリについて</h3>
      <div style="font-size:13px;line-height:1.9">
        よつば建設工業 消耗品在庫管理／データは Firebase（Firestore・Storage）に保存され、全端末でリアルタイム同期します。<br>
        電波の無い場所でも入出庫の記録はでき、電波が戻ると自動送信されます（写真だけは電波が必要です）。<br>
        スマホは「ホーム画面に追加」でアプリのように使えます。
      </div>
    </div>
  </div>
  ${tabbar('settings')}`;
}

// ---------- 入出庫モーダル（画面3） ----------

function openMove({ itemId = null, kind = '出庫' } = {}) {
  const item = itemId ? (S.items || []).find((i) => i.id === itemId) : null;
  M = {
    itemId,
    kind,
    qty: 1,
    person: local.get('lastPerson', ''),
    site: '',
    memo: (kind === '入庫' && item && item.orderStatus === '発注済') ? '発注分の入荷' : '',
    memoTouched: false,
  };
  renderMove();
}

function closeMove() { M = null; modalEl.innerHTML = ''; }

function renderMove() {
  if (!M) { modalEl.innerHTML = ''; return; }
  const items = S.items || [];
  const item = M.itemId ? items.find((i) => i.id === M.itemId) : null;
  const stock = item ? num(item.stock) : 0;
  const qty = Math.max(0, Math.floor(num(parseFloat(M.qty)) || 0));
  const after = item ? (M.kind === '入庫' ? stock + qty : Math.max(0, stock - qty)) : null;
  const short = item && M.kind === '出庫' && qty > stock;

  const itemField = item
    ? `<input class="input" type="text" value="${esc(item.name + '（' + (item.model || item.id) + '）')}" readonly>`
    : `<select class="input" id="mv-item" data-change="mv-item">
        <option value="">（品目を選択してください）</option>
        ${items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'))
          .map((i) => `<option value="${esc(i.id)}">${esc(i.name)}（${esc(i.model || i.id)}｜残 ${num(i.stock)}${esc(i.unit || '')}）</option>`).join('')}
      </select>`;

  const personField = S.persons.length
    ? `<select class="input" id="mv-person" data-change="mv-person">
        <option value="">（選択してください）</option>
        ${S.persons.map((p) => `<option ${M.person === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        ${M.person && !S.persons.some((p) => p.name === M.person) ? `<option selected>${esc(M.person)}</option>` : ''}
      </select>`
    : `<input class="input" id="mv-person" type="text" placeholder="氏名（設定画面で担当者を登録すると選択式になります）" value="${esc(M.person)}" data-input="mv-person">`;

  const siteField = M.kind === '出庫' ? `
    <div class="field">
      <label for="mv-site">使った現場（任意）</label>
      <select class="input" id="mv-site" data-change="mv-site">
        <option value="">（指定なし）</option>
        ${S.sites.map((s) => `<option ${M.site === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
    </div>` : '';

  modalEl.innerHTML = `
  <div class="modal-back" data-act="mv-back">
    <div class="modal" data-stop>
      <div class="modal-head">入出庫を記録<span class="x" data-act="mv-cancel">✕</span></div>
      <div class="modal-body">
        <div class="field"><label>品目</label>${itemField}</div>
        <div class="field">
          <label>記録区分</label>
          <div class="seg">
            <span class="seg-opt ${M.kind === '入庫' ? 'on' : ''}" data-act="mv-kind" data-kind="入庫" style="min-width:88px;justify-content:center">入庫</span>
            <span class="seg-opt ${M.kind === '出庫' ? 'on' : ''}" data-act="mv-kind" data-kind="出庫" style="min-width:88px;justify-content:center">出庫</span>
          </div>
        </div>
        <div class="field">
          <label for="mv-qty">数量${item ? `（${esc(item.unit || '')}）` : ''}</label>
          <div class="qty-row">
            <input id="mv-qty" class="input" type="number" min="0" inputmode="numeric" value="${qty}" data-input="mv-qty">
            <button class="btn qty-btn" data-act="mv-add" data-n="1">＋1</button>
            <button class="btn qty-btn" data-act="mv-add" data-n="5">＋5</button>
            <button class="btn qty-btn" data-act="mv-add" data-n="10">＋10</button>
          </div>
        </div>
        <div class="field"><label for="mv-person">担当者</label>${personField}</div>
        ${siteField}
        <div class="field">
          <label for="mv-memo">メモ</label>
          <input id="mv-memo" class="input" type="text" placeholder="用途など" value="${esc(M.memo)}" data-input="mv-memo">
        </div>
        ${item ? (short
          ? `<div class="warn-band">在庫が足りません（現在 ${stock} ${esc(item.unit || '')}）。出庫は ${stock} で止まります。</div>`
          : `<div class="preview-band" id="mv-preview">記録後の在庫数：${after} ${esc(item.unit || '')}</div>`)
          : `<div class="preview-band" style="opacity:.7">品目を選ぶと記録後の在庫数を表示します</div>`}
        <div class="modal-foot">
          <button class="btn" data-act="mv-cancel">キャンセル</button>
          <button class="btn btn-primary" data-act="mv-commit" style="min-width:120px;justify-content:center">記録する</button>
        </div>
      </div>
    </div>
  </div>`;
}

function commitMove() {
  if (!M) return;
  const item = (S.items || []).find((i) => i.id === M.itemId);
  if (!item) { toast('品目を選択してください'); return; }
  const qty = Math.max(0, Math.floor(num(parseFloat(M.qty)) || 0));
  if (qty <= 0) { toast('数量を入力してください'); return; }
  const actual = store.recordMove(item, {
    kind: M.kind, qty,
    person: M.person, site: M.kind === '出庫' ? M.site : '', memo: M.memo,
  });
  if (actual <= 0) { toast(`在庫が足りません（現在 ${num(item.stock)} ${item.unit || ''}）`); return; }
  if (M.person) local.set('lastPerson', M.person);
  const kind = M.kind;
  closeMove();
  toast(`${item.name}：${kind} ${actual} ${item.unit || ''} を記録しました${qty === actual ? '' : '（在庫分のみ）'}`);
}

// ---------- 品目 新規登録／編集モーダル ----------

function openItemForm(id = null) {
  F = { id };
  renderItemForm();
}
function closeItemForm() { F = null; modalEl.innerHTML = ''; }

function renderItemForm() {
  if (!F) { modalEl.innerHTML = ''; return; }
  const it = F.id ? (S.items || []).find((i) => i.id === F.id) || {} : {};
  const isNew = !F.id;
  const v = (x) => esc(x == null ? '' : x);
  const cats = categoryNames();   // マスタ＋使用中の値（編集中の品目の現在値も含まれる）
  const locs = locationNames();
  modalEl.innerHTML = `
  <div class="modal-back" data-act="if-back">
    <div class="modal modal-wide" data-stop>
      <div class="modal-head">${isNew ? '品目の新規登録' : '品目の編集'}<span class="x" data-act="if-cancel">✕</span></div>
      <form class="modal-body" data-form="item-form">
        <div class="form-grid">
          <div class="field"><label>品目コード${isNew ? '（空欄で自動採番）' : ''}</label>
            <input class="input" name="code" value="${v(F.id)}" ${isNew ? 'placeholder="例：A1"' : 'readonly'}></div>
          <div class="field"><label>品名 <span style="color:var(--red)">*</span></label>
            <input class="input" name="name" required value="${v(it.name)}" placeholder="例：軍手 すべり止め付"></div>
          <div class="field"><label>型番</label>
            <input class="input" name="model" value="${v(it.model)}" placeholder="例：KT-300"></div>
          <div class="field"><label>区分 <span style="color:var(--red)">*</span></label>
            <select class="input" name="category" required>
              ${cats.map((c) => `<option ${it.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select></div>
          ${isNew ? `
          <div class="field"><label>初期在庫数 <span style="color:var(--red)">*</span></label>
            <input class="input num" name="stock" type="number" min="0" required value="${v(it.stock ?? 0)}"></div>` : `
          <div class="field"><label>現在庫数</label>
            <input class="input num" type="number" value="${v(it.stock ?? 0)}" readonly title="在庫数の修正は棚卸モードで行ってください"></div>`}
          <div class="field"><label>最低在庫 <span style="color:var(--red)">*</span></label>
            <input class="input num" name="min" type="number" min="0" required value="${v(it.min ?? 0)}"></div>
          <div class="field"><label>単位 <span style="color:var(--red)">*</span></label>
            <select class="input" name="unit">
              ${UNITS.map((u) => `<option ${it.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
            </select></div>
          <div class="field"><label>単価（税抜・円） <span style="color:var(--red)">*</span></label>
            <input class="input num" name="price" type="number" min="0" required value="${v(it.price ?? 0)}"></div>
          <div class="field"><label>保管場所</label>
            <select class="input" name="location">
              <option value="">（未設定）</option>
              ${locs.map((l) => `<option ${it.location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select></div>
          <div class="field"><label>棚番</label>
            <input class="input" name="shelf" value="${v(it.shelf)}" placeholder="例：A-12"></div>
          <div class="field"><label>仕入先</label>
            <input class="input" name="supplier" value="${v(it.supplier)}" placeholder="例：丸信商会"></div>
          <div class="field"><label>標準納期</label>
            <input class="input" name="lead" value="${v(it.lead)}" placeholder="例：3日"></div>
        </div>
        ${isNew ? `<div style="font-size:12px;opacity:.7">現物写真は登録後、品目詳細の「写真を撮る／選ぶ」から追加できます。</div>` : ''}
        ${isNew ? '' : `<div style="font-size:12px;opacity:.7">在庫数の修正が必要な場合は、在庫一覧の「棚卸モード」をお使いください（調整履歴が残ります）。</div>`}
        <div class="modal-foot">
          <button class="btn" type="button" data-act="if-cancel">キャンセル</button>
          <button class="btn btn-primary" type="submit" style="min-width:120px;justify-content:center">${isNew ? '登録する' : '保存する'}</button>
        </div>
      </form>
    </div>
  </div>`;
}

function submitItemForm(form) {
  const fd = new FormData(form);
  const g = (k) => String(fd.get(k) || '').trim();
  const data = {
    name: g('name'),
    model: g('model'),
    category: g('category'),
    min: Math.max(0, parseInt(g('min'), 10) || 0),
    unit: g('unit'),
    price: Math.max(0, parseInt(g('price'), 10) || 0),
    location: g('location'),
    shelf: g('shelf'),
    supplier: g('supplier'),
    lead: g('lead'),
  };
  if (!data.name) { toast('品名を入力してください'); return; }

  if (F.id) {
    store.updateItem(F.id, data);
    closeItemForm();
    toast('品目を保存しました');
  } else {
    const code = g('code');
    if (code && (S.items || []).some((i) => i.id === code)) {
      toast(`品目コード「${code}」は既に使われています`);
      return;
    }
    data.stock = Math.max(0, parseInt(g('stock'), 10) || 0);
    const id = store.createItem(code || null, data);
    closeItemForm();
    toast('品目を登録しました');
    location.hash = '#/item/' + encodeURIComponent(id);
  }
}

// ---------- CSV ----------

function exportListCsv() {
  const rows = filteredItems().map((it) => {
    const st = statusOf(it);
    return [
      it.id, it.name, it.model || '', it.category || '', num(it.stock), num(it.min), it.unit || '',
      num(it.price), num(it.price) * num(it.stock), it.location || '', it.shelf || '', it.supplier || '',
      it.lead || '', fmtDate(it.last), st.status, it.orderStatus || '未発注',
    ];
  });
  downloadCsv(`在庫一覧_${fmtDate(new Date()).replaceAll('/', '')}.csv`, [
    ['品目コード', '品名', '型番', '区分', '現在庫数', '最低在庫', '単位', '単価(税抜)', '在庫金額(概算)', '保管場所', '棚番', '仕入先', '標準納期', '最終入出庫日', '状態', '発注状況'],
    ...rows,
  ]);
  toast('在庫一覧CSVを出力しました');
}

function exportOrdersCsv() {
  const items = (S.items || []).filter((i) => statusOf(i).rank < 2);
  const target = S.orderSel && S.orderSel.size
    ? items.filter((i) => S.orderSel.has(i.id))
    : items;
  if (!target.length) { toast('出力対象の品目がありません'); return; }
  const rows = target.map((it) => {
    const rec = recommendQty(it);
    return [
      it.id, it.name, it.model || '', it.category || '', num(it.stock), num(it.min), rec,
      it.unit || '', num(it.price), rec * num(it.price), it.supplier || '', it.lead || '',
      it.orderStatus || '未発注',
    ];
  });
  downloadCsv(`発注リスト_${fmtDate(new Date()).replaceAll('/', '')}.csv`, [
    ['品目コード', '品名', '型番', '区分', '現在庫', '最低在庫', '発注推奨数', '単位', '単価(税抜)', '発注予定金額', '仕入先', '標準納期', '発注状況'],
    ...rows,
  ]);
  toast(`発注リストCSVを出力しました（${rows.length} 件）`);
}

// ---------- 棚卸 ----------

function stocktakeCommitConfirm() {
  const st = S.stocktake;
  if (!st) return;
  const entries = [];
  for (const it of (S.items || [])) {
    const v = st.counts[it.id];
    if (v == null || v === '') continue;
    const counted = parseInt(v, 10);
    if (isNaN(counted) || counted < 0) continue;
    entries.push({ item: it, counted });
  }
  if (!entries.length) { toast('「数えた数」が入力されていません'); return; }
  const diffs = entries.filter((e) => e.counted !== num(e.item.stock));
  const msg = diffs.length
    ? `${entries.length} 件を棚卸します。うち ${diffs.length} 件に差異があります。調整を記録しますか？`
    : `${entries.length} 件を棚卸します（差異はありません）。確定しますか？`;
  if (!confirm(msg)) return;
  store.commitStocktake(entries, local.get('lastPerson', ''));
  S.stocktake = null;
  render();
  toast(`棚卸を確定しました（差異 ${diffs.length} 件を調整）`);
}

// ---------- 写真ビューア（ピンチで拡大縮小・ダブルタップで拡大/戻る・ドラッグで移動） ----------

// ---------- 区分・保管場所マスタ（設定画面） ----------

const MASTER_LABEL = { cat: '区分', loc: '保管場所' };

function addMasterEntry(kind, name) {
  const list = kind === 'cat' ? S.categories : S.locsMaster;
  if (!name) return;
  if (name.length > 100) { toast('名前は100文字以内で入力してください'); return; }
  if (list.some((m) => m.name === name)) { toast(`「${name}」は既に登録されています`); return; }
  store.addMaster(kind, name);
  toast(`${MASTER_LABEL[kind]}「${name}」を追加しました`);
}

async function saveMasterEdit(kind, id) {
  const me = S.masterEdit;
  if (!me || me.kind !== kind || me.id !== id) return;
  const list = kind === 'cat' ? S.categories : S.locsMaster;
  const cur = list.find((m) => m.id === id);
  const newName = (me.name || '').trim();
  if (!cur) { S.masterEdit = null; render(); return; }
  if (!newName) { toast('名前を入力してください'); return; }
  if (newName.length > 100) { toast('名前は100文字以内で入力してください'); return; }
  if (newName === cur.name) { S.masterEdit = null; render(); return; }
  if (list.some((m) => m.id !== id && m.name === newName)) { toast(`「${newName}」は既に登録されています`); return; }

  const field = kind === 'cat' ? 'category' : 'location';
  const n = (S.items || []).filter((i) => (i[field] || '') === cur.name).length;
  if (n && !confirm(`${MASTER_LABEL[kind]}「${cur.name}」を「${newName}」に変更しますか？\n使用中の品目 ${n} 件もまとめて新しい名前に更新されます。`)) return;

  S.masterEdit = null;
  render();
  try {
    const updated = await store.renameMaster(kind, id, cur.name, newName);
    toast(`「${cur.name}」を「${newName}」に変更しました${updated ? `（品目 ${updated} 件を更新）` : ''}`);
  } catch (e) {
    console.error('マスタ名の変更に失敗:', e);
    toast('名前を変更できませんでした。電波状況をご確認のうえ、もう一度お試しください。', 5000);
  }
}

function deleteMasterEntry(kind, id, name) {
  const field = kind === 'cat' ? 'category' : 'location';
  const n = (S.items || []).filter((i) => (i[field] || '') === name).length;
  if (n) { toast(`「${name}」は使用中のため削除できません（${n} 件）`, 4000); return; }
  if (!confirm(`${MASTER_LABEL[kind]}「${name}」を削除しますか？`)) return;
  store.removeMaster(kind, id);
  toast(`「${name}」を削除しました`);
}

function openPhotoViewer(item) {
  if (!item || !item.photo) return;
  const pv = document.createElement('div');
  pv.className = 'photoviewer';
  pv.innerHTML = `
    <div class="pv-top">
      <span class="pv-title">${esc(item.name)}　現物写真</span>
      <button class="pv-x" type="button" aria-label="閉じる">✕</button>
    </div>
    <div class="pv-stage"><img src="${esc(item.photo)}" alt="現物写真" draggable="false"></div>
    <div class="pv-hint">ピンチで拡大縮小／ダブルタップで拡大・戻る／ドラッグで移動／背景タップで閉じる</div>`;
  document.body.appendChild(pv);

  const stage = pv.querySelector('.pv-stage');
  const img = pv.querySelector('img');
  const MIN = 1, MAX = 5;
  let scale = 1, tx = 0, ty = 0;

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    stage.style.cursor = scale > 1 ? 'grab' : 'zoom-in';
  };

  // 画面上の点 p を固定したまま倍率を s2 へ（transform-origin は中央）
  const zoomAt = (p, s2) => {
    const s = Math.min(MAX, Math.max(MIN, s2));
    const r = stage.getBoundingClientRect();
    const px = p.x - r.left - r.width / 2;
    const py = p.y - r.top - r.height / 2;
    tx = px - (px - tx) * (s / scale);
    ty = py - (py - ty) * (s / scale);
    scale = s;
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  };

  const close = () => { document.removeEventListener('keydown', onKey); pv.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  pv.querySelector('.pv-x').addEventListener('click', close);

  // ポインタ（タッチ・マウス共通）でピンチ／パン／タップを処理
  const pointers = new Map();
  let start = null;   // 現在のジェスチャーの開始状態
  let lastTap = null; // ダブルタップ判定用

  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 非アクティブなポインタは無視 */ }
    const pts = Array.from(pointers.values());
    if (pts.length === 1) {
      start = { mode: 'pan', x: e.clientX, y: e.clientY, tx, ty, moved: false, t: Date.now(), onImg: e.target === img };
    } else if (pts.length === 2) {
      const [a, b] = pts;
      start = {
        mode: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        scale, tx, ty,
      };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = Array.from(pointers.values());
    if (start && start.mode === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s2 = Math.min(MAX, Math.max(MIN, start.scale * (dist / Math.max(1, start.dist))));
      const r = stage.getBoundingClientRect();
      const px = start.mid.x - r.left - r.width / 2;
      const py = start.mid.y - r.top - r.height / 2;
      // 開始時の中点を基準に拡大し、中点の移動ぶんだけパンする
      tx = px - (px - start.tx) * (s2 / start.scale) + (mid.x - start.mid.x);
      ty = py - (py - start.ty) * (s2 / start.scale) + (mid.y - start.mid.y);
      scale = s2;
      apply();
    } else if (start && start.mode === 'pan' && pts.length === 1) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 8) start.moved = true;
      if (scale > 1) { tx = start.tx + dx; ty = start.ty + dy; apply(); }
    }
  });

  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (start && start.mode === 'pan' && pointers.size === 0) {
      const isTap = !start.moved && Date.now() - start.t < 300;
      if (isTap) {
        const p = { x: e.clientX, y: e.clientY };
        const now = Date.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
          zoomAt(p, scale > 1 ? 1 : 2.5); // ダブルタップ: 拡大 ⇔ 等倍
          lastTap = null;
        } else {
          lastTap = { x: p.x, y: p.y, t: now };
          if (!start.onImg && scale === 1) {
            // 背景のシングルタップで閉じる（ダブルタップと区別するため少し待つ）
            setTimeout(() => { if (lastTap && lastTap.t === now) close(); }, 330);
          }
        }
      }
      start = null;
    } else if (start && start.mode === 'pinch' && pointers.size < 2) {
      // ピンチ終了 → 残った指はそのままパンに移行
      const pts = Array.from(pointers.values());
      start = pts.length === 1
        ? { mode: 'pan', x: pts[0].x, y: pts[0].y, tx, ty, moved: true, t: Date.now(), onImg: true }
        : null;
      if (scale <= 1.02) { scale = 1; tx = 0; ty = 0; apply(); }
    } else if (pointers.size === 0) {
      start = null;
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  // PC: マウスホイールでも拡大縮小できる
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt({ x: e.clientX, y: e.clientY }, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  }, { passive: false });

  apply();
}

// ---------- 写真アップロード ----------

async function handlePhoto(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const item = (S.items || []).find((i) => i.id === input.dataset.id);
  input.value = '';
  if (!item) return;
  toast('写真をアップロードしています…', 15000);
  try {
    await store.uploadPhoto(item, file, local.get('lastPerson', ''));
    toast('写真を保存しました（全端末に反映されます）');
  } catch (e) {
    console.error('写真アップロード失敗:', e);
    toast('写真を保存できませんでした。電波のある場所でもう一度お試しください。', 5000);
  }
}

// ---------- 描画 ----------

function render() {
  document.body.classList.toggle('mode-field', mode() === 'field');
  // 下部タブバーは消耗品セクションだけ。玄関・鋼材では下の余白を付けない
  const inShohin = S.route.view !== 'home' && S.route.view !== 'steel';
  document.body.classList.toggle('has-tabbar', inShohin);

  // フォーカス保持（検索・棚卸入力などの再描画対策）
  const active = document.activeElement;
  const focusId = active && active.id;
  let selStart = null;
  try { selStart = active && active.selectionStart; } catch (_) { /* 非対応要素 */ }

  let view;
  // 玄関と鋼材は消耗品の読み込みを待たない（それぞれ自前の読み込み表示を持つ）
  if (S.route.view === 'home') view = home.view();
  else if (S.route.view === 'steel') view = steel.view();
  else if (S.items === null && !S.authError) {
    view = `${pcHeader('')}<div class="page" style="text-align:center;padding-top:64px;opacity:.7">データを読み込んでいます…</div>`;
  } else if (S.route.view === 'item') view = viewItem();
  else if (S.route.view === 'orders') view = viewOrders();
  else if (S.route.view === 'settings') view = viewSettings();
  else if (S.route.view === 'list') view = viewList();
  else view = viewMenu();

  appEl.innerHTML = connBanner() + view;

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (selStart != null) { try { el.setSelectionRange(selStart, selStart); } catch (_) { /* number等 */ } }
    }
  }
}

// ---------- イベント（委譲） ----------

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); location.hash = nav.dataset.nav; return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  // モーダル内クリックが背景の閉じる判定に吸われないように
  if ((el.dataset.act === 'mv-back' || el.dataset.act === 'if-back') && e.target.closest('[data-stop]')) return;
  const id = el.dataset.id;

  switch (el.dataset.act) {
    // 一覧
    case 'goto-item': location.hash = '#/item/' + encodeURIComponent(id); break;
    case 'photo-view': openPhotoViewer((S.items || []).find((i) => i.id === id)); break;
    // 区分メニューのタイル → その区分の一覧へ（絞り込みは毎回まっさらな状態から）
    case 'goto-cat':
      S.q = ''; S.loc = 'すべて'; S.onlyShort = false;
      location.hash = catHref(el.dataset.cat);
      break;
    case 'page-prev': S.page = Math.max(1, S.page - 1); render(); window.scrollTo(0, 0); break;
    case 'page-next': S.page = S.page + 1; render(); window.scrollTo(0, 0); break;
    case 'sp-more': S.spCount += 12; render(); break;
    case 'csv-list': exportListCsv(); break;

    // 棚卸
    case 'stocktake-start': S.stocktake = { counts: {} }; render(); break;
    case 'stocktake-cancel':
      if (Object.values(S.stocktake?.counts || {}).some((v) => v !== '') &&
          !confirm('入力した「数えた数」を破棄して棚卸を中止しますか？')) break;
      S.stocktake = null; render(); break;
    case 'stocktake-commit': stocktakeCommitConfirm(); break;

    // 入出庫モーダル
    case 'open-move': openMove({ itemId: id || null, kind: el.dataset.kind || '出庫' }); break;
    case 'mv-kind': {
      M.kind = el.dataset.kind;
      const item = (S.items || []).find((i) => i.id === M.itemId);
      if (!M.memoTouched) {
        M.memo = (M.kind === '入庫' && item && item.orderStatus === '発注済') ? '発注分の入荷' : '';
      }
      renderMove(); break;
    }
    case 'mv-add': M.qty = Math.max(0, (parseInt(M.qty, 10) || 0) + parseInt(el.dataset.n, 10)); renderMove(); break;
    case 'mv-commit': commitMove(); break;
    case 'mv-cancel': case 'mv-back': closeMove(); break;

    // 品目マスタ
    case 'new-item': openItemForm(null); break;
    case 'edit-item': openItemForm(id); break;
    case 'delete-item': {
      const it = (S.items || []).find((i) => i.id === id);
      if (!it) break;
      if (!confirm(`「${it.name}」を削除しますか？\n入出庫履歴と写真も削除されます。この操作は取り消せません。`)) break;
      store.deleteItem(it);
      location.hash = S.listHash;
      toast('品目を削除しました');
      break;
    }
    case 'if-cancel': case 'if-back': closeItemForm(); break;

    // 発注
    case 'order-request': {
      const it = (S.items || []).find((i) => i.id === id);
      if (!it) break;
      if (!confirm(`「${it.name}」を発注済にしますか？\n（発注推奨数 ${recommendQty(it)} ${it.unit || ''}／入庫を記録すると自動で未発注に戻ります）`)) break;
      store.setOrderStatus([id], '発注済');
      toast('発注済にしました');
      break;
    }
    case 'mark-ordered': {
      const sel = Array.from(S.orderSel || []);
      if (!sel.length) { toast('品目が選択されていません'); break; }
      if (!confirm(`選択した ${sel.length} 件を「発注済」にしますか？`)) break;
      store.setOrderStatus(sel, '発注済');
      toast(`${sel.length} 件を発注済にしました`);
      break;
    }
    case 'csv-orders': exportOrdersCsv(); break;

    // 設定
    case 'set-mode':
      local.set('mode', el.dataset.mode); render();
      toast(el.dataset.mode === 'office' ? '事務所モードに切り替えました' : '現場モードに切り替えました');
      break;
    case 'del-site':
      if (confirm('この現場を削除しますか？（過去の記録はそのまま残ります）')) store.removeSite(id);
      break;
    case 'master-edit': S.masterEdit = { kind: el.dataset.kind, id, name: el.dataset.name }; render(); break;
    case 'master-cancel': S.masterEdit = null; render(); break;
    case 'master-save': saveMasterEdit(el.dataset.kind, id); break;
    case 'master-del': deleteMasterEntry(el.dataset.kind, id, el.dataset.name); break;
    case 'del-person':
      if (confirm('この担当者を削除しますか？（過去の記録はそのまま残ります）')) store.removePerson(id);
      break;
    case 'seed':
      if (confirm('動作確認用のサンプル品目（8件）と現場（3件）を登録します。よろしいですか？')) {
        store.seedSamples();
        toast('サンプルデータを投入しました');
      }
      break;
  }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  switch (el.dataset.input) {
    case 'query': S.q = el.value; S.page = 1; S.spCount = 12; render(); break;
    case 'stocktake': if (S.stocktake) { S.stocktake.counts[el.dataset.id] = el.value; render(); } break;
    case 'mv-qty': {
      if (!M) break;
      M.qty = el.value;
      // フォーカスを奪わないよう、プレビュー帯だけ差し替え
      const item = (S.items || []).find((i) => i.id === M.itemId);
      if (item) {
        const qty = Math.max(0, Math.floor(num(parseFloat(M.qty)) || 0));
        const stock = num(item.stock);
        const short = M.kind === '出庫' && qty > stock;
        const band = modalEl.querySelector('.preview-band, .warn-band');
        if (band) {
          band.className = short ? 'warn-band' : 'preview-band';
          band.textContent = short
            ? `在庫が足りません（現在 ${stock} ${item.unit || ''}）。出庫は ${stock} で止まります。`
            : `記録後の在庫数：${M.kind === '入庫' ? stock + qty : Math.max(0, stock - qty)} ${item.unit || ''}`;
        }
      }
      break;
    }
    case 'mv-person': if (M) M.person = el.value; break;
    case 'mv-memo': if (M) { M.memo = el.value; M.memoTouched = true; } break;
    case 'master-edit-name': if (S.masterEdit) S.masterEdit.name = el.value; break;
  }
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  switch (el.dataset.change) {
    case 'loc': S.loc = el.value; S.page = 1; S.spCount = 12; render(); break;
    case 'only-short': S.onlyShort = el.checked; S.page = 1; S.spCount = 12; render(); break;
    case 'sp-sort': S.spSort = el.value; local.set('spSort', el.value); S.spCount = 12; render(); break;
    case 'photo': handlePhoto(el); break;
    case 'order-sel':
      if (el.checked) S.orderSel.add(el.dataset.id); else S.orderSel.delete(el.dataset.id);
      render(); break;
    case 'order-sel-all': {
      const all = (S.items || []).filter((i) => statusOf(i).rank < 2).map((i) => i.id);
      S.orderSel = el.checked ? new Set(all) : new Set();
      render(); break;
    }
    case 'order-status': store.setOrderStatus([el.dataset.id], el.value); break;
    case 'mv-item': if (M) { M.itemId = el.value || null; renderMove(); } break;
    case 'mv-person': if (M) M.person = el.value; break;
    case 'mv-site': if (M) M.site = el.value; break;
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  switch (form.dataset.form) {
    case 'item-form': submitItemForm(form); break;
    // 区分メニューの検索 → 全区分を対象にした一覧へ遷移
    case 'menu-search': {
      S.q = String(new FormData(form).get('q') || '').trim();
      S.loc = 'すべて'; S.onlyShort = false;
      const el = document.getElementById('menuq');
      if (el) el.blur(); // スマホのキーボードを閉じてから遷移
      location.hash = '#/list';
      break;
    }
    case 'add-site': {
      const name = String(new FormData(form).get('name') || '').trim();
      if (name) { store.addSite(name); form.reset(); }
      break;
    }
    case 'add-person': {
      const name = String(new FormData(form).get('name') || '').trim();
      if (name) { store.addPerson(name); form.reset(); }
      break;
    }
    case 'add-cat': case 'add-loc': {
      const name = String(new FormData(form).get('name') || '').trim();
      if (name) { addMasterEntry(form.dataset.form === 'add-cat' ? 'cat' : 'loc', name); form.reset(); }
      break;
    }
  }
});

// ---------- 初期表示 ----------
onRoute();
