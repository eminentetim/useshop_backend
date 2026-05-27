import { IsString, Length, IsOptional } from 'class-validator';

export class RequestCheckoutDto {
  // Can be empty — we derive from phone number in WhatsApp context
}

export class ConfirmPaymentDto {
  @IsString()
  @Length(4, 4, { message: 'Reference must be in format USE-XXXX' })
  reference: string;

  @IsString()
  @Length(4, 4, { message: 'PIN must be 4 digits' })
  pin: string;

  @IsOptional()
  metadata?: Record<string, any>;
}
