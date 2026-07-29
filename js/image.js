// ============================================================
// 画像リサイズ — アップロード前にブラウザ側で縮小
// 長辺 1600px・約300KB を目標に JPEG 化（消防車アプリと同方式）
// ============================================================

const MAX_EDGE = 1600;
const TARGET_BYTES = 300 * 1024; // 約300KB
const MIN_QUALITY = 0.4;

// File/Blob → リサイズ済み JPEG Blob を返す
export async function resizeImage(file, {
  maxEdge = MAX_EDGE, targetBytes = TARGET_BYTES,
} = {}) {
  const bitmap = await loadBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();

  // 品質を段階的に下げて 目標バイト数以下を狙う
  let quality = 0.85;
  let blob = await toBlob(canvas, quality);
  while (blob.size > targetBytes && quality > MIN_QUALITY) {
    quality = Math.max(MIN_QUALITY, quality - 0.12);
    blob = await toBlob(canvas, quality);
  }
  return blob;
}

function fitWithin(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / long;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      // EXIF回転を尊重
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* フォールバックへ */ }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}
