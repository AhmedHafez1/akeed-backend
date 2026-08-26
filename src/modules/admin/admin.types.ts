import type { Request } from 'express';
import type { AuthenticatedAdmin } from '../auth/services/token-validator.service';

export interface RequestWithAdmin extends Request {
  admin: AuthenticatedAdmin;
}

export type AdminLifecycleStatus =
  | 'installed'
  | 'onboarding'
  | 'active'
  | 'inactive'
  | 'uninstalled';

export type AdminHealthStatus = 'healthy' | 'attention_required' | 'critical';
