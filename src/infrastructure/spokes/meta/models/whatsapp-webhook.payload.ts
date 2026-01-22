// Based on https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
export interface WhatsAppMessage {
  id: string;
  type: 'button' | 'interactive';
  interactive: {
    type: 'button_reply';
    button_reply: {
      id: string;
      title: string;
    };
  };
}

export interface WhatsAppStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read';
}

export interface WhatsAppValue {
  messaging_product: 'whatsapp';
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts: {
    profile: {
      name: string;
    };
    wa_id: string;
  }[];
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
}

export interface WhatsAppChange {
  value: WhatsAppValue;
  field: 'messages';
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppWebhookPayload {
  object: 'whatsapp_business_account';
  entry: WhatsAppEntry[];
}
