#!/usr/bin/env node
/*
 * The launcher icons, drawn: a white speech bubble with a blue dot on the
 * brand's field (#1f215d — the same field the app's isolated mark sits on).
 * Written as PNG by hand so the repository needs no image library; `yarn
 * icons` regenerates them.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
const FIELD = [0x1f, 0x21, 0x5d];
const BUBBLE = [0xff, 0xff, 0xff];
const DOT = [0x60, 0xa5, 0xfa];

const crcTable = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc32 = (buf) => {
	let c = -1;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
	const raw = Buffer.alloc((size * 3 + 1) * size);
	for (let y = 0; y < size; y++) {
		raw[y * (size * 3 + 1)] = 0;
		for (let x = 0; x < size; x++) {
			const [r, g, b] = pixel(x, y);
			const i = y * (size * 3 + 1) + 1 + x * 3;
			raw[i] = r;
			raw[i + 1] = g;
			raw[i + 2] = b;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** Anti-aliased coverage of a point by a circle, sampled 4x4. */
const inside = (x, y, cx, cy, r) => {
	let hits = 0;
	for (let sy = 0; sy < 4; sy++)
		for (let sx = 0; sx < 4; sx++) {
			const dx = x + (sx + 0.5) / 4 - cx;
			const dy = y + (sy + 0.5) / 4 - cy;
			if (dx * dx + dy * dy <= r * r) hits++;
		}
	return hits / 16;
};
const inTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
	let hits = 0;
	for (let sy = 0; sy < 4; sy++)
		for (let sx = 0; sx < 4; sx++) {
			const px = x + (sx + 0.5) / 4;
			const py = y + (sy + 0.5) / 4;
			const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
			const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
			const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
			const neg = d1 < 0 || d2 < 0 || d3 < 0;
			const pos = d1 > 0 || d2 > 0 || d3 > 0;
			if (!(neg && pos)) hits++;
		}
	return hits / 16;
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** The drawing, in a unit square: a bubble centred a touch high, its tail at the lower left, a dot in it. */
function draw(size, inset) {
	const s = size;
	const cx = s * 0.5;
	const cy = s * 0.47;
	const r = s * (0.5 - inset) * 0.72;
	const tail = [
		[cx - r * 0.55, cy + r * 0.75],
		[cx - r * 0.95, cy + r * 1.35],
		[cx - r * 0.1, cy + r * 0.95]
	];
	return (x, y) => {
		let c = FIELD;
		const bubble = Math.max(inside(x, y, cx, cy, r), inTriangle(x, y, ...tail));
		c = mix(c, BUBBLE, bubble);
		const dot = inside(x, y, cx, cy, r * 0.3);
		return mix(c, DOT, dot);
	};
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon-192.png'), png(192, draw(192, 0.08)));
writeFileSync(join(OUT, 'icon-512.png'), png(512, draw(512, 0.08)));
// Maskable: the safe zone is the inner 80%, so the drawing keeps well inside it.
writeFileSync(join(OUT, 'icon-maskable-512.png'), png(512, draw(512, 0.2)));
console.log(`wrote 3 icons to ${OUT}`);
