import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import {
  CreateIntegrationApiKeyDto,
  type CreatedIntegrationApiKeyDto,
  type IntegrationApiKeyDto,
  type IntegrationApiKeyListDto,
} from './dto/integration-api-key.dto';
import { integrationKeyError } from './integration-keys.errors';
import { IntegrationKeysService } from './integration-keys.service';

/** An unknown or malformed id reads as not found, never as a 400 that leaks shape. */
export const integrationKeyIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => integrationKeyError('API_KEY_NOT_FOUND'),
});

/** A route pipe answering API_KEY_VALIDATION_FAILED with per-field errors. */
export const createIntegrationKeyPipe = new ValidationPipe({
  expectedType: CreateIntegrationApiKeyDto,
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors: ValidationError[]) =>
    integrationKeyError('API_KEY_VALIDATION_FAILED', {
      fieldErrors: Object.fromEntries(
        errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ??
            `${error.property} is invalid.`,
        ]),
      ),
    }),
});

/**
 * Key management for signed-in members (session auth). The keys themselves
 * authenticate only through `IntegrationApiKeyGuard`, on the order API.
 */
@Controller('api/integration-keys')
@UseGuards(DualAuthGuard)
export class IntegrationKeysController {
  constructor(private readonly integrationKeys: IntegrationKeysService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<IntegrationApiKeyListDto> {
    return this.integrationKeys.list(user);
  }

  /** 201 with the full key: the only response that ever contains it. */
  @Post()
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with API_KEY_VALIDATION_FAILED.
    @Body(createIntegrationKeyPipe) body: object,
  ): Promise<CreatedIntegrationApiKeyDto> {
    return this.integrationKeys.create(
      user,
      body as CreateIntegrationApiKeyDto,
    );
  }

  /** Immediate and idempotent; answers the key's metadata. */
  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', integrationKeyIdPipe) keyId: string,
  ): Promise<IntegrationApiKeyDto> {
    return this.integrationKeys.revoke(user, keyId);
  }
}
