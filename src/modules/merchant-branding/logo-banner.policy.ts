/** The banner the provider shows as the image header: 1.91:1. */
export const BANNER_WIDTH = 1200;
export const BANNER_HEIGHT = 628;

/** The logo fills at most this share of each side, leaving even padding. */
export const BANNER_LOGO_SHARE = 0.7;

/** The largest file a merchant may upload, as WhatsApp allows for images. */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/** A logo smaller than this on its short side would print blurred. */
export const LOGO_MIN_SHORT_SIDE = 64;

/** The stored copy of the logo is scaled down to fit this square. */
export const LOGO_STORED_MAX_SIDE = 1024;

export const ACCEPTED_LOGO_FORMATS = ['png', 'jpeg'] as const;
export type AcceptedLogoFormat = (typeof ACCEPTED_LOGO_FORMATS)[number];

export function isAcceptedLogoFormat(
  format: string | undefined,
): format is AcceptedLogoFormat {
  return (ACCEPTED_LOGO_FORMATS as readonly string[]).includes(format ?? '');
}

export interface BannerPlacement {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Where a logo of the given size sits on the banner: scaled, up or down, to
 * fit the box `BANNER_LOGO_SHARE` of the banner wide and high without
 * changing its proportions, and centred.
 */
export function placeLogoOnBanner(
  logoWidth: number,
  logoHeight: number,
): BannerPlacement {
  const boxWidth = Math.round(BANNER_WIDTH * BANNER_LOGO_SHARE);
  const boxHeight = Math.round(BANNER_HEIGHT * BANNER_LOGO_SHARE);
  const scale = Math.min(boxWidth / logoWidth, boxHeight / logoHeight);
  const width = Math.max(1, Math.round(logoWidth * scale));
  const height = Math.max(1, Math.round(logoHeight * scale));
  return {
    width,
    height,
    left: Math.floor((BANNER_WIDTH - width) / 2),
    top: Math.floor((BANNER_HEIGHT - height) / 2),
  };
}
