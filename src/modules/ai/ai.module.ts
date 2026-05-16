import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiService } from './ai.service';
import { SearchTool } from './tools/search.tool';

@Module({
  imports: [HttpModule],
  providers: [AiService, SearchTool],
  exports: [AiService],
})
export class AiModule {}
