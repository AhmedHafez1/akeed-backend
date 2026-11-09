import { createHash } from 'node:crypto';
import type { RegistryTemplate } from './template-registry.types';
import type {
  TemplateDraftContent,
  TemplateDraftSamples,
} from './template-draft.types';
import type { TemplateTextModel } from './template-text.types';
import { CHANGE_BUTTON_LABELS } from './change-request-messaging';
import {
  buildDraftKey,
  buildTemplateName,
  deriveDraftVariables,
  validateTemplateDraft,
  toTemplateSubmission as requireSubmission,
} from './template-draft.validation';
import {
  templateSampleValues,
  variablesByParameter,
} from './template-rendering';

export interface ChangePreparationPlan {
  sourceKind?: 'registry' | 'draft';
  parentKey: string;
  sourceUpdatedAt: string;
  content: TemplateDraftContent;
  key: string;
  differences: string[];
  issues: ReturnType<typeof validateTemplateDraft>['issues'];
}

export function planDraftChange(
  content: TemplateDraftContent,
  key: string,
  updatedAt: string,
): ChangePreparationPlan | null {
  const submission = requireSubmission(content);
  const template: RegistryTemplate = {
    key,
    purpose: content.purpose,
    language: content.language,
    style: content.style,
    templateName: content.templateName,
    languageCode: content.languageCode,
    parameterFormat: content.parameterFormat,
    variables: deriveDraftVariables(
      content.body,
      content.parameterFormat,
      content.samples,
    ).map((v) => ({
      key: v.key,
      ...(content.parameterFormat === 'named' ? { name: v.parameter } : {}),
    })),
    preview: {
      greeting: '',
      body: content.body,
      totalLabel: '',
      ending: '',
      confirmButton: content.confirmLabel,
      cancelButton: content.cancelLabel,
    },
    isActive: false,
    isDefault: false,
    reviewStatus: null,
    lastSyncedAt: null,
    category: content.category,
  };
  const plan = planChangeDraft(
    template,
    {
      format: content.parameterFormat,
      body: submission.body,
      buttons: submission.buttons,
    },
    updatedAt,
    content.samples,
  );
  return plan ? { ...plan, sourceKind: 'draft' } : null;
}

/** Copies the provider text, translating its parameter syntax into the existing authoring model. */
export function planChangeDraft(
  template: RegistryTemplate,
  model: TemplateTextModel | null,
  sourceUpdatedAt: string,
  samples?: TemplateDraftSamples,
): ChangePreparationPlan | null {
  if (
    !model ||
    model.header ||
    model.footer ||
    model.buttons.length !== 2 ||
    model.buttons.some((button) => button.kind !== 'quick_reply') ||
    !template.category
  )
    return null;
  const parameters = variablesByParameter(template);
  let unreadable = false;
  const body = model.body
    .map((segment) => {
      if ('text' in segment) return segment.text;
      const variable = parameters.get(segment.parameter);
      if (!variable) {
        unreadable = true;
        return '';
      }
      return `{{${variable.key}}}`;
    })
    .join('');
  if (unreadable) return null;
  const style = `change_${createHash('md5').update(template.key).digest('hex').slice(0, 16)}`;
  const content: TemplateDraftContent = {
    purpose: template.purpose,
    language: template.language,
    style,
    version: 1,
    templateName: buildTemplateName(template.purpose, style, 1),
    languageCode: template.languageCode,
    parameterFormat: template.parameterFormat,
    category: template.category,
    body,
    confirmLabel: model.buttons[0].text,
    cancelLabel: model.buttons[1].text,
    changeLabel: CHANGE_BUTTON_LABELS[template.language],
    changeRequestOfKey: template.key,
    samples: { ...templateSampleValues(template.language), ...samples },
  };
  const variables = deriveDraftVariables(
    body,
    content.parameterFormat,
    content.samples,
  );
  // The authoring model supports first-use positional parameters and canonical named ones.
  if (
    variables.some(
      (v) =>
        !parameters.has(v.parameter) ||
        parameters.get(v.parameter)?.key !== v.key,
    )
  )
    return null;
  const differences: string[] = [];
  if (
    content.confirmLabel !== template.preview.confirmButton ||
    content.cancelLabel !== template.preview.cancelButton
  )
    differences.push('provider_button_labels_differ_from_preview');
  return {
    parentKey: template.key,
    sourceUpdatedAt,
    content,
    key: buildDraftKey(template.purpose, template.language, style, 1),
    differences,
    issues: validateTemplateDraft(content, { takenIdentities: new Set() })
      .issues,
  };
}
