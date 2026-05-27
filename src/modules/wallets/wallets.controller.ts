import { Controller, Get, Query } from '@nestjs/common';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get()
  async listWallets(@Query('phone') phone?: string) {
    const wallets = await this.walletsService.findAll(phone);
    return wallets.map(w => ({
      id: w.id,
      phoneNumber: w.user?.phoneNumber,
      currency: w.currency,
      balance: Number(w.balance),
      status: w.status,
      monnifyAccountNumber: w.monnifyAccountNumber,
      monnifyBankName: w.monnifyBankName,
      createdAt: w.createdAt,
    }));
  }
}
