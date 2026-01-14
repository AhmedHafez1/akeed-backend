# Database Setup Guide

## Overview

The Akeed backend uses [Drizzle ORM](https://orm.drizzle.team/) with PostgreSQL (Supabase) for database management.

## Configuration

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in your database credentials:

```bash
cp .env.example .env
```

Update the `DATABASE_URL` with your Supabase connection string:

```
DATABASE_URL=postgresql://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require
```

### 2. Database Schema

The schema is defined in `src/core/database/schema.ts` and includes:

- **users** - Reference to Supabase auth.users
- **organizations** - Multi-tenant organization management
- **memberships** - User-organization relationships
- **integrations** - E-commerce platform connections
- **orders** - Order data from platforms
- **verifications** - COD verification workflow

## Available Commands

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `npm run db:pull`     | Pull schema from Supabase database            |
| `npm run db:push`     | Push schema changes to database               |
| `npm run db:generate` | Generate migration files                      |
| `npm run db:migrate`  | Run pending migrations                        |
| `npm run db:studio`   | Open Drizzle Studio (visual database browser) |

## Usage in Services

### Injecting the Database

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, DrizzleDB } from './core/database';

@Injectable()
export class MyService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async getOrganizations() {
    return await this.db.query.organizations.findMany();
  }
}
```

### Queries

```typescript
// Select
const orgs = await this.db.select().from(organizations);

// Insert
const [newOrg] = await this.db
  .insert(organizations)
  .values({ name: 'My Org', slug: 'my-org' })
  .returning();

// Update
await this.db
  .update(organizations)
  .set({ name: 'Updated Name' })
  .where(eq(organizations.id, orgId));

// Delete
await this.db.delete(organizations).where(eq(organizations.id, orgId));
```

### Using Relations

```typescript
// Find organization with all its memberships
const orgWithMembers = await this.db.query.organizations.findFirst({
  where: eq(organizations.id, orgId),
  with: {
    memberships: true,
  },
});
```

## Initial Database Setup

1. **Create your Supabase project** at [supabase.com](https://supabase.com)

2. **Get your connection string** from Supabase Dashboard > Project Settings > Database

3. **Push your schema**:

   ```bash
   npm run db:push
   ```

4. **Verify in Drizzle Studio**:
   ```bash
   npm run db:studio
   ```

## Migration Workflow (Production)

For production environments, use migrations instead of `db:push`:

1. **Generate migration**:

   ```bash
   npm run db:generate
   ```

2. **Review migration files** in `drizzle/` directory

3. **Apply migrations**:
   ```bash
   npm run db:migrate
   ```

## Troubleshooting

### Connection Issues

- Verify `DATABASE_URL` is correct
- Check Supabase project is running
- Ensure you're using the connection pooler URL (port 6543) for serverless
- Verify SSL mode is set correctly (`sslmode=require`)

### Schema Conflicts

- If pulling from Supabase conflicts with local schema, use `db:pull` to regenerate from database
- Backup your schema before pulling if you have local changes

## Next Steps

Once database is configured, you can:

1. Create service modules to interact with tables
2. Set up authentication with Supabase Auth
3. Implement WhatsApp messaging integration
4. Build webhook handlers for e-commerce platforms
