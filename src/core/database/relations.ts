import { relations } from 'drizzle-orm/relations';
import {
  organizations,
  memberships,
  users,
  integrations,
  orders,
  verifications,
} from './schema';

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organization: one(organizations, {
    fields: [memberships.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  integrations: many(integrations),
  orders: many(orders),
  verifications: many(verifications),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const integrationsRelations = relations(
  integrations,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [integrations.orgId],
      references: [organizations.id],
    }),
    orders: many(orders),
  }),
);

export const ordersRelations = relations(orders, ({ one, many }) => ({
  integration: one(integrations, {
    fields: [orders.integrationId],
    references: [integrations.id],
  }),
  organization: one(organizations, {
    fields: [orders.orgId],
    references: [organizations.id],
  }),
  verifications: many(verifications),
}));

export const verificationsRelations = relations(verifications, ({ one }) => ({
  order: one(orders, {
    fields: [verifications.orderId],
    references: [orders.id],
  }),
  organization: one(organizations, {
    fields: [verifications.orgId],
    references: [organizations.id],
  }),
}));
