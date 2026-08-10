// ============================================================
// Firestore データ層（鋼材）— カタログ・在庫・履歴
//
// 消耗品側のコレクション（items / logs / sites / persons / categories / locations）には
// 一切触れない。鋼材は steelCatalog / steelStock / steelLogs の3つだけを使う。
//
// 設計メモ:
// ・steelCatalog は数千件になるため常時購読しない。カタログモードに入ったときだけ
//   getDocs で一度読み、メモリに持つ（オフライン永続化が効くので2回目以降は差分だけ）。
// ・steelStock は「在庫に出した品目」だけ（数百件）。表示に必要な項目をカタログから
//   コピーして持たせてあるので、在庫一覧はカタログを読まずに描ける。
// ・ドキュメントIDはカタログ・在庫とも itemKey()（種類＋材質＋サイズ＋スケジュール）で共通。
// ・在庫の増減は increment() を使い、複数端末の同時操作でも矛盾しないようにする。
// ============================================================

import {
  db,
  collection, doc, setDoc, updateDoc,
  getDocs, onSnapshot, query, where,
  serverTimestamp, writeBatch, increment, Timestamp,
} from './firebase.js?v=22';
import { num } from './util.js?v=22';
import { SITE_KEYS, totalQty } from './steel-util.js?v=22';

const catalogCol = collection(db, 'steelCatalog');
const stockCol = collection(db, 'steelStock');
const logsCol = collection(db, 'steelLogs');

// 在庫ドキュメントにコピーしておく表示用の項目
// （在庫一覧・品目詳細をカタログ抜きで描くために必要な分だけ）
const DENORM_KEYS = [
  'code', 'category', 'materialClass', 'material', 'size', 'sch', 'name', 'jis',
  'dims', 'unitWeight', 'weightUnit', 'unit', 'price', 'supplier', 'sortOrder', 'pressure',
];

function pickDenorm(src) {
  const out = {};
  for (const k of DENORM_KEYS) out[k] = src[k] == null ? null : src[k];
  return out;
}

// ---------- 購読・読み込み ----------

export function watchStock(cb, onError) {
  return onSnapshot(stockCol, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

// カタログ全件（カタログモードに入るときに呼ぶ）
export async function loadCatalog() {
  const snap = await getDocs(catalogCol);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// 品目ごとの履歴（等価条件のみ → 複合インデックス不要。並びはクライアント側）
export function watchItemLogs(itemId, cb, onError) {
  const q = query(logsCol, where('itemId', '==', itemId));
  return onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0));
    cb(rows);
  }, onError);
}

// ---------- 在庫の増減（履歴つき） ----------

// 台帳方式: 誰が・いつ・何本・どの拠点。増減は必ずここを通す。
export function adjustQty(stockItem, site, delta, person) {
  const d = Math.floor(num(delta));
  if (!d || !SITE_KEYS.includes(site)) return 0;

  const current = num(stockItem[site]);
  const actual = d < 0 ? -Math.min(-d, current) : d; // 0未満にはしない
  if (!actual) return 0;

  const after = current + actual;
  const batch = writeBatch(db);
  batch.set(doc(logsCol), {
    itemId: stockItem.id,
    at: Timestamp.now(),
    kind: actual > 0 ? '入庫' : '出庫',
    site,
    qty: Math.abs(actual),
    after,
    person: person || '',
    memo: '',
  });
  batch.update(doc(stockCol, stockItem.id), {
    [site]: increment(actual),
    last: Timestamp.now(),
    updatedAt: serverTimestamp(),
  });
  batch.commit().catch((e) => console.error('鋼材の在庫更新に失敗:', e));
  return actual;
}

// ---------- カタログ → 在庫に追加 ----------

export function addToInventory(catalogItem, { site, qty, person, safety }) {
  const n = Math.max(0, Math.floor(num(qty)));
  const id = catalogItem.id;
  const base = {
    ...pickDenorm(catalogItem),
    inInventory: true,
    hidden: false,
    safety: safety == null ? num(catalogItem.safety) : num(safety),
    location: catalogItem.location || '',
    last: Timestamp.now(),
    updatedAt: serverTimestamp(),
  };
  // 既に在庫にある品目を再度追加した場合も想定し、拠点数量は increment で足す
  for (const k of SITE_KEYS) base[k] = k === site ? increment(n) : increment(0);

  const batch = writeBatch(db);
  batch.set(doc(stockCol, id), { ...base, createdAt: serverTimestamp() }, { merge: true });
  if (n > 0) {
    batch.set(doc(logsCol), {
      itemId: id,
      at: Timestamp.now(),
      kind: '在庫登録',
      site,
      qty: n,
      after: n,
      person: person || '',
      memo: 'カタログから在庫に追加',
    });
  }
  batch.commit().catch((e) => console.error('在庫への追加に失敗:', e));
}

// ---------- 表示・非表示・適正在庫 ----------

export function setHidden(id, hidden) {
  updateDoc(doc(stockCol, id), { hidden: !!hidden, updatedAt: serverTimestamp() })
    .catch((e) => console.error('表示状態の更新に失敗:', e));
}

export function setSafety(id, safety) {
  updateDoc(doc(stockCol, id), { safety: Math.max(0, Math.floor(num(safety))), updatedAt: serverTimestamp() })
    .catch((e) => console.error('適正在庫の更新に失敗:', e));
}

export function setLocation(id, location) {
  updateDoc(doc(stockCol, id), { location: String(location || ''), updatedAt: serverTimestamp() })
    .catch((e) => console.error('保管場所の更新に失敗:', e));
}

// ---------- CSV一括取込 ----------

// 取込前の内訳（プレビュー用）。既存カタログと突き合わせて新規／更新を数える。
export function summarizeImport(rows, existingIds) {
  let created = 0, updated = 0, stockRows = 0;
  for (const r of rows) {
    if (existingIds.has(r.key)) updated++; else created++;
    if (Object.values(r.stock.qty).some((v) => v != null) || r.stock.explicitInInventory) stockRows++;
  }
  return { created, updated, stockRows, total: rows.length };
}

// ---------- 差分削除 ----------
// CSVに無くなった品目をカタログから消す。
// 品目の同一性は「種類＋材質＋サイズ＋スケジュール」＝ドキュメントIDなので、
// CSV側でこの4項目を直すと別IDの新しい品目が増え、古いほうが取り残される。
// それを掃除するための機能（在庫に出している品目は必ず残す）。
export function planDiffDelete(catalogItems, csvKeys, stockById) {
  const targets = [];
  const keptInStock = [];
  for (const c of catalogItems) {
    if (csvKeys.has(c.id)) continue;      // CSVにある = 残す
    if (stockById.has(c.id)) keptInStock.push(c); // 在庫に出している = 消さない
    else targets.push(c);
  }
  return { targets, keptInStock };
}

export async function deleteCatalogByIds(ids, { onProgress } = {}) {
  const PER_BATCH = 400; // 1バッチ500操作の制限に対する余裕分
  let done = 0;
  for (let i = 0; i < ids.length; i += PER_BATCH) {
    const chunk = ids.slice(i, i + PER_BATCH);
    const batch = writeBatch(db);
    chunk.forEach((id) => batch.delete(doc(catalogCol, id)));
    await batch.commit();
    done += chunk.length;
    if (onProgress) onProgress(done, ids.length);
  }
  return done;
}

// 実行。1バッチ500操作の制限に合わせて分割し、進捗をコールバックで返す。
// stockById: 現在の在庫（在庫数の差分を履歴に残すために使う）
export async function importCatalog(rows, { person, stockById, onProgress } = {}) {
  const OPS_PER_BATCH = 400;
  let batch = writeBatch(db);
  let ops = 0;
  let done = 0;

  const flush = async () => {
    if (!ops) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const r of rows) {
    const id = r.key;
    batch.set(doc(catalogCol, id), {
      ...r.catalog,
      safety: r.stock.safety, // カタログ側にも既定の適正在庫を持たせておく
      updatedAt: serverTimestamp(),
    }, { merge: true });
    ops++;

    const cur = (stockById && stockById.get(id)) || null;
    const qtyGiven = Object.values(r.stock.qty).some((v) => v != null);
    const wantStock = r.stock.inInventory || (cur && cur.inInventory);

    if (wantStock) {
      const upd = {
        ...pickDenorm(r.catalog),
        inInventory: true,
        updatedAt: serverTimestamp(),
      };
      if (r.stock.safety != null) upd.safety = r.stock.safety;
      if (r.stock.location) upd.location = r.stock.location;
      if (!cur) {
        upd.hidden = false;
        upd.createdAt = serverTimestamp();
        for (const k of SITE_KEYS) upd[k] = num(r.stock.qty[k]); // 新規は空欄=0
      } else {
        // 空欄の拠点は現在値のまま。数値が書かれた拠点だけ上書きする
        for (const k of SITE_KEYS) if (r.stock.qty[k] != null) upd[k] = r.stock.qty[k];
      }
      batch.set(doc(stockCol, id), upd, { merge: true });
      ops++;

      // 在庫数が実際に変わる行だけ履歴を残す（カタログ情報だけの更新では残さない）
      if (qtyGiven) {
        const before = cur ? totalQty(cur) : 0;
        const after = SITE_KEYS.reduce(
          (t, k) => t + (r.stock.qty[k] != null ? num(r.stock.qty[k]) : num(cur ? cur[k] : 0)), 0);
        if (after !== before) {
          batch.set(doc(logsCol), {
            itemId: id,
            at: Timestamp.now(),
            kind: 'CSV取込',
            site: '',
            qty: after - before,
            after,
            person: person || '',
            memo: `CSV取込による設定（${before} → ${after}）`,
          });
          ops++;
        }
      }
    }

    done++;
    if (ops >= OPS_PER_BATCH) {
      await flush();
      if (onProgress) onProgress(done, rows.length);
    }
  }
  await flush();
  if (onProgress) onProgress(done, rows.length);
  return done;
}
