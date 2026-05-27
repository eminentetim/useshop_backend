import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { Wallet } from './wallet.entity';

export enum LedgerEntryType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

@Entity('wallet_ledger')
@Index(['wallet', 'createdAt'])
export class WalletLedger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Wallet, { onDelete: 'CASCADE' })
  wallet: Wallet;

  @Column({
    type: 'enum',
    enum: LedgerEntryType,
  })
  type: LedgerEntryType;

  @Column({ type: 'decimal', precision: 18, scale: 2 })
  amount: number;

  @Column({ type: 'decimal', precision: 18, scale: 2 })
  balanceAfter: number;

  @Column({ length: 100 })
  reference: string; // Monnify reference, internal txn id, or order id

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
