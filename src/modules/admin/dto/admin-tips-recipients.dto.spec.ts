import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AdminTipsHistoryQueryDto,
  AdminTipsRecipientsDto,
} from './admin-tips-campaigns.dto';
import { TipsEventDto } from '../../tips/dto/tips.dto';

const ID = '12345678-1234-4234-8234-123456789abc';
describe('tips recipient request validation', () => {
  it.each(['add', 'remove', 'reissue'])(
    'accepts a bounded %s selection',
    (operation) => {
      expect(
        validateSync(
          plainToInstance(AdminTipsRecipientsDto, {
            revision: 1,
            operation,
            org_ids: [ID],
          }),
        ),
      ).toEqual([]);
    },
  );
  it.each(
    [
      [],
      [ID, ID.toUpperCase()],
      ['invalid'],
      [42],
      [null],
      Array.from({ length: 501 }, () => ID),
    ].map((org_ids) => ({ org_ids })),
  )('rejects invalid selections without throwing', ({ org_ids }) => {
    expect(
      validateSync(
        plainToInstance(AdminTipsRecipientsDto, {
          revision: 1,
          operation: 'add',
          org_ids,
        }),
      ),
    ).not.toHaveLength(0);
  });
  it('rejects invalid operations and revisions', () => {
    expect(
      validateSync(
        plainToInstance(AdminTipsRecipientsDto, {
          revision: 0,
          operation: 'publish',
          org_ids: [ID],
        }),
      ),
    ).toHaveLength(2);
  });
  it('accepts initial legacy events but bounds supplied generations', () => {
    expect(validateSync(plainToInstance(TipsEventDto, {}))).toEqual([]);
    expect(
      validateSync(plainToInstance(TipsEventDto, { delivery_generation: 2 })),
    ).toEqual([]);
    for (const generation of [0, 1.5, '2', 2147483648])
      expect(
        validateSync(
          plainToInstance(TipsEventDto, { delivery_generation: generation }),
        ),
      ).not.toHaveLength(0);
  });
  it('bounds and transforms history pagination', () => {
    expect(
      plainToInstance(AdminTipsHistoryQueryDto, { before: '2', limit: '25' }),
    ).toEqual({ before: 2, limit: 25 });
    expect(
      validateSync(
        plainToInstance(AdminTipsHistoryQueryDto, {
          before: 2147483648,
          limit: 101,
        }),
      ),
    ).toHaveLength(2);
  });
});
