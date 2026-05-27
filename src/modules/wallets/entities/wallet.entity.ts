import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum Currency {
  NGN = 'NGN',
  SOL = 'SOL',
  USDC = 'USDC',
  USDT = 'USDT',
}

export enum WalletStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
  CLOSED = 'CLOSED',
}

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: Currency,
    default: Currency.NGN,
  })
  currency: Currency;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  balance: number;

  @Column({
    type: 'enum',
    enum: WalletStatus,
    default: WalletStatus.ACTIVE,
  })
  status: WalletStatus;

  // Monnify reserved account details
  @Column({ nullable: true })
  monnifyAccountNumber: string;

  @Column({ nullable: true })
  monnifyAccountReference: string;

  @Column({ nullable: true })
  monnifyBankName: string;

  // Shopping PIN (hashed)
  @Column({ nullable: true })
  pinHash: string;

  @Column({ nullable: true })
  pinSetAt: Date;

  @Column({ nullable: true })
  pinLastChangedAt: Date;

  // Security
  @Column({ default: 0 })
  failedPinAttempts: number;

  @Column({ nullable: true })
  pinLockedUntil?: Date;

  // Limits (can be overridden per user)
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  dailyLimit: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  perTransactionLimit: number;

  @ManyToOne(() => User, (user) => user.wallets)
  user: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
