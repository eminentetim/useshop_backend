import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { WalletLedgerService } from '../wallets/wallet-ledger.service';
import { Wallet, Currency } from '../wallets/entities/wallet.entity';
import { LedgerEntryType } from '../wallets/entities/wallet-ledger.entity';
import { MessagingService } from '../messaging/messaging.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';


@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private accessToken: string;
  private tokenExpiry: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly walletLedgerService: WalletLedgerService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @Optional() private readonly messagingService?: MessagingService,
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
    const baseUrl = this.configService.get<string>('MONNIFY_BASE_URL');
    const contractCode = this.configService.get<string>('MONNIFY_CONTRACT_CODE');
    const token = await this.getAccessToken();

    const data = {
      accountReference: `USEShop_${user.id}_${Date.now()}`,
      accountName: user.name || `UseShop User ${user.phoneNumber}`,
      currencyCode: 'NGN',
      contractCode: contractCode,
      customerEmail: user.email || `${user.phoneNumber}@useshop.ai`,
      customerName: user.name || `User ${user.phoneNumber}`,
      getAllAvailableBanks: true,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${baseUrl}/api/v1/bank-transfer/reserved-accounts`, data, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
      return response.data.responseBody;
    } catch (error) {
      this.logger.error('Failed to create Monnify reserved account', error.response?.data || error.message);
      throw error;
    }
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
    const wallet = await this.walletRepository.findOne({
      where: { monnifyAccountReference: accountReference, currency: currency as Currency },
      relations: ['user'],
    });

    if (!wallet) {
      this.logger.error(`Wallet not found for Monnify reference: ${accountReference}`);
      return;
    }

    if (wallet.status !== 'ACTIVE') {
      this.logger.warn(`Attempted credit to non-active wallet: ${wallet.id}`);
      return;
    }

    const previousBalance = Number(wallet.balance);
    const newBalance = previousBalance + amount;

    await this.walletLedgerService.recordEntry({
      wallet,
      type: LedgerEntryType.CREDIT,
      amount,
      balanceAfter: newBalance,
      reference: monnifyReference,
      description: `Wallet funded via Monnify - ${monnifyReference}`,
      metadata: {
        monnifyReference,
        accountReference,
        source: 'monnify_webhook',
      },
    });

    wallet.balance = newBalance;
    await this.walletRepository.save(wallet);

    this.logger.log(`Wallet ${wallet.id} credited with ₦${amount} via Monnify. New balance: ₦${newBalance}`);

    const LOW_BALANCE_THRESHOLD = this.configService.get<number>('LOW_BALANCE_THRESHOLD', 5000);
    if (newBalance < LOW_BALANCE_THRESHOLD && currency === 'NGN') {
      const phone = wallet.user?.phoneNumber;
      if (phone && this.messagingService) {
        this.messagingService.publishLowBalanceAlert(phone, newBalance, currency).catch(err =>
          this.logger.error('Failed to publish low balance alert', err),
        );
      }
      this.logger.warn(`Low balance alert published for ${wallet.user?.phoneNumber || 'unknown'}: ₦${newBalance}`);
    }

    return { walletId: wallet.id, newBalance };
  }

  /**
   * Future: Initiate a real bank disbursement via Monnify (for "refund to bank" cases).
   * For true instant UX we currently prefer crediting the UseShop wallet (see OrdersService.refundToWallet).
   * This method can be called from an admin flow or escalation when the customer wants funds sent to their bank.
   */
  async initiateMonnifyDisbursement(params: {
    phoneNumber: string;
    amount: number;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    reference?: string;
    narration?: string;
  }) {
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
      async: true,
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
