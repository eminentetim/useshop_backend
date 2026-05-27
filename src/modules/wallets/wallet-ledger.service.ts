import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletLedger, LedgerEntryType } from './entities/wallet-ledger.entity';
import { Wallet } from './entities/wallet.entity';

@Injectable()
export class WalletLedgerService {
  constructor(
    @InjectRepository(WalletLedger)
    private readonly ledgerRepository: Repository<WalletLedger>,
  ) {}

  async recordEntry(params: {
    wallet: Wallet;
    type: LedgerEntryType;
    amount: number;
    balanceAfter: number;
    reference: string;
    description: string;
    metadata?: Record<string, any>;
  }): Promise<WalletLedger> {
    const entry = this.ledgerRepository.create({
      wallet: params.wallet,
      type: params.type,
      amount: params.amount,
      balanceAfter: params.balanceAfter,
      reference: params.reference,
      description: params.description,
      metadata: params.metadata || {},
    });

    return this.ledgerRepository.save(entry);
  }

  async findByWallet(walletId: string, limit = 50): Promise<WalletLedger[]> {
    return this.ledgerRepository.find({
      where: { wallet: { id: walletId } },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
