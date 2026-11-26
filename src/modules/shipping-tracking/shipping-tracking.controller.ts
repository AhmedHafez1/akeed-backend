import { Controller, Get, Header, Param } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ShippingTrackingService } from './shipping-tracking.service';
import type { ShippingTrackingView } from './shipping-tracking.types';

/**
 * Unauthenticated on purpose: customers open it from the Shipped message.
 * Every request arrives through the website's server, so a per-address limit
 * would throttle all customers together; the lookup is kept cheap instead (a
 * shape check, then one unique-index probe).
 */
@Controller('api/public/shipping-tracking')
@SkipThrottle()
export class ShippingTrackingController {
  constructor(private readonly shippingTracking: ShippingTrackingService) {}

  @Get(':code')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  open(@Param('code') code: string): Promise<ShippingTrackingView> {
    return this.shippingTracking.open(code);
  }
}
