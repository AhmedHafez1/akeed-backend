import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AdminStoreDeleteDto {
  /** The store name as staff typed it to confirm the delete. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  confirm_store_name!: string;
}
