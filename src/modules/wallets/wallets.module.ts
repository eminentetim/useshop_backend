import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { Wallet } from './entities/wallet.entity';
import { Transaction } from './entities/transaction.entity';
import { WalletLedger } from './entities/wallet-ledger.entity';
import { WalletLedgerService } from './wallet-ledger.service';
import { ShoppingPINService } from './pin/shopping-pin.service';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet, Transaction, WalletLedger])],
  controllers: [WalletsController],
  providers: [WalletsService, WalletLedgerService, ShoppingPINService],
  exports: [WalletsService, WalletLedgerService, ShoppingPINService],
})
export class WalletsModule {}
