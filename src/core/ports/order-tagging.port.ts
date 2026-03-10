export const ORDER_TAGGING_PORT = Symbol('ORDER_TAGGING_PORT');

export interface OrderTaggingPort {
  addOrderTag(integration: any, orderId: string, tag: string): Promise<void>;
}
