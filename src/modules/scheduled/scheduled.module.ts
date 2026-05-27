import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ScheduledJobsService } from './scheduled-jobs.service';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MessagingModule,
  ],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService],
})
export class ScheduledModule {}