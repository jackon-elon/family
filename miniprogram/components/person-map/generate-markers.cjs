const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 64;
const table = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const tag = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, payload])));
  return Buffer.concat([size, tag, payload, crc]);
}

function marker(fill, filename) {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4);
    for (let x = 0; x < SIZE; x++) {
      const distance = Math.hypot(x - 32, y - 32);
      const offset = 1 + x * 4;
      let color = [0, 0, 0, 0];
      if (distance <= 29) color = [255, 255, 255, 255];
      if (distance <= 24) color = [...fill, 255];
      if (distance <= 8) color = [255, 255, 255, 255];
      for (let c = 0; c < 4; c++) row[offset + c] = color[c];
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(path.join(__dirname, filename), png);
}

marker([34, 122, 85], 'marker.png');
marker([215, 123, 64], 'marker-selected.png');
