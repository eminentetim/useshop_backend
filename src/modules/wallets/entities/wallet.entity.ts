import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum Currency {
  NGN = 'NGN',
  SOL = 'SOL',
  USDC = 'USDC',
  USDT = 'USDT',
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

  @Column({ nullable: true })
  monnifyAccountNumber: string;

  @Column({ nullable: true })
  monnifyAccountReference: string;

  @Column({ nullable: true })
  monnifyBankName: string;

  @ManyToOne(() => User, (user) => user.wallets)
  user: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
