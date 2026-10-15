import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { SupabasePublicAssetStorage } from '../../infrastructure/storage/supabase-public-asset.storage';
import { PUBLIC_ASSET_STORAGE_PORT } from '../../shared/ports/public-asset-storage.port';
import { AuthModule } from '../auth/auth.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { LogoImageService } from './logo-image.service';
import {
  LogoUploadInterceptor,
  LogoUploadThrottleGuard,
} from './logo-upload.interceptor';
import { MerchantBrandingController } from './merchant-branding.controller';
import { MerchantBrandingService } from './merchant-branding.service';

/** The store's logo and the banner sent as the message image header. */
@Module({
  imports: [DatabaseModule, AuthModule, OnboardingModule],
  controllers: [MerchantBrandingController],
  providers: [
    MerchantBrandingService,
    LogoImageService,
    LogoUploadInterceptor,
    LogoUploadThrottleGuard,
    SupabasePublicAssetStorage,
    {
      provide: PUBLIC_ASSET_STORAGE_PORT,
      useExisting: SupabasePublicAssetStorage,
    },
  ],
})
export class MerchantBrandingModule {}
