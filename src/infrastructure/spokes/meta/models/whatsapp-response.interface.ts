export interface WhatsAppResponse {
  messaging_product: 'whatsapp';
  contacts: Contact[];
  messages: Message[];
}

export interface Contact {
  input: string;
  wa_id: string;
}

export interface Message {
  id: string;
  message_status: 'accepted' | 'sent' | 'delivered' | 'read';
}
