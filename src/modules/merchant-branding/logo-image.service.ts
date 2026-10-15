import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import {
  BANNER_HEIGHT,
  BANNER_WIDTH,
  LOGO_MAX_BYTES,
  LOGO_MIN_SHORT_SIDE,
  LOGO_STORED_MAX_SIDE,
  isAcceptedLogoFormat,
  placeLogoOnBanner,
} from './logo-banner.policy';

/** Why an uploaded file cannot be a logo. */
export type LogoImageRejection =
  | 'too_large'
  | 'unsupported_type'
  | 'unreadable'
  | 'too_small';

export class LogoImageError extends Error {
  constructor(readonly reason: LogoImageRejection) {
    super(`Logo image rejected: ${reason}.`);
  }
}

export interface RenderedLogo {
  /** The logo as stored: PNG, at most `LOGO_STORED_MAX_SIDE` on a side. */
  logo: Buffer;
  /** The 1200x628 banner: the logo centred on white, as JPEG. */
  banner: Buffer;
}

/** Decoding stops past this many pixels, so a crafted file cannot exhaust memory. */
const MAX_INPUT_PIXELS = 50_000_000;

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/**
 * Turns an uploaded logo into the stored logo and the banner. The format is
 * read from the decoded file, never from its name or declared type.
 */
@Injectable()
export class LogoImageService {
  async render(input: Buffer): Promise<RenderedLogo> {
    if (input.byteLength > LOGO_MAX_BYTES)
      throw new LogoImageError('too_large');

    let metadata: sharp.Metadata;
    try {
      metadata = await this.open(input).metadata();
    } catch {
      throw new LogoImageError('unsupported_type');
    }
    if (!isAcceptedLogoFormat(metadata.format)) {
      throw new LogoImageError('unsupported_type');
    }

    try {
      // Apply the EXIF orientation first, so width and height are as shown.
      const upright = await this.open(input)
        .rotate()
        .png()
        .toBuffer({ resolveWithObject: true });
      const { width, height } = upright.info;
      if (Math.min(width, height) < LOGO_MIN_SHORT_SIDE) {
        throw new LogoImageError('too_small');
      }

      const logo = await sharp(upright.data)
        .resize(LOGO_STORED_MAX_SIDE, LOGO_STORED_MAX_SIDE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9 })
        .toBuffer();

      const placement = placeLogoOnBanner(width, height);
      const placed = await sharp(upright.data)
        .resize(placement.width, placement.height, { fit: 'fill' })
        // A transparent logo sits on the white banner, not on black.
        .flatten({ background: WHITE })
        .png()
        .toBuffer();
      const banner = await sharp({
        create: {
          width: BANNER_WIDTH,
          height: BANNER_HEIGHT,
          channels: 3,
          background: WHITE,
        },
      })
        .composite([
          { input: placed, left: placement.left, top: placement.top },
        ])
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();

      return { logo, banner };
    } catch (error) {
      if (error instanceof LogoImageError) throw error;
      throw new LogoImageError('unreadable');
    }
  }

  private open(input: Buffer): sharp.Sharp {
    return sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
      animated: false,
    });
  }
}
