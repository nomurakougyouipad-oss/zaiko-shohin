// ============================================================
// Firestore データ層 — 品目(items)・入出庫履歴(logs)・現場(sites)・担当者(persons)
//
// 設計メモ:
// ・logs はトップレベルコレクション（itemId フィールドで品目に紐付け）。
//   等価条件のみ／単一フィールド範囲のみのクエリに揃え、複合インデックス不要にしている。
// ・書き込みは await しない（オフライン時は端末に保持され、復帰時に自動送信。
//   画面は onSnapshot のローカル反映で即時更新される）。
// ・在庫の増減は increment() を使い、複数端末の同時記録でも矛盾しないようにする。
// ============================================================

import {
  db, storage,
  collection, doc, setDoc, updateDoc, deleteDoc,
  getDocs, onSnapshot, query, where, orderBy,
  serverTimestamp, writeBatch, increment, Timestamp,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
} from './firebase.js?v=25';
import { resizeImage } from './image.js?v=25';
import { monthStart, num, CATEGORIES } from './util.js?v=25';

const itemsCol = collection(db, 'items');
const logsCol = collection(db, 'logs');
const sitesCol = collection(db, 'sites');
const personsCol = collection(db, 'persons');
const categoriesCol = collection(db, 'categories');
const locationsCol = collection(db, 'locations');

// ---------- 監視（リアルタイム購読） ----------

export function watchItems(cb, onError) {
  return onSnapshot(itemsCol, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

// 今月＋前月の履歴（KPI「今月の出庫件数／前月比」用）
export function watchRecentLogs(cb, onError) {
  const q = query(logsCol, where('at', '>=', Timestamp.fromDate(monthStart(-1))));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

// 品目ごとの履歴（等価条件のみ → 複合インデックス不要。並びはクライアント側）
export function watchItemLogs(itemId, cb, onError) {
  const q = query(logsCol, where('itemId', '==', itemId));
  return onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => tsMillis(b.at) - tsMillis(a.at));
    cb(rows);
  }, onError);
}

export function watchSites(cb, onError) {
  return onSnapshot(query(sitesCol, orderBy('name')), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

export function watchPersons(cb, onError) {
  return onSnapshot(query(personsCol, orderBy('name')), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

function tsMillis(v) { return v && v.toMillis ? v.toMillis() : 0; }

// ---------- 区分・保管場所マスタ ----------
// kind: 'cat'（区分）| 'loc'（保管場所）。並びは order（登録順）→ 名前。

const masterCol = (kind) => (kind === 'cat' ? categoriesCol : locationsCol);
const masterField = (kind) => (kind === 'cat' ? 'category' : 'location');

function watchMaster(col, cb, onError) {
  return onSnapshot(col, (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      String(a.name).localeCompare(String(b.name), 'ja'));
    cb(rows);
  }, onError);
}

export function watchCategories(cb, onError) { return watchMaster(categoriesCol, cb, onError); }
export function watchLocations(cb, onError) { return watchMaster(locationsCol, cb, onError); }

export function addMaster(kind, name) {
  setDoc(doc(masterCol(kind)), { name, order: Date.now(), createdAt: serverTimestamp() })
    .catch((e) => console.error('マスタの追加に失敗:', e));
}

export function removeMaster(kind, id) {
  deleteDoc(doc(masterCol(kind), id)).catch((e) => console.error('マスタの削除に失敗:', e));
}

// 名前変更。使用中の品目（category / location が旧名のもの）もまとめて新名に更新する
export async function renameMaster(kind, id, oldName, newName) {
  await updateDoc(doc(masterCol(kind), id), { name: newName });
  const field = masterField(kind);
  const snap = await getDocs(query(itemsCol, where(field, '==', oldName)));
  const refs = snap.docs.map((d) => d.ref);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => batch.update(r, { [field]: newName, updatedAt: serverTimestamp() }));
    await batch.commit();
  }
  return refs.length;
}

// 初期投入（マスタが空のときだけ）: 現在の固定選択肢＋既存品目で使用中の値を登録する。
// ドキュメントIDに名前を使い、複数端末が同時に実行しても重複しないようにする。
export async function ensureMasters(items) {
  const docId = (name) => name.replaceAll('/', '／');
  try {
    const [catSnap, locSnap] = await Promise.all([getDocs(categoriesCol), getDocs(locationsCol)]);
    if (catSnap.empty) {
      const names = [...CATEGORIES];
      for (const it of items) if (it.category && !names.includes(it.category)) names.push(it.category);
      const batch = writeBatch(db);
      names.forEach((name, i) =>
        batch.set(doc(categoriesCol, docId(name)), { name, order: i, createdAt: serverTimestamp() }, { merge: true }));
      await batch.commit();
    }
    if (locSnap.empty) {
      const names = Array.from(new Set(items.map((i) => i.location).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b, 'ja'));
      for (const extra of ['松前工場', '伊予工場']) if (!names.includes(extra)) names.push(extra);
      const batch = writeBatch(db);
      names.forEach((name, i) =>
        batch.set(doc(locationsCol, docId(name)), { name, order: i, createdAt: serverTimestamp() }, { merge: true }));
      await batch.commit();
    }
  } catch (e) {
    // ルール未適用・オフライン等では投入できないが、アプリ自体は動かす
    console.warn('区分・保管場所マスタの初期投入をスキップ:', e);
  }
}

// ---------- 入出庫記録 ----------

// 入庫・出庫を1件記録（在庫増減＋履歴追加＋最終入出庫日更新＋発注状況の自動復帰）
// 戻り値: 実際に記録した数量（出庫は在庫を下回らないよう丸める）
export function recordMove(item, { kind, qty, person, site, memo }) {
  const n = Math.max(0, Math.floor(num(qty)));
  const actual = kind === '出庫' ? Math.min(n, num(item.stock)) : n;
  if (actual <= 0) return 0;

  const delta = kind === '入庫' ? actual : -actual;
  const after = Math.max(0, num(item.stock) + delta);

  const batch = writeBatch(db);
  batch.set(doc(logsCol), {
    itemId: item.id,
    at: Timestamp.now(),
    kind,
    qty: actual,
    after,
    person: person || '',
    site: site || '',
    memo: memo || '',
  });
  const upd = {
    stock: increment(delta),
    last: Timestamp.now(),
    updatedAt: serverTimestamp(),
  };
  // 発注済の品目に入庫 → 自動で「未発注」に戻す
  if (kind === '入庫' && item.orderStatus === '発注済') upd.orderStatus = '未発注';
  batch.update(doc(itemsCol, item.id), upd);
  batch.commit().catch((e) => console.error('入出庫の記録に失敗:', e));
  return actual;
}

// ---------- 棚卸 ----------

// entries: [{ item, counted }] 差異は「棚卸調整」履歴として自動記録
export function commitStocktake(entries, person) {
  const now = Timestamp.now();
  // 1バッチ500操作の制限に備えて分割
  const chunks = [];
  for (let i = 0; i < entries.length; i += 200) chunks.push(entries.slice(i, i + 200));
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const { item, counted } of chunk) {
      const diff = counted - num(item.stock);
      const upd = { lastCounted: now, updatedAt: serverTimestamp() };
      if (diff !== 0) {
        upd.stock = counted;
        upd.last = now;
        batch.set(doc(logsCol), {
          itemId: item.id,
          at: now,
          kind: '棚卸調整',
          qty: diff,
          after: counted,
          person: person || '',
          site: '',
          memo: '棚卸による調整',
        });
      }
      batch.update(doc(itemsCol, item.id), upd);
    }
    batch.commit().catch((e) => console.error('棚卸の確定に失敗:', e));
  }
}

// ---------- 品目マスタ ----------

// 新規登録（code を品目コード＝ドキュメントIDとして使う。未指定なら自動ID）
export function createItem(code, data) {
  const ref = code ? doc(itemsCol, code) : doc(itemsCol);
  setDoc(ref, {
    ...data,
    orderStatus: '未発注',
    photo: data.photo || '',
    last: null,
    lastCounted: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }).catch((e) => console.error('品目の登録に失敗:', e));
  return ref.id;
}

export function updateItem(id, data) {
  updateDoc(doc(itemsCol, id), { ...data, updatedAt: serverTimestamp() })
    .catch((e) => console.error('品目の更新に失敗:', e));
}

// 品目削除（履歴・写真も削除）
export async function deleteItem(item) {
  const snap = await getDocs(query(logsCol, where('itemId', '==', item.id)));
  const refs = snap.docs.map((d) => d.ref);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    batch.commit().catch((e) => console.error('履歴の削除に失敗:', e));
  }
  deleteDoc(doc(itemsCol, item.id)).catch((e) => console.error('品目の削除に失敗:', e));
  if (item.photo) {
    deleteObject(storageRef(storage, `items/${item.id}/photo.jpg`)).catch(() => { /* 写真なしは無視 */ });
  }
}

export function setOrderStatus(ids, status) {
  const batch = writeBatch(db);
  ids.forEach((id) => batch.update(doc(itemsCol, id), { orderStatus: status, updatedAt: serverTimestamp() }));
  batch.commit().catch((e) => console.error('発注状況の更新に失敗:', e));
}

// ---------- 写真（1品目1枚・上書き。オンライン必須） ----------

export async function uploadPhoto(item, file, person) {
  const blob = await resizeImage(file);
  const ref = storageRef(storage, `items/${item.id}/photo.jpg`);
  await uploadBytes(ref, blob, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(ref);
  await updateDoc(doc(itemsCol, item.id), {
    photo: url,
    photoAt: Timestamp.now(),
    photoBy: person || '',
    updatedAt: serverTimestamp(),
  });
  return url;
}

// ---------- 現場・担当者マスタ ----------

export function addSite(name) {
  setDoc(doc(sitesCol), { name, createdAt: serverTimestamp() })
    .catch((e) => console.error('現場の追加に失敗:', e));
}
export function removeSite(id) {
  deleteDoc(doc(sitesCol, id)).catch((e) => console.error('現場の削除に失敗:', e));
}
export function addPerson(name) {
  setDoc(doc(personsCol), { name, createdAt: serverTimestamp() })
    .catch((e) => console.error('担当者の追加に失敗:', e));
}
export function removePerson(id) {
  deleteDoc(doc(personsCol, id)).catch((e) => console.error('担当者の削除に失敗:', e));
}

// ---------- サンプルデータ（動作確認用。設定画面から投入） ----------

const SAMPLE_ITEMS = [
  { code: 'A1', name: '軍手 すべり止め付', model: 'KT-300', category: '保護具', stock: 42, min: 60, unit: '双', price: 68, location: '資材倉庫A', shelf: 'A-12', supplier: '丸信商会', lead: '3日' },
  { code: 'A2', name: '溶接棒 低水素系 φ4.0', model: 'LB-52', category: '溶接材料', stock: 16, min: 12, unit: '箱', price: 4200, location: '溶接場棚', shelf: 'W-03', supplier: '東鋼溶材', lead: '5日' },
  { code: 'A3', name: 'ウエス 白 10kg', model: 'WS-10', category: '清掃用品', stock: 24, min: 8, unit: '袋', price: 1850, location: '資材倉庫B', shelf: 'B-04', supplier: '丸信商会', lead: '2日' },
  { code: 'A4', name: '切断砥石 φ180', model: 'CD-180', category: '刃物・砥石', stock: 9, min: 20, unit: '枚', price: 210, location: '工作場棚', shelf: 'K-08', supplier: '中部工機', lead: '4日' },
  { code: 'A5', name: '防塵マスク DS2', model: 'MK-DS2', category: '保護具', stock: 60, min: 30, unit: '枚', price: 145, location: '事務所倉庫', shelf: 'J-02', supplier: '安全産業', lead: '3日' },
  { code: 'A6', name: '自動遮光溶接面', model: 'WM-A9', category: '保護具', stock: 5, min: 4, unit: '個', price: 18500, location: '溶接場棚', shelf: 'W-01', supplier: '東鋼溶材', lead: '7日' },
  { code: 'A7', name: 'バリ取りカッター', model: 'BR-45', category: '刃物・砥石', stock: 15, min: 6, unit: '本', price: 980, location: '工作場棚', shelf: 'K-02', supplier: '中部工機', lead: '4日' },
  { code: 'A8', name: '養生テープ 50mm', model: 'YT-50', category: '資材', stock: 30, min: 24, unit: '巻', price: 320, location: '資材倉庫A', shelf: 'A-05', supplier: '丸信商会', lead: '2日' },
];
const SAMPLE_SITES = ['駅前ビル改修', '第3工場 増築', '市営住宅 外構'];

export function seedSamples() {
  const batch = writeBatch(db);
  for (const { code, ...data } of SAMPLE_ITEMS) {
    batch.set(doc(itemsCol, code), {
      ...data,
      orderStatus: '未発注',
      photo: '',
      last: Timestamp.now(),
      lastCounted: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  for (const name of SAMPLE_SITES) {
    batch.set(doc(sitesCol), { name, createdAt: serverTimestamp() });
  }
  batch.commit().catch((e) => console.error('サンプル投入に失敗:', e));
  return SAMPLE_ITEMS.length;
}
