import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { from, map, Observable } from 'rxjs';
import { readMetaWebhookConfig } from '../../../shared/config/meta-webhook.config';
import type { RequestWithRawBody } from '../../../shared/models/request-with-raw-body.interface';
import { MetaWebhookEventsService } from './meta-webhook-events.service';

/**
 * Durable intake for `POST /webhooks/whatsapp`.
 *
 * It sits here because interceptors run after the signature guard and before
 * pipes: a signed POST that fails DTO validation would otherwise get a 400
 * before anything could store it. It answers without reaching the route
 * handler. With the switch off, the existing route runs as it always did.
 */
@Injectable()
export class MetaWebhookIntakeInterceptor implements NestInterceptor {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly events?: MetaWebhookEventsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.events || !readMetaWebhookConfig(this.config).durableEnabled) {
      return next.handle();
    }
    const { rawBody } = context.switchToHttp().getRequest<RequestWithRawBody>();
    return from(this.events.accept(rawBody)).pipe(
      map(() => ({ status: 'success' })),
    );
  }
}
