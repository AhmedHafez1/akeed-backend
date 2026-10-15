import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import {
  LogoUploadInterceptor,
  LogoUploadThrottleGuard,
} from './logo-upload.interceptor';
import { MerchantBrandingService } from './merchant-branding.service';
import type { MerchantBrandingDto } from './merchant-branding.types';

@Controller('api/settings/logo')
@UseGuards(DualAuthGuard)
export class MerchantBrandingController {
  constructor(private readonly branding: MerchantBrandingService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  @UseGuards(LogoUploadThrottleGuard)
  @UseInterceptors(LogoUploadInterceptor)
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ): Promise<MerchantBrandingDto> {
    return this.branding.uploadLogo(user, file);
  }

  @Delete()
  remove(@CurrentUser() user: AuthenticatedUser): Promise<MerchantBrandingDto> {
    return this.branding.removeLogo(user);
  }
}
