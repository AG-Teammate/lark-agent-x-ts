import QRCode from 'qrcode';

/**
 * Terminal QR code (equivalent to Python qrcode's print_ascii(invert=True)): two module rows are combined into one character,
 * inverted: light modules are drawn as solid blocks, suited to dark-background terminals; 1-module quiet zone.
 */
export function qrAscii(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const border = 1;
  const dark = (r: number, c: number) => {
    // With an odd number of rows, the padded final half-row is treated as dark (blank after inversion), matching the Python version
    if (Math.max(r, c) >= size + border) return true;
    return r >= 0 && c >= 0 && r < size && c < size && Boolean(qr.modules.get(r, c));
  };
  // Index = top dark + bottom dark × 2; after inversion, light is solid
  const codes = ['█', '▄', '▀', ' '];
  const lines: string[] = [];
  for (let r = -border; r < size + border; r += 2) {
    let line = '';
    for (let c = -border; c < size + border; c++) {
      line += codes[(dark(r, c) ? 1 : 0) + (dark(r + 1, c) ? 2 : 0)];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Save a PNG version of the QR code (for when the terminal QR code can't be scanned). */
export function saveQrPng(text: string, path: string): Promise<void> {
  return QRCode.toFile(path, text, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });
}
