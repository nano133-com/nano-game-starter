// Draws a QR code on a canvas, in the browser (no outside service sees the payment request).

import qrcode from "qrcode-generator";

export function qrCanvas(text: string, size = 232): HTMLCanvasElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const scale = Math.max(2, Math.floor((size * (window.devicePixelRatio || 1)) / (n + quiet * 2)));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = (n + quiet * 2) * scale;
  canvas.className = "qr";
  canvas.setAttribute("role", "img");
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111318";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  return canvas;
}
