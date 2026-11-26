import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminTemplateDraftValidateDto } from './admin-template-authoring.dto';

describe('template draft request validation', () => {
  it('keeps the Shipped tracking sample through the whitelist', () => {
    const dto = plainToInstance(AdminTemplateDraftValidateDto, {
      purpose: 'shipping_shipped',
      language: 'en',
      style: 'default',
      language_code: 'en',
      parameter_format: 'named',
      body: 'Hello {{customer}}\n{{tracking}}',
      confirm_label: "I'll receive it",
      cancel_label: "Won't be available",
      samples: { customer: 'Ahmed', tracking: ' Tracking: 1Z999 ' },
    });
    // The global pipe runs with `whitelist: true`: an undeclared sample key
    // would be stripped here and the draft could never pass validation.
    expect(
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(dto.samples.tracking).toBe('Tracking: 1Z999');
  });
});
