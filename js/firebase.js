// ============================================================
// Firebase 初期化 — Firestore / Storage / 匿名認証
// 静的サイト（GitHub Pages）から CDN の Firebase v10 モジュールを利用
// ・Firestore はオフライン永続化を有効化（複数タブ対応）
//   → 電波が切れても入出庫記録は端末に保持され、復帰時に自動送信される
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, increment, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

import firebaseConfig from '../firebase-config.js?v=21';

export const app = initializeApp(firebaseConfig);

// オフライン永続化（IndexedDB）。プライベートブラウズ等で失敗しても
// アプリ自体は動かしたいので、失敗時は通常キャッシュで初期化し直す。
let _db;
try {
  _db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  console.warn('オフライン永続化を有効にできませんでした（メモリキャッシュで継続）:', e);
  _db = initializeFirestore(app, {});
}
export const db = _db;

export const storage = getStorage(app);
export const auth = getAuth(app);

// 匿名サインイン。ready が解決したらデータ操作可能。
export const ready = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch((err) => {
    console.error('匿名サインインに失敗:', err);
    reject(err);
  });
});

// Firestore/Storage の関数を再エクスポート（他モジュールで使用）
export {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, writeBatch, increment, Timestamp,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
};
