import { Module } from '@nestjs/common';
import { PricingClient } from './pricing-client';

@Module({
  providers: [PricingClient],
  exports: [PricingClient],
})
export class PricingClientModule {}
