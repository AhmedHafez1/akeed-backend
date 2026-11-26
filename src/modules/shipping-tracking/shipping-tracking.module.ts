import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ShippingTrackingController } from './shipping-tracking.controller';
import { ShippingTrackingService } from './shipping-tracking.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ShippingTrackingController],
  providers: [ShippingTrackingService],
})
export class ShippingTrackingModule {}
