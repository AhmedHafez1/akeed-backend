import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Removes Supabase logins, for staff deleting a dead store. */
@Injectable()
export class AdminAuthUsersService {
  private client?: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  /** Deletes one login. Resolves false when Supabase refuses or fails. */
  async deleteUser(userId: string): Promise<boolean> {
    this.client ??= createClient(
      this.config.getOrThrow<string>('SUPABASE_URL'),
      this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await this.client.auth.admin.deleteUser(userId);
    return !error;
  }
}
