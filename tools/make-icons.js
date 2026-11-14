const sharp = require('sharp');
const fs = require('fs');
(async () => {
  const svg = fs.readFileSync(__dirname + '/icon.svg');
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) await sharp(svg, { density: 384 }).resize(s, s).png().toFile(`${__dirname}/tmp-${s}.png`);
  fs.copyFileSync(`${__dirname}/tmp-512.png`, 'src/assets/icon.png');
  fs.copyFileSync(`${__dirname}/tmp-512.png`, 'build/icon.png');
  fs.copyFileSync(`${__dirname}/tmp-32.png`, 'src/assets/tray.png');
  const badge = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#ff3b4f" stroke="#fff" stroke-width="1.5"/></svg>');
  await sharp(badge, { density: 300 }).resize(16, 16).png().toFile('src/assets/badge.png');
})();
