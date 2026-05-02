const fs = require("fs");
const path = require("path");

function generateSvgIcon(size) {
  const padding = Math.round(size * 0.12);
  const shieldSize = size - padding * 2;
  const cx = size / 2;
  const cy = size / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#7c3aed"/>
      <stop offset="100%" style="stop-color:#4f46e5"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="url(#bg)"/>
  <g transform="translate(${cx}, ${cy + padding * 0.3}) scale(${shieldSize / 28})">
    <path d="M0 -12 L-10 -7 L-10 1 C-10 7 -4 11 0 13 C4 11 10 7 10 1 L10 -7 Z"
          fill="none" stroke="white" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M-3 0 L-1 3 L4 -3" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, "..", "icons");

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

for (const size of sizes) {
  const svg = generateSvgIcon(size);
  const svgPath = path.join(iconsDir, `icon${size}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`Generated ${svgPath}`);
}

console.log("\nSVG icons generated. Convert to PNG for Chrome extension:");
console.log("You can use any SVG-to-PNG tool, or load unpacked with SVGs for development.");
console.log("For production, install 'sharp' and convert: sharp(svg).resize(size).png().toFile(...)");
