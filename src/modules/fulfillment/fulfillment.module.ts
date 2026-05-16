import { Module } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';

@Module({
  providers: [FulfillmentService]
})
export class FulfillmentModule {}
