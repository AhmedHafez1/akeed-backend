/**
 * Reader columns from later migrations (change-request messaging, the Track
 * order link label) for historical, template-only fixtures.
 */
export async function ensureChangeRequestTemplateColumns(client: {
  unsafe(query: string): PromiseLike<unknown>;
}): Promise<void> {
  await client.unsafe(`
    ALTER TABLE IF EXISTS whatsapp_templates ADD COLUMN IF NOT EXISTS change_request_of_key text;
    ALTER TABLE IF EXISTS whatsapp_template_drafts ADD COLUMN IF NOT EXISTS change_label text;
    ALTER TABLE IF EXISTS whatsapp_template_drafts ADD COLUMN IF NOT EXISTS change_request_of_key text;
    ALTER TABLE IF EXISTS whatsapp_template_drafts ADD COLUMN IF NOT EXISTS link_label text;
  `);
}
