import { Inject, Injectable, Optional } from '@nestjs/common';
import { MessageImprovementSwitches } from '../../shared/config/message-improvement-switches';
import {
  messageLinesFromProvider,
  messageLinesFromRegistered,
} from '../../shared/messaging/template-rendering';
import type { RegistryTemplate } from '../../shared/messaging/template-registry.types';
import type { TemplateMessageLines } from '../../shared/messaging/template-text.types';
import {
  TEMPLATE_CATALOG_PORT,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';

/**
 * The message a merchant previews for a template (US-08-07g). With
 * WHATSAPP_SNAPSHOT_PREVIEW_ENABLED on and a synced snapshot, it is read from
 * the provider's own text; otherwise from the stored preview. Either way the
 * caller gets the same neutral lines.
 */
@Injectable()
export class TemplateMessageService {
  constructor(
    @Optional()
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog?: TemplateCatalogPort,
    @Optional() private readonly switches?: MessageImprovementSwitches,
  ) {}

  linesFor(template: RegistryTemplate): TemplateMessageLines {
    if (this.switches?.current().snapshotPreview && this.catalog) {
      const model = this.catalog.describeComponents(
        template.components ?? null,
      );
      if (model) return messageLinesFromProvider(model, template);
    }
    return messageLinesFromRegistered(template);
  }
}
