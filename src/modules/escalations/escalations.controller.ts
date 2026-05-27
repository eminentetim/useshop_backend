import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { EscalationService } from './escalation.service';
import { ShoppingAgentService } from '../ai/shopping-agent.service';

@Controller('escalations')
export class EscalationsController {
  constructor(
    private readonly escalationService: EscalationService,
    private readonly shoppingAgent: ShoppingAgentService,
  ) {}

  @Get()
  async getAll() {
    return this.escalationService.getAllEscalations();
  }

  @Get('pending')
  async getPending() {
    return this.escalationService.getPendingEscalations();
  }

  @Post(':id/resolve')
  async resolve(@Param('id') id: string) {
    const success = await this.escalationService.resolveEscalation(id);
    return { success, message: success ? 'Escalation resolved' : 'Escalation not found' };
  }

  // New: Generate AI suggestion for resolution (uses support persona)
  @Post(':id/ai-suggest')
  async getAiSuggestion(@Param('id') id: string, @Body() body: { reason?: string; phoneNumber?: string }) {
    const suggestion = await this.shoppingAgent.processMessage(
      `Escalation for ${body.phoneNumber || 'customer'}: ${body.reason || 'issue'}. Act as a senior human support specialist and generate a warm, professional resolution message that offers immediate help and next steps.`,
      'support-agent'
    );

    return {
      suggestion,
      escalationId: id,
      generatedBy: 'Support Persona via LangGraph Agent',
    };
  }
}
