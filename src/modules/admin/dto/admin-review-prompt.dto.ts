import { IsBoolean } from 'class-validator';

export class AdminReviewPromptDto {
  @IsBoolean()
  enabled!: boolean;
}
