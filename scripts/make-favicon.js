// One-off generator for public/favicon.ico — a 16x16 32bpp ICO with a
// checkmark on the site's accent green, matching the page's color scheme.
const fs = require('fs');
const path = require('path');

const SIZE = 16;
const BG = [0x2f, 0x4b, 0x3c]; // --accent forest green (R,G,B)
const FG = [0xf4, 0xef, 0xe6]; // --paper cream (R,G,B)

function drawLine(pixels, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;
  for (;;) {
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) {
      const px = x + ox, py = y + oy;
      if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) pixels[py][px] = true;
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

const pixels = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
drawLine(pixels, 3, 8, 6, 11);
drawLine(pixels, 6, 11, 12, 4);

// XOR color data: BMP rows are bottom-to-top, BGRA per pixel.
const rowBytes = SIZE * 4;
const xorData = Buffer.alloc(rowBytes * SIZE);
for (let row = 0; row < SIZE; row++) {
  const y = SIZE - 1 - row; // flip vertically for BMP storage order
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = pixels[y][x] ? FG : BG;
    const offset = row * rowBytes + x * 4;
    xorData[offset] = b;
    xorData[offset + 1] = g;
    xorData[offset + 2] = r;
    xorData[offset + 3] = 0xff;
  }
}

// AND mask: all opaque (0 = opaque in AND mask), padded to 4-byte row boundary.
const andRowBytes = Math.ceil(SIZE / 8 / 4) * 4;
const andData = Buffer.alloc(andRowBytes * SIZE, 0x00);

const bmpHeader = Buffer.alloc(40);
bmpHeader.writeUInt32LE(40, 0);        // biSize
bmpHeader.writeInt32LE(SIZE, 4);       // biWidth
bmpHeader.writeInt32LE(SIZE * 2, 8);   // biHeight (XOR + AND)
bmpHeader.writeUInt16LE(1, 12);        // biPlanes
bmpHeader.writeUInt16LE(32, 14);       // biBitCount
bmpHeader.writeUInt32LE(0, 16);        // biCompression (BI_RGB)
bmpHeader.writeUInt32LE(xorData.length + andData.length, 20); // biSizeImage
bmpHeader.writeInt32LE(0, 24);
bmpHeader.writeInt32LE(0, 28);
bmpHeader.writeUInt32LE(0, 32);
bmpHeader.writeUInt32LE(0, 36);

const imageData = Buffer.concat([bmpHeader, xorData, andData]);

const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0); // reserved
iconDir.writeUInt16LE(1, 2); // type: icon
iconDir.writeUInt16LE(1, 4); // count

const iconEntry = Buffer.alloc(16);
iconEntry.writeUInt8(SIZE, 0);   // width
iconEntry.writeUInt8(SIZE, 1);   // height
iconEntry.writeUInt8(0, 2);      // color count
iconEntry.writeUInt8(0, 3);      // reserved
iconEntry.writeUInt16LE(1, 4);   // planes
iconEntry.writeUInt16LE(32, 6);  // bit count
iconEntry.writeUInt32LE(imageData.length, 8); // bytes in resource
iconEntry.writeUInt32LE(22, 12); // offset (6 + 16)

const ico = Buffer.concat([iconDir, iconEntry, imageData]);
const outPath = path.join(__dirname, '..', 'public', 'favicon.ico');
fs.writeFileSync(outPath, ico);
console.log('wrote', outPath, ico.length, 'bytes');
