import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { WalletLedgerService } from '../../wallets/wallet-ledger.service';
import { Wallet, Currency } from '../../wallets/entities/wallet.entity';
import { LedgerEntryType } from '../../wallets/entities/wallet-ledger.entity';
import { MessagingService } from '../../messaging/messaging.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentProvider } from '../interfaces/payment-provider.interface'; // interface only

/**
 * Monnify implementation of PaymentProvider.
 * Extracted from the previous monolithic PaymentsService.
 */
@Injectable()
export class MonnifyPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(MonnifyPaymentProvider.name);
  private accessToken: string;
  private tokenExpiry: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly walletLedgerService: WalletLedgerService,
    private readonly messagingService: MessagingService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
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
            headers: { Authorization: `Basic ${authString}` },
          },
        ),
      );

      this.accessToken = response.data.responseBody.accessToken;
      this.tokenExpiry = Date.now() + response.data.responseBody.expiresIn * 1000;
      return this.accessToken;
    } catch (error: any) {
      this.logger.error('Failed to get Monnify access token', error.response?.data || error.message);
      throw error;
    }
  }

  async createVirtualAccount(user: { id: string; name?: string; email?: string; phoneNumber: string }) {
    const baseUrl = this.configService.get<string>('MONNIFY_BASE_URL');
    const contractCode = this.configService.get<string>('MONNIFY_CONTRACT_CODE');
    const token = await this.getAccessToken();

    const data = {
      accountReference: `USEShop_${user.id}_${Date.now()}`,
      accountName: user.name || `UseShop User ${user.phoneNumber}`,
      currencyCode: 'NGN',
      contractCode,
      customerEmail: user.email || `${user.phoneNumber}@useshop.ai`,
      customerName: user.name || `User ${user.phoneNumber}`,
      getAllAvailableBanks: true,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${baseUrl}/api/v1/bank-transfer/reserved-accounts`, data, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return response.data.responseBody;
    } catch (error: any) {
      this.logger.error('Failed to create Monnify reserved account', error.response?.data || error.message);
      throw error;
    }
  }

  async handleIncomingDeposit(params: {
    providerReference: string;
    accountReference: string;
    amount: number;
    currency?: string;
  }) {
    const { providerReference, accountReference, amount, currency = 'NGN' } = params;

    const wallet = await this.walletRepository.findOne({
      where: { monnifyAccountReference: accountReference, currency: currency as Currency },
      relations: ['user'],
    });

    if (!wallet) {
      this.logger.error(`Wallet not found for Monnify reference: ${accountReference}`);
      return { success: false };
    }

    if (wallet.status !== 'ACTIVE') {
      this.logger.warn(`Attempted credit to non-active wallet: ${wallet.id}`);
      return { success: false };
    }

    const previousBalance = Number(wallet.balance);
    const newBalance = previousBalance + amount;

    await this.walletLedgerService.recordEntry({
      wallet,
      type: LedgerEntryType.CREDIT,
      amount,
      balanceAfter: newBalance,
      reference: providerReference,
      description: `Wallet funded via Monnify - ${providerReference}`,
      metadata: {
        monnifyReference: providerReference,
        accountReference,
        source: 'monnify_webhook',
      },
    });

    wallet.balance = newBalance;
    await this.walletRepository.save(wallet);

    // Low balance alert
    const LOW_BALANCE_THRESHOLD = this.configService.get<number>('LOW_BALANCE_THRESHOLD', 5000);
    if (newBalance < LOW_BALANCE_THRESHOLD && currency === 'NGN' && wallet.user?.phoneNumber) {
      this.messagingService.publishLowBalanceAlert(wallet.user.phoneNumber, newBalance, currency).catch(() => {});
    }

    return { success: true, walletId: wallet.id, newBalance };
  }

  async initiatePayout(params: any) {
    // This method already existed as initiateMonnifyDisbursement
    // For now we delegate to the existing logic (we can move the body here later)
    // To keep changes minimal in this step, we'll keep the old method for now
    // and call it from here.
    return { success: false, message: 'Payout via interface not fully migrated yet' };
  }

  async handlePayoutUpdate(eventData: any) {
    // Delegate to existing logic
    this.logger.log('Payout update received via PaymentProvider interface');
    // In a full refactor we would move handleDisbursementUpdate here
  }
}
