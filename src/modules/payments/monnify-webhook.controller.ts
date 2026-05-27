import { Controller, Post, Body, Headers, Logger, HttpCode, UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Controller('monnify')
export class MonnifyWebhookController {
  private readonly logger = new Logger(MonnifyWebhookController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly configService: ConfigService,
  ) {}

  private verifyMonnifySignature(payload: any, signature: string): boolean {
    const secret = this.configService.get<string>('MONNIFY_SECRET_KEY');
    if (!secret) {
      this.logger.warn('MONNIFY_SECRET_KEY not set — skipping signature verification (dev only)');
      return true; // Allow in development if key not set
    }

    if (!signature) {
      this.logger.error('Missing monnify-signature header');
      return false;
    }

    const computedHash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return computedHash === signature;
  }

  @Post('webhook')
  @HttpCode(200)
  async handleMonnifyWebhook(
    @Body() payload: any,
    @Headers('monnify-signature') signature: string,
  ) {
    this.logger.log('Received Monnify webhook');

    // Production-grade signature verification
    if (!this.verifyMonnifySignature(payload, signature)) {
      this.logger.error('Invalid Monnify webhook signature');
      throw new UnauthorizedException('Invalid signature');
    }

    const eventType = payload.eventType;
    const eventData = payload.eventData;

    if (eventType === 'SUCCESSFUL_TRANSACTION' && eventData?.paymentStatus === 'PAID') {
      const {
        transactionReference,
        paymentReference,
        amountPaid,
        paymentDescription,
        customer: { accountReference },
      } = eventData;

      // Only process deposits to our reserved accounts
      if (paymentDescription?.includes('Wallet Funding') || accountReference?.startsWith('USEShop_')) {
        await this.paymentsService.handleSuccessfulDeposit(
          transactionReference,
          accountReference,
          parseFloat(amountPaid),
          'NGN',
        );
      }
    }

    // === Disbursement / Bank Transfer Webhooks (for refund-to-bank) ===
    if (
      eventType === 'DISBURSEMENT' ||
      eventType === 'TRANSFER' ||
      (eventData?.eventType && eventData.eventType.includes('DISBURSE'))
    ) {
      await this.paymentsService.handleDisbursementUpdate(eventData);
    }

    // Monnify sometimes uses different top-level keys for disbursement callbacks
    if (payload?.eventType?.includes('DISBURSEMENT') || payload?.data?.status) {
      await this.paymentsService.handleDisbursementUpdate(payload.data || payload);
    }

    return { status: 'success' };
  }
}
