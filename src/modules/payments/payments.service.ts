import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { WalletLedgerService } from '../wallets/wallet-ledger.service';
import { Wallet, Currency } from '../wallets/entities/wallet.entity';
import { LedgerEntryType } from '../wallets/entities/wallet-ledger.entity';
import { MessagingService } from '../messaging/messaging.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PAYMENT_PROVIDER } from './interfaces/payment-provider.interface';
import type { PaymentProvider } from './interfaces/payment-provider.interface';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private accessToken: string;
  private tokenExpiry: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly walletLedgerService: WalletLedgerService,
    private readonly messagingService: MessagingService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const apiKey = this.configService.get<string>('MONNIFY_API_KEY');
    const secretKey = this.configService.get<string>('MONNIFY_SECRET_KEY');
    const baseUrl = this.configService.get<string>('MONNIFY_BASE_URL');

    const authString = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${baseUrl}/api/v1/auth/login`,
          {},
          {
            headers: {
              Authorization: `Basic ${authString}`,
            },
          },
        ),
      );

      this.accessToken = response.data.responseBody.accessToken;
      this.tokenExpiry = Date.now() + response.data.responseBody.expiresIn * 1000;
      return this.accessToken;
    } catch (error) {
      this.logger.error('Failed to get Monnify access token', error.response?.data || error.message);
      throw error;
    }
  }

  async createReservedAccount(user: { id: string; name?: string; email?: string; phoneNumber: string }) {
    // Delegate to the active PaymentProvider (Monnify for now)
    return this.paymentProvider.createVirtualAccount(user);
  }

  /**
   * Called from Monnify webhook when a deposit is successful.
   * Credits the wallet atomically using double-entry ledger.
   */
  async handleSuccessfulDeposit(
    monnifyReference: string,
    accountReference: string,
    amount: number,
    currency: string = 'NGN',
  ) {
    // Delegate to the active PaymentProvider
    return this.paymentProvider.handleIncomingDeposit({
      providerReference: monnifyReference,
      accountReference,
      amount,
      currency,
    });
  }

  /**
   * Future: Initiate a real bank disbursement via Monnify (for "refund to bank" cases).
   * For true instant UX we currently prefer crediting the UseShop wallet (see OrdersService.refundToWallet).
   * This method can be called from an admin flow or escalation when the customer wants funds sent to their bank.
   */
  async initiateMonnifyDisbursement(params: any) {
    // Delegate to provider (full migration of body can happen later)
    return this.paymentProvider.initiatePayout(params);
  }

  // Legacy method kept for backward compatibility during transition
  private async _legacyInitiateMonnifyDisbursement(params: {
    phoneNumber: string;
    amount: number;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    reference?: string;
    narration?: string;
  }): Promise<{ success: boolean; message: string; reference?: string; monnifyStatus?: string; data?: any }> {
    const baseUrl = this.configService.get<string>('MONNIFY_BASE_URL', 'https://sandbox.monnify.com');
    const token = await this.getAccessToken();

    const reference = params.reference || `REFUND_BANK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const payload = {
      amount: params.amount,
      reference,
      narration: params.narration || `UseShop refund to ${params.phoneNumber}`,
      destinationBankCode: params.bankCode,
      destinationAccountNumber: params.accountNumber,
      destinationAccountName: params.accountName,
      currency: 'NGN',
      // sourceAccountNumber is often required — use the merchant's settlement account if known
      // For many setups it is the main wallet. Leaving optional for now.
      async: true, // Prefer async + webhooks in production
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${baseUrl}/api/v2/disbursements/single`, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }),
      );

      const body = response.data;
      const status = body?.responseBody?.status || body?.status || 'UNKNOWN';

      this.logger.log(`Monnify disbursement initiated. Ref: ${reference}, Status: ${status}`);

      return {
        success: ['SUCCESS', 'PENDING', 'PENDING_AUTHORIZATION', 'IN_PROGRESS'].includes(status),
        message: `Bank transfer initiated via Monnify. Status: ${status}`,
        reference,
        monnifyStatus: status,
        data: body?.responseBody || body,
      };
    } catch (error: any) {
      const errData = error.response?.data || error.message;
      this.logger.error('Monnify disbursement failed', errData);

      return {
        success: false,
        message: `Monnify disbursement failed: ${errData?.responseMessage || errData}`,
        reference,
      };
    }
  }

  /**
   * Handle Monnify disbursement (outgoing bank transfer) webhook updates.
   * Supports SUCCESS / FAILED statuses for refund-to-bank flows.
   */
  async handleDisbursementUpdate(eventData: any) {
    const reference = eventData?.reference || eventData?.transactionReference || eventData?.paymentReference;
    const status = (eventData?.status || eventData?.transferStatus || '').toUpperCase();

    this.logger.log(`Disbursement webhook received — Ref: ${reference}, Status: ${status}`);

    if (!reference) return;

    // In production you would look up the order by the reference we stored in metadata.
    // For now we log + could trigger additional WhatsApp or escalation.
    if (['SUCCESS', 'PAID', 'COMPLETED', 'SUCCESSFUL'].includes(status)) {
      this.logger.log(`✅ Bank disbursement completed successfully for ${reference}`);
      // Future: update order metadata with final success time + credit confirmation
    } else if (['FAILED', 'REVERSED', 'CANCELLED'].includes(status)) {
      this.logger.warn(`❌ Bank disbursement failed for ${reference}`);
      // Future improvement: automatically credit wallet back via ledger + notify customer + create escalation
    }
  }
}
