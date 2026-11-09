import { IsInt, IsUUID, Max, Min } from 'class-validator';

/**
 * Names the request the merchant was looking at, so an action taken on a
 * page that went stale (the customer answered, another tab acted, a newer
 * request opened) is refused rather than applied to something else.
 */
export class ChangeRequestActionDto {
  @IsUUID()
  changeRequestId!: string;
}

/** A resend also names the cycle it was asked in. */
export class ChangeRequestResendDto extends ChangeRequestActionDto {
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedCycle!: number;
}
