import { IsString, IsNumber, IsOptional, Min } from 'class-validator';

export class AddToCartDto {
  @IsString()
  productTitle: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsNumber()
  @Min(1)
  quantity: number = 1;

  @IsOptional()
  @IsString()
  productUrl?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;
}
