import QRCode from "qrcode";

/** QR modules as a square grid. Rendered as vector shapes, so it stays sharp on paper and screen. */
export function qrMatrix(text: string): { size: number; dark: (x: number, y: number) => boolean } {
  const q = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = q.modules.size;
  const data = q.modules.data;
  return { size, dark: (x, y) => Boolean(data[y * size + x]) };
}

/** Horizontal runs of dark modules: fewer shapes than one square per module. */
export function qrRuns(text: string) {
  const { size, dark } = qrMatrix(text);
  const runs: { x: number; y: number; w: number }[] = [];
  for (let y = 0; y < size; y++) {
    let start = -1;
    for (let x = 0; x <= size; x++) {
      const on = x < size && dark(x, y);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        runs.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  }
  return { size, runs };
}

export function qrPath(text: string) {
  const { size, runs } = qrRuns(text);
  return { size, d: runs.map((r) => `M${r.x} ${r.y}h${r.w}v1h-${r.w}z`).join("") };
}
