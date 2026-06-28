import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EscalationService } from './escalation.service';
import { EscalationsController } from './escalations.controller';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [ConfigModule, forwardRef(() => AiModule)],
  providers: [EscalationService],
  controllers: [EscalationsController],
  exports: [EscalationService],
})
export class EscalationsModule {}
