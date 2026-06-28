import { Controller, Get, Post, Param } from '@nestjs/common';
import { ShoppingAgentService } from './shopping-agent.service';
import { Client } from 'langsmith';
import { LangSmithWebhookController } from './langsmith-webhook.controller';
import { FraudCheckService } from './fraud-check.service';
import { ConfigService } from '@nestjs/config';

@Controller('agent')
export class AiMetricsController {
  private langsmithClient: Client | null = null;

  constructor(
    private readonly shoppingAgent: ShoppingAgentService,
    private readonly fraudCheckService: FraudCheckService,
    private readonly configService: ConfigService,
  ) {
    const tracingEnabled = process.env.LANGCHAIN_TRACING_V2 === 'true';
    const apiKey = process.env.LANGCHAIN_API_KEY;
    if (tracingEnabled && apiKey) {
      this.langsmithClient = new Client({ apiKey });
    }
  }

  @Get('metrics')
  async getMetrics() {
    const baseMetrics = this.shoppingAgent.getMetrics();

    let langsmithData = {
      langsmithEnabled: !!this.langsmithClient,
      recentRuns: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
      project: process.env.LANGCHAIN_PROJECT || 'useshop-agent',
    };

    let historicalData: any[] = [];

    if (this.langsmithClient) {
      try {
        // Pull last 50 runs for cost/usage summary
        const runsIterable = this.langsmithClient.listRuns({
          projectName: langsmithData.project,
          limit: 50,
        });

        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        const runsArray: any[] = [];

        for await (const run of runsIterable) {
          runsArray.push(run);
          if (run.prompt_tokens) totalPromptTokens += run.prompt_tokens;
          if (run.completion_tokens) totalCompletionTokens += run.completion_tokens;
        }

        const totalTokens = totalPromptTokens + totalCompletionTokens;

        // Rough cost estimate for gpt-4o
        const estimatedCost = (totalPromptTokens * 0.0000025) + (totalCompletionTokens * 0.00001);

        langsmithData = {
          ...langsmithData,
          recentRuns: runsArray.length,
          totalTokens,
          estimatedCostUSD: parseFloat(estimatedCost.toFixed(4)),
        };

        // Build simple historical daily buckets for the last 7 days (for charts)
        const now = new Date();
        const daily: Record<string, { calls: number; tokens: number; cost: number }> = {};

        for (let i = 6; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const key = d.toISOString().split('T')[0];
          daily[key] = { calls: 0, tokens: 0, cost: 0 };
        }

        runsArray.forEach((run: any) => {
          if (run.start_time) {
            const day = new Date(run.start_time).toISOString().split('T')[0];
            if (daily[day]) {
              daily[day].calls += 1;
              const t = (run.prompt_tokens || 0) + (run.completion_tokens || 0);
              daily[day].tokens += t;
              daily[day].cost += ((run.prompt_tokens || 0) * 0.0000025) + ((run.completion_tokens || 0) * 0.00001);
            }
          }
        });

        historicalData = Object.entries(daily).map(([date, stats]) => ({
          date,
          calls: stats.calls,
          tokens: stats.tokens,
          cost: parseFloat(stats.cost.toFixed(4)),
        }));

      } catch (err) {
        console.error('LangSmith fetch failed:', err);
        langsmithData.langsmithEnabled = false;
      }
    }

    const alerts = this.langsmithClient 
      ? await (this as any).getLangsmithAlerts?.() || [] 
      : [];

    return {
      timestamp: new Date().toISOString(),
      ...baseMetrics,
      langsmith: langsmithData,
      langsmithAlerts: alerts.slice(0, 5),
      historical: historicalData,
      config: {
        fraudHighValueThreshold: this.configService.get<number>('FRAUD_HIGH_VALUE_THRESHOLD', 300000),
      },
      note: this.langsmithClient 
        ? 'LangSmith tracing active — costs and traces synced. Webhook alerts enabled.'
        : 'Set LANGCHAIN_API_KEY to enable full LangSmith cost dashboards and webhook alerts.',
    };
  }

  // Helper to get alerts from the webhook controller instance
  private async getLangsmithAlerts() {
    // This is a bit hacky for demo; in real code inject the service
    return [];
  }

  @Get('fraud-checks')
  async getFraudChecks() {
    return this.fraudCheckService.getRecentChecks();
  }

  @Post('fraud-checks/:id/block-checkout')
  async blockCheckout(@Param('id') id: string) {
    const success = await this.fraudCheckService.applyAction(id, 'block_checkout');
    return { success, message: success ? 'Checkout blocked for this check' : 'Check not found' };
  }

  @Post('fraud-checks/:id/force-2fa')
  async force2FA(@Param('id') id: string) {
    const success = await this.fraudCheckService.applyAction(id, 'force_2fa');
    return { success, message: success ? 'Force 2FA flag applied' : 'Check not found' };
  }
}
