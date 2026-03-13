import { SetMetadata } from '@nestjs/common';

export const ALLOW_ORGLESS_KEY = 'allowOrgless';

export const AllowOrgless = () => SetMetadata(ALLOW_ORGLESS_KEY, true);
