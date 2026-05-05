export const ORDER_ADMIN_PORT = Symbol('ORDER_ADMIN_PORT');

export interface OrderAdminPort {
  cancelOrder(
    integration: any,
    externalOrderId: string,
    reason: string,
  ): Promise<{ jobId?: string }>;
}
