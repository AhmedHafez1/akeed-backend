import sharp from 'sharp';
import {
  BANNER_HEIGHT,
  BANNER_LOGO_SHARE,
  BANNER_WIDTH,
  LOGO_MAX_BYTES,
  placeLogoOnBanner,
} from './logo-banner.policy';
import { LogoImageError, LogoImageService } from './logo-image.service';

const RED = { r: 220, g: 20, b: 20 };

function solid(
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp',
  alpha = 1,
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 4, background: { ...RED, alpha } },
  });
  return (
    format === 'png'
      ? image.png()
      : format === 'jpeg'
        ? image.jpeg()
        : image.webp()
  ).toBuffer();
}

async function pixel(image: Buffer, x: number, y: number) {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof LogoImageError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('placeLogoOnBanner', () => {
  it.each([
    ['wide', 1000, 100],
    ['tall', 100, 1000],
    ['square', 500, 500],
    ['tiny', 64, 64],
  ])('fits a %s logo in the box and centres it', (_label, width, height) => {
    const placement = placeLogoOnBanner(width, height);
    expect(placement.width).toBeLessThanOrEqual(
      Math.round(BANNER_WIDTH * BANNER_LOGO_SHARE),
    );
    expect(placement.height).toBeLessThanOrEqual(
      Math.round(BANNER_HEIGHT * BANNER_LOGO_SHARE),
    );
    // One side fills the box: the logo is as large as the padding allows.
    expect(
      placement.width === Math.round(BANNER_WIDTH * BANNER_LOGO_SHARE) ||
        placement.height === Math.round(BANNER_HEIGHT * BANNER_LOGO_SHARE),
    ).toBe(true);
    expect(
      Math.abs(placement.width / placement.height - width / height),
    ).toBeLessThan(0.05);
    expect(
      Math.abs(2 * placement.left + placement.width - BANNER_WIDTH),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(2 * placement.top + placement.height - BANNER_HEIGHT),
    ).toBeLessThanOrEqual(1);
  });
});

describe('LogoImageService', () => {
  const service = new LogoImageService();

  it('renders a 1200x628 JPEG banner with the logo centred on white', async () => {
    const { banner, logo } = await service.render(await solid(400, 200, 'png'));

    const meta = await sharp(banner).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual([
      'jpeg',
      BANNER_WIDTH,
      BANNER_HEIGHT,
    ]);
    const corner = await pixel(banner, 5, 5);
    expect(Math.min(corner.r, corner.g, corner.b)).toBeGreaterThan(245);
    const centre = await pixel(banner, BANNER_WIDTH / 2, BANNER_HEIGHT / 2);
    expect(centre.r).toBeGreaterThan(180);
    expect(centre.g).toBeLessThan(80);
    expect((await sharp(logo).metadata()).format).toBe('png');
  });

  it('puts a transparent logo on white, not black', async () => {
    const { banner } = await service.render(await solid(300, 300, 'png', 0));
    const centre = await pixel(banner, BANNER_WIDTH / 2, BANNER_HEIGHT / 2);
    expect(Math.min(centre.r, centre.g, centre.b)).toBeGreaterThan(245);
  });

  it('accepts a JPEG logo and keeps a stored copy within 1024 px', async () => {
    const { logo } = await service.render(await solid(2000, 1000, 'jpeg'));
    const meta = await sharp(logo).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1024);
  });

  it('refuses a format other than PNG or JPEG, whatever its name', async () => {
    expect(await rejection(service.render(await solid(200, 200, 'webp')))).toBe(
      'unsupported_type',
    );
    expect(
      await rejection(service.render(Buffer.from('<svg></svg> not an image'))),
    ).toBe('unsupported_type');
  });

  it('refuses a logo too small to print', async () => {
    expect(await rejection(service.render(await solid(300, 40, 'png')))).toBe(
      'too_small',
    );
  });

  it('refuses a file over 5 MB before decoding it', async () => {
    expect(
      await rejection(service.render(Buffer.alloc(LOGO_MAX_BYTES + 1))),
    ).toBe('too_large');
  });

  it('refuses a truncated image', async () => {
    const png = await solid(400, 400, 'png');
    expect(
      await rejection(service.render(png.subarray(0, png.length / 2))),
    ).not.toBe('accepted');
  });
});
