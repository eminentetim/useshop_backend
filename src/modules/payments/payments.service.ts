import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private accessToken: string;
  private tokenExpiry: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
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

  async createReservedAccount(user: { id: string; name: string; email: string; phoneNumber: string }) {
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
}
