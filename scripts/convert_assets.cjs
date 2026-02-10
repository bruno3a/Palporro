const path = require('path');
const fs = require('fs');

(async function convert(){
  const sharp = require('sharp');
  const ffmpegPath = require('ffmpeg-static');
  const ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);

  const publicDir = path.join(__dirname, '..', 'public');
  const webpPath = path.join(publicDir, 'GTR34.webp');
  const pngPath = path.join(publicDir, 'GTR34.png');
  const promoPath = path.join(publicDir, 'Promo_Palporro_V2.wav');
  const promoOut = path.join(publicDir, 'Promo_Palporro_V2_fixed.wav');

  try {
    if (fs.existsSync(webpPath)) {
      console.log('Converting GTR34.webp -> GTR34.png');
      await sharp(webpPath).png().toFile(pngPath);
      console.log('PNG created:', pngPath);
    } else {
      console.warn('GTR34.webp not found, skipping PNG conversion');
    }

    if (fs.existsSync(promoPath)) {
      console.log('Re-encoding Promo_Palporro_V2.wav -> Promo_Palporro_V2_fixed.wav');
      await new Promise((resolve, reject) => {
        ffmpeg(promoPath)
          .audioBitrate('128k')
          .toFormat('wav')
          .on('end', resolve)
          .on('error', reject)
          .save(promoOut);
      });
      // Replace original with fixed file
      fs.renameSync(promoOut, promoPath);
      console.log('Re-encoding finished and replaced original');
    } else {
      console.warn('Promo_Palporro_V2.wav not found, skipping audio recode');
    }
  } catch (err) {
    console.error('Conversion error:', err);
    process.exit(1);
  }
})();
