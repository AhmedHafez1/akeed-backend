import {
  applyDecorators,
  createParamDecorator,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  isBulkImportEnabledForOrg,
  readBulkImportConfig,
} from '../../../shared/config/bulk-import.config';
import {
  DualAuthGuard,
  type AuthenticatedUser,
  type RequestWithUser,
} from '../../auth/guards/dual-auth.guard';
import { StandaloneOrderIngestionService } from '../../order-ingestion/standalone-order-ingestion.service';
import {
  IMPORT_SOURCE_CODES,
  type StandaloneSource,
} from '../../order-ingestion/standalone-source-resolver';
import { orderImportError } from '../order-imports.errors';

const ORDER_IMPORT_ACCESS = 'orderImportAccess';
const ORDER_IMPORT_WHEN_DISABLED = 'orderImportWhenDisabled';

/**
 * `allow`: the route keeps working while `STANDALONE_BULK_IMPORT_ENABLED` is
 * off. Only stop uses it, so the kill switch can halt new work without
 * trapping a merchant's orders that are already releasing (AC5, US-04.6-09).
 * Role, source and organization checks still apply.
 */
export interface OrderImportAccessOptions {
  whenDisabled: 'refuse' | 'allow';
}

/**
 * `write`: the flag is on for the caller's organization and the caller is an owner or admin of an org whose
 * single active source is a Standalone store with completed onboarding.
 * `read`: the flag is on for the caller's organization and the caller belongs to an organization.
 */
export type OrderImportAccessMode = 'read' | 'write';

interface OrderImportRequest extends RequestWithUser {
  orderImportSource?: StandaloneSource;
}

/**
 * The one gate for every order-import route, reused by later stories.
 *
 * It runs as a guard, before interceptors, so a denied upload is refused
 * before multer reads the multipart body. The source it resolves comes from
 * the session's organization and is handed to the handler; no route derives
 * it again.
 */
@Injectable()
export class OrderImportAccessGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly ingestion: StandaloneOrderIngestionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const whenDisabled = this.reflector.getAllAndOverride<
      OrderImportAccessOptions['whenDisabled'] | undefined
    >(ORDER_IMPORT_WHEN_DISABLED, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<OrderImportRequest>();
    // The switch and the pilot allow-list (US-04.6-10) are one decision: an
    // organization outside the pilot is refused exactly as if it were off.
    if (
      whenDisabled !== 'allow' &&
      !isBulkImportEnabledForOrg(
        readBulkImportConfig(this.config),
        request.user?.orgId,
      )
    )
      throw orderImportError('IMPORT_DISABLED');
    const mode =
      this.reflector.getAllAndOverride<OrderImportAccessMode | undefined>(
        ORDER_IMPORT_ACCESS,
        [context.getHandler(), context.getClass()],
      ) ?? 'write';
    if (mode === 'read') return true;
    request.orderImportSource = await this.ingestion.resolveWritableSource(
      request.user as AuthenticatedUser,
      IMPORT_SOURCE_CODES,
    );
    return true;
  }
}

/**
 * Authenticates and applies the order-import gate. Extra guards (the upload
 * throttle) run between authentication and the gate.
 */
export function OrderImportAccess(
  mode: OrderImportAccessMode,
  ...extras: (
    | (new (...args: never[]) => CanActivate)
    | OrderImportAccessOptions
  )[]
) {
  const extraGuards = extras.filter(
    (extra): extra is new (...args: never[]) => CanActivate =>
      typeof extra === 'function',
  );
  const options = extras.find(
    (extra): extra is OrderImportAccessOptions => typeof extra !== 'function',
  );
  return applyDecorators(
    SetMetadata(ORDER_IMPORT_ACCESS, mode),
    SetMetadata(ORDER_IMPORT_WHEN_DISABLED, options?.whenDisabled ?? 'refuse'),
    UseGuards(DualAuthGuard, ...extraGuards, OrderImportAccessGuard),
  );
}

/** The writable Standalone source resolved by `OrderImportAccess('write')`. */
export const ImportSource = createParamDecorator(
  (_data: unknown, context: ExecutionContext): StandaloneSource => {
    const source = context
      .switchToHttp()
      .getRequest<OrderImportRequest>().orderImportSource;
    if (!source)
      throw new Error('ImportSource used on a route without write access');
    return source;
  },
);
