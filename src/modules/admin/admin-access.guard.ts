import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { TokenValidatorService } from '../auth/services/token-validator.service';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { RequestWithAdmin } from './admin.types';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  private readonly logger = new Logger(AdminAccessGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tokenValidator: TokenValidatorService,
    private readonly audit: AdminAccessAuditRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.isFeatureEnabled()) {
      throw new NotFoundException();
    }

    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const token = this.extractToken(request.headers.authorization);
    const requestId = this.getRequestId(request);
    const action = `${request.method} ${request.path}`;

    if (!token) {
      await this.safeAudit({ action, outcome: 'denied', requestId });
      throw new UnauthorizedException('Missing authorization token');
    }

    try {
      const admin = await this.tokenValidator.validateAdminToken(token);
      request.admin = admin;
      await this.safeAudit({
        userId: admin.userId,
        action,
        outcome: 'allowed',
        requestId,
      });
      return true;
    } catch (error) {
      await this.safeAudit({ action, outcome: 'denied', requestId });
      this.logger.warn(
        buildBackendLog(AdminAccessGuard.name, {
          action: 'admin-access-check',
          outcome: 'failure',
          requestId,
          ...normalizeError(error),
        }),
      );
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException('Staff access required');
    }
  }

  private isFeatureEnabled(): boolean {
    const configured = this.config.get<string>('ADMIN_CONTROL_TOWER_ENABLED');
    if (configured !== undefined) return configured === 'true';
    return this.config.get<string>('NODE_ENV') !== 'production';
  }

  private extractToken(header?: string): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token || null;
  }

  private getRequestId(request: Request): string | undefined {
    const value = request.headers['x-request-id'];
    return Array.isArray(value) ? value[0] : value;
  }

  private async safeAudit(
    params: Parameters<AdminAccessAuditRepository['record']>[0],
  ): Promise<void> {
    try {
      await this.audit.record(params);
    } catch (error) {
      this.logger.error(
        buildBackendLog(AdminAccessGuard.name, {
          action: 'admin-access-audit',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
    }
  }
}
