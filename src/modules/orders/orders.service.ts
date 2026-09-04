import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  ManualOrderAcceptanceStateError,
  ManualOrderIngestionRepository,
  ManualOrderPayloadConflictError,
} from '../../infrastructure/database/repositories/manual-order-ingestion.repository';
import {
  GetOrdersQueryDto,
  OrderListItemDto,
  PaginatedResponse,
} from './dto/dashboard.dto';
import { decodeCursor, encodeCursor } from './services/pagination.helpers';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import { PhoneService } from '../../shared/services/phone.service';
import { InvalidPhoneNumberError } from '../../shared/errors/invalid-phone-number.error';
import {
  appendPaymentSignal,
  classifyCodStatus,
} from '../../shared/commerce/payment-signals';
import { BillingEntitlementService } from '../verification-core/billing-entitlement.service';
import { WebhookDispatchService } from '../webhook-queue/webhook-dispatch.service';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type {
  CreateManualOrderDto,
  CreateManualOrderResponseDto,
} from './dto/create-manual-order.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly ordersRepo: OrdersRepository,
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly verificationsRepo: VerificationsRepository,
    private readonly manualOrders: ManualOrderIngestionRepository,
    private readonly phoneService: PhoneService,
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly dispatcher: WebhookDispatchService,
  ) {}

  async createManualOrder(
    user: AuthenticatedUser,
    idempotencyHeader: string | undefined,
    payload: CreateManualOrderDto,
  ): Promise<CreateManualOrderResponseDto> {
    assertOrganizationWriteAllowed(user.role, {
      code: 'MANUAL_ORDER_ROLE_REQUIRED',
      message: 'Owner or admin role is required to create an order.',
    });
    const idempotencyKey = this.normalizeIdempotencyKey(idempotencyHeader);
    const customerPhone = this.normalizePhone(payload.customerPhone);
    const sources = await this.integrationsRepo.findActiveByOrg(user.orgId);
    if (sources.length !== 1 || sources[0].orgId !== user.orgId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Exactly one active commerce source is required.',
        code:
          sources.length > 1
            ? 'MANUAL_ORDER_SOURCE_AMBIGUOUS'
            : 'MANUAL_ORDER_SOURCE_UNAVAILABLE',
      });
    }
    const source = sources[0];
    if (source.platformType !== 'standalone') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Manual order creation is available only for Standalone.',
        code: 'MANUAL_ORDER_SOURCE_UNSUPPORTED',
      });
    }
    if (source.onboardingStatus !== 'completed') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Complete Standalone setup before creating an order.',
        code: 'MANUAL_ORDER_SETUP_INCOMPLETE',
      });
    }
    const entitlement = this.billingEntitlements.evaluateAccess(source, {
      id: source.id,
      orgId: user.orgId,
    });
    if (!entitlement.allowed) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'An active Standalone entitlement is required.',
        code: 'MANUAL_ORDER_ENTITLEMENT_REQUIRED',
        reason: entitlement.reason,
      });
    }

    const totalPrice = Number(payload.totalPrice).toFixed(2);
    const paymentSignals: string[] = [];
    appendPaymentSignal(paymentSignals, payload.paymentMethod);
    const canonicalOrder = {
      externalOrderId: this.manualExternalOrderId(idempotencyKey),
      orderNumber: payload.orderNumber ?? null,
      customerPhone,
      customerName: payload.customerName ?? null,
      totalPrice,
      currency: payload.currency,
      paymentMethod: payload.paymentMethod,
      paymentSignals,
      codStatus: classifyCodStatus(paymentSignals),
    } as const;
    const submissionFingerprint = createHash('sha256')
      .update(JSON.stringify(canonicalOrder))
      .digest('hex');
    const rawPayload = {
      ingestionType: 'manual',
      schemaVersion: 1,
      submissionFingerprint,
      order: canonicalOrder,
    };

    let acceptance: Awaited<
      ReturnType<ManualOrderIngestionRepository['accept']>
    >;
    try {
      acceptance = await this.manualOrders.accept({
        event: {
          idempotencyKey,
          storeDomain: source.platformStoreUrl,
          orgId: user.orgId,
          integrationId: source.id,
          rawPayload,
          submissionFingerprint,
        },
        order: {
          orgId: user.orgId,
          integrationId: source.id,
          externalOrderId: canonicalOrder.externalOrderId,
          orderNumber: payload.orderNumber,
          customerPhone,
          customerName: payload.customerName,
          totalPrice,
          currency: payload.currency,
          paymentMethod: payload.paymentMethod,
          rawPayload,
          isTest: false,
        },
      });
    } catch (error) {
      if (error instanceof ManualOrderPayloadConflictError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            'Idempotency-Key was already used with different order data.',
          code: 'MANUAL_ORDER_IDEMPOTENCY_CONFLICT',
        });
      }
      this.logger.error(
        buildBackendLog(OrdersService.name, {
          action: 'manual-order-accept',
          outcome: 'failure',
          orgId: user.orgId,
          integrationId: source.id,
          reason:
            error instanceof ManualOrderAcceptanceStateError
              ? 'acceptance_state_invalid'
              : 'database_failure',
          ...normalizeError(error),
        }),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The order could not be durably accepted. Retry safely.',
        code: 'MANUAL_ORDER_ACCEPTANCE_FAILED',
      });
    }

    try {
      await this.dispatcher.dispatchById(acceptance.eventId);
    } catch (error) {
      this.logger.error(
        buildBackendLog(OrdersService.name, {
          action: 'manual-order-dispatch',
          outcome: 'failure',
          orgId: user.orgId,
          integrationId: source.id,
          orderId: acceptance.order.id,
          webhookEventId: acceptance.eventId,
          ...normalizeError(error),
        }),
      );
    }

    let verificationId: string | undefined;
    try {
      verificationId = (
        await this.verificationsRepo.findByOrderId(acceptance.order.id)
      )?.id;
    } catch (error) {
      this.logger.warn(
        buildBackendLog(OrdersService.name, {
          action: 'manual-order-verification-read',
          outcome: 'failure',
          orgId: user.orgId,
          integrationId: source.id,
          orderId: acceptance.order.id,
          ...normalizeError(error),
        }),
      );
    }

    this.logger.log(
      buildBackendLog(OrdersService.name, {
        action: 'manual-order-accept',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: source.id,
        orderId: acceptance.order.id,
        webhookEventId: acceptance.eventId,
        duplicate: acceptance.duplicate,
      }),
    );
    return {
      orderId: acceptance.order.id,
      ...(verificationId ? { verificationId } : {}),
      status: 'accepted',
      duplicate: acceptance.duplicate,
    };
  }

  async listByOrg(
    orgId: string,
    query: GetOrdersQueryDto,
  ): Promise<PaginatedResponse<OrderListItemDto>> {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);

    const orders = await this.ordersRepo.findByOrg(orgId, {
      cursor,
      limit: limit + 1,
    });

    const hasMore = orders.length > limit;
    const items = hasMore ? orders.slice(0, limit) : orders;

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1])
        : null;

    return {
      data: items.map((order) => ({
        id: order.id,
        order_number: order.orderNumber ?? null,
        external_order_id: order.externalOrderId,
        customer_name: order.customerName ?? null,
        customer_phone: order.customerPhone,
        customer_email: order.customerEmail ?? null,
        total_price: order.totalPrice ? String(order.totalPrice) : null,
        currency: order.currency ?? null,
        created_at: order.createdAt ?? null,
        verification_status: order.verifications?.[0]?.status ?? null,
      })),
      next_cursor: nextCursor,
    };
  }

  private normalizeIdempotencyKey(value: string | undefined): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Idempotency-Key header is required.',
        code: 'MANUAL_ORDER_IDEMPOTENCY_KEY_REQUIRED',
        fieldErrors: { idempotencyKey: 'Idempotency-Key header is required.' },
      });
    }
    if (
      normalized.length < 8 ||
      normalized.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(normalized)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Idempotency-Key header is invalid.',
        code: 'MANUAL_ORDER_VALIDATION_FAILED',
        fieldErrors: {
          idempotencyKey:
            'Use 8-128 letters, numbers, dots, underscores, colons, or hyphens.',
        },
      });
    }
    return normalized;
  }

  private normalizePhone(value: string): string {
    try {
      return this.phoneService.standardize(value);
    } catch (error) {
      if (!(error instanceof InvalidPhoneNumberError)) throw error;
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Manual order validation failed.',
        code: 'MANUAL_ORDER_VALIDATION_FAILED',
        fieldErrors: { customerPhone: error.message },
      });
    }
  }

  private manualExternalOrderId(idempotencyKey: string): string {
    return `manual-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}`;
  }
}
