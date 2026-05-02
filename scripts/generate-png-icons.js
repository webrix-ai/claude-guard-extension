const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 48, 128];

const THEMES = {
  inactive: { bg: { r: 15, g: 15, b: 17 }, fg: { r: 167, g: 139, b: 250 } },
  active:   { bg: { r: 220, g: 38, b: 38 }, fg: { r: 255, g: 255, b: 255 } },
};

function rasterizeMark(size, bgColor, fgColor) {
  const svgViewBox = { x: -2, y: 12, w: 160, h: 116 };
  const padding = Math.max(1, Math.floor(size * 0.06));
  const drawSize = size - padding * 2;

  const scaleX = drawSize / svgViewBox.w;
  const scaleY = drawSize / svgViewBox.h;
  const scale = Math.min(scaleX, scaleY);

  const offsetX = padding + (drawSize - svgViewBox.w * scale) / 2;
  const offsetY = padding + (drawSize - svgViewBox.h * scale) / 2;

  function tx(x) { return (x - svgViewBox.x) * scale + offsetX; }
  function ty(y) { return (y - svgViewBox.y) * scale + offsetY; }

  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      pixels[idx] = bgColor.r;
      pixels[idx + 1] = bgColor.g;
      pixels[idx + 2] = bgColor.b;
      pixels[idx + 3] = 255;
    }
  }

  const fillPolygons = [
    [[74.3724,15.9216],[86.6466,36.8327],[42.9504,112.492],[67.8571,112.492],[111.405,37.428],[99.1313,15.9216]],
    [[117.908,15.9216],[130.237,36.8327],[86.3459,112.492],[111.731,112.492],[155.107,37.428],[142.778,15.9216]],
  ];

  for (const poly of fillPolygons) {
    fillPolygon(pixels, size, poly.map(([px,py])=>[tx(px),ty(py)]), fgColor.r, fgColor.g, fgColor.b);
  }

  const hexagon = [
    [14.8309,15.616],[38.9447,15.616],[51.6714,36.8865],[51.6714,37.6612],
    [39.6152,58.5443],[38.9447,58.9317],[14.8309,58.9317],[14.1603,58.5443],
    [2.10412,37.6612],[2.10412,36.8865],[14.1603,16.0033],[14.8309,15.616],
  ];
  drawPolyline(pixels, size, hexagon.map(([px,py])=>[tx(px),ty(py)]), fgColor.r, fgColor.g, fgColor.b, Math.max(1, Math.round(scale*2.5)));

  const hexLines = [
    [[26.9579,37.2044],[14.3936,15.7548]],
    [[27.0269,37.2042],[51.739,37.2042]],
    [[14.4629,58.8621],[26.9578,37.2042]],
  ];
  for (const [p1,p2] of hexLines) {
    drawLine(pixels, size, tx(p1[0]),ty(p1[1]),tx(p2[0]),ty(p2[1]), fgColor.r, fgColor.g, fgColor.b, Math.max(1, Math.round(scale*2.5)));
  }

  const outlines = [
    [[74.5296,15.6163],[98.642,15.6163],[111.37,36.8868],[111.37,37.6615],[68.2155,112.412],[67.5436,112.799],[43.4312,112.799],[42.7592,112.412],[30.703,91.5285],[30.703,90.7538],[73.8577,16.0037]],
    [[118.123,15.6161],[142.236,15.6161],[154.964,36.8866],[154.964,37.6613],[111.809,112.411],[111.137,112.799],[87.0247,112.799],[86.3527,112.411],[74.2965,91.5282],[74.2965,90.7536],[117.451,16.0034]],
  ];
  for (const poly of outlines) {
    const t = poly.map(([px,py])=>[tx(px),ty(py)]);
    t.push(t[0]);
    drawPolyline(pixels, size, t, fgColor.r, fgColor.g, fgColor.b, Math.max(1, Math.round(scale*2.5)));
  }

  return pixels;
}

function fillPolygon(pixels, size, points, r, g, b) {
  let minY = Infinity, maxY = -Infinity;
  for (const [,py] of points) { if (py<minY) minY=py; if (py>maxY) maxY=py; }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(size-1, Math.ceil(maxY));
  for (let y=minY; y<=maxY; y++) {
    const ints = [];
    for (let i=0; i<points.length; i++) {
      const [x1,y1]=points[i], [x2,y2]=points[(i+1)%points.length];
      if ((y1<=y&&y2>y)||(y2<=y&&y1>y)) ints.push(x1+(y-y1)/(y2-y1)*(x2-x1));
    }
    ints.sort((a,b)=>a-b);
    for (let i=0; i<ints.length-1; i+=2) {
      for (let x=Math.max(0,Math.ceil(ints[i])); x<=Math.min(size-1,Math.floor(ints[i+1])); x++) {
        const idx=(y*size+x)*4; pixels[idx]=r; pixels[idx+1]=g; pixels[idx+2]=b; pixels[idx+3]=255;
      }
    }
  }
}

function drawLine(pixels, size, x1, y1, x2, y2, r, g, b, thickness) {
  const dx=x2-x1, dy=y2-y1, len=Math.sqrt(dx*dx+dy*dy);
  if (!len) return;
  const steps=Math.ceil(len*2), half=thickness/2;
  for (let i=0; i<=steps; i++) {
    const t=i/steps, cx=x1+dx*t, cy=y1+dy*t;
    for (let py=Math.floor(cy-half); py<=Math.ceil(cy+half); py++) {
      for (let px=Math.floor(cx-half); px<=Math.ceil(cx+half); px++) {
        if (px<0||px>=size||py<0||py>=size) continue;
        if (Math.sqrt((px-cx)**2+(py-cy)**2)<=half) {
          const idx=(py*size+px)*4; pixels[idx]=r; pixels[idx+1]=g; pixels[idx+2]=b; pixels[idx+3]=255;
        }
      }
    }
  }
}

function drawPolyline(pixels, size, points, r, g, b, thickness) {
  for (let i=0; i<points.length-1; i++) drawLine(pixels,size,points[i][0],points[i][1],points[i+1][0],points[i+1][1],r,g,b,thickness);
}

function encodePng(pixels, width, height) {
  const rawData = Buffer.alloc(height*(1+width*4));
  for (let y=0; y<height; y++) {
    const ro=y*(1+width*4); rawData[ro]=0;
    for (let x=0; x<width; x++) {
      const si=(y*width+x)*4, di=ro+1+x*4;
      rawData[di]=pixels[si]; rawData[di+1]=pixels[si+1]; rawData[di+2]=pixels[si+2]; rawData[di+3]=pixels[si+3];
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13,0); ihdr.write("IHDR",4);
  ihdr.writeUInt32BE(width,8); ihdr.writeUInt32BE(height,12);
  ihdr[16]=8; ihdr[17]=6;
  ihdr.writeUInt32BE(crc32(ihdr.subarray(4,21)),21);
  const idp = Buffer.concat([Buffer.from("IDAT"),compressed]);
  const idat = Buffer.alloc(8+idp.length);
  idat.writeUInt32BE(compressed.length,0); idp.copy(idat,4);
  idat.writeUInt32BE(crc32(idp),4+idp.length);
  const iend = Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
  return Buffer.concat([sig,ihdr,idat,iend]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;CRC_TABLE[n]=c;}
function crc32(buf){let c=0xffffffff;for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;}

const iconsDir = path.join(__dirname, "..", "icons");
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const [name, theme] of Object.entries(THEMES)) {
  for (const size of SIZES) {
    const pixels = rasterizeMark(size, theme.bg, theme.fg);
    const png = encodePng(pixels, size, size);
    const suffix = name === "inactive" ? "" : `-${name}`;
    const outPath = path.join(iconsDir, `icon${size}${suffix}.png`);
    fs.writeFileSync(outPath, png);
    console.log(`Generated ${outPath} (${png.length} bytes)`);
  }
}
