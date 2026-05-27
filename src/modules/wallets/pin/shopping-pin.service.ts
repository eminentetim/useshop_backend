import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Wallet } from '../entities/wallet.entity';

const SALT_ROUNDS = 10;
const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION_MINUTES = 15;

@Injectable()
export class ShoppingPINService {
  private readonly logger = new Logger(ShoppingPINService.name);

  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
  ) {}

  /**
   * Hash a raw PIN (never store plain text)
   */
  async hashPIN(rawPin: string): Promise<string> {
    if (!/^\d{4,6}$/.test(rawPin)) {
      throw new Error('PIN must be 4-6 digits');
    }
    return bcrypt.hash(rawPin, SALT_ROUNDS);
  }

  /**
   * Set or change a user's Shopping PIN (requires confirmation in calling code)
   */
  async setPIN(wallet: Wallet, rawPin: string): Promise<Wallet> {
    const pinHash = await this.hashPIN(rawPin);

    wallet.pinHash = pinHash;
    wallet.pinSetAt = new Date();
    wallet.pinLastChangedAt = new Date();
    wallet.failedPinAttempts = 0;
    wallet.pinLockedUntil = undefined;

    return this.walletRepository.save(wallet);
  }

  /**
   * Validate a raw PIN against the stored hash.
   * Handles lockout and attempt counting.
   */
  async validatePIN(wallet: Wallet, rawPin: string): Promise<{ valid: boolean; message: string }> {
    if (!wallet.pinHash) {
      return { valid: false, message: 'No Shopping PIN has been set. Please set one during onboarding.' };
    }

    // Check if locked
    if (wallet.pinLockedUntil && wallet.pinLockedUntil > new Date()) {
      const minutesLeft = Math.ceil((wallet.pinLockedUntil.getTime() - Date.now()) / 60000);
      return {
        valid: false,
        message: `Too many failed attempts. Please try again in ${minutesLeft} minute(s).`,
      };
    }

    const isMatch = await bcrypt.compare(rawPin, wallet.pinHash);

    if (isMatch) {
      // Success - reset attempts
      wallet.failedPinAttempts = 0;
      wallet.pinLockedUntil = undefined;
      await this.walletRepository.save(wallet);

      return { valid: true, message: 'PIN validated successfully.' };
    } else {
      // Failed attempt
      wallet.failedPinAttempts = (wallet.failedPinAttempts || 0) + 1;

      if (wallet.failedPinAttempts >= MAX_FAILED_ATTEMPTS) {
        wallet.pinLockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
        this.logger.warn(`Shopping PIN locked for wallet ${wallet.id} after ${MAX_FAILED_ATTEMPTS} failed attempts`);
      }

      await this.walletRepository.save(wallet);

      const attemptsLeft = MAX_FAILED_ATTEMPTS - wallet.failedPinAttempts;
      return {
        valid: false,
        message: `Invalid PIN. ${attemptsLeft > 0 ? `${attemptsLeft} attempt(s) remaining.` : 'Account temporarily locked.'}`,
      };
    }
  }

  /**
   * Check if a wallet has a PIN set
   */
  hasPINSet(wallet: Wallet): boolean {
    return !!wallet.pinHash;
  }

  /**
   * Reset failed attempts (e.g. after successful verification via other means)
   */
  async resetFailedAttempts(wallet: Wallet): Promise<void> {
    wallet.failedPinAttempts = 0;
    wallet.pinLockedUntil = undefined;
    await this.walletRepository.save(wallet);
  }

  /**
   * Change PIN with confirmation of the old PIN (core security requirement).
   * Re-uses validatePIN for oldPin (handles lockouts + attempt counting).
   */
  async changePINWithOldConfirmation(
    wallet: Wallet,
    oldPin: string,
    newPin: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!/^\d{4,6}$/.test(newPin)) {
      return { success: false, message: 'New PIN must be 4-6 digits.' };
    }

    // Validate old PIN first (this handles lockout + increments failure count on wrong old PIN)
    const oldValidation = await this.validatePIN(wallet, oldPin);
    if (!oldValidation.valid) {
      return {
        success: false,
        message: `Old PIN validation failed: ${oldValidation.message}`,
      };
    }

    // Old PIN was correct. Now set the new one (re-fetches fresh wallet state internally via setPIN path)
    // Re-load to ensure we have latest after validate's internal save
    const freshWallet = await this.walletRepository.findOne({ where: { id: wallet.id } });
    if (!freshWallet) {
      return { success: false, message: 'Wallet not found during PIN change.' };
    }

    await this.setPIN(freshWallet, newPin);
    this.logger.log(`Shopping PIN successfully changed for wallet ${wallet.id}`);

    return { success: true, message: 'Your Shopping PIN has been changed successfully.' };
  }
}
