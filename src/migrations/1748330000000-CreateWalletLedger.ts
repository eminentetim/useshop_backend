import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from "typeorm";

export class CreateWalletLedger1748330000000 implements MigrationInterface {
    name = 'CreateWalletLedger1748330000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: "wallet_ledger",
                columns: [
                    {
                        name: "id",
                        type: "uuid",
                        isPrimary: true,
                        generationStrategy: "uuid",
                        default: "uuid_generate_v4()",
                    },
                    {
                        name: "walletId",
                        type: "uuid",
                    },
                    {
                        name: "type",
                        type: "enum",
                        enum: ["CREDIT", "DEBIT"],
                    },
                    {
                        name: "amount",
                        type: "decimal",
                        precision: 18,
                        scale: 2,
                    },
                    {
                        name: "balanceAfter",
                        type: "decimal",
                        precision: 18,
                        scale: 2,
                    },
                    {
                        name: "reference",
                        type: "varchar",
                        length: "100",
                    },
                    {
                        name: "description",
                        type: "text",
                    },
                    {
                        name: "metadata",
                        type: "jsonb",
                        isNullable: true,
                    },
                    {
                        name: "createdAt",
                        type: "timestamp",
                        default: "now()",
                    },
                ],
            }),
            true
        );

        // Add foreign key
        await queryRunner.createForeignKey(
            "wallet_ledger",
            new TableForeignKey({
                columnNames: ["walletId"],
                referencedColumnNames: ["id"],
                referencedTableName: "wallets",
                onDelete: "CASCADE",
            })
        );

        // Add index on wallet + createdAt
        await queryRunner.createIndex(
            "wallet_ledger",
            new TableIndex({
                name: "IDX_wallet_ledger_wallet_createdAt",
                columnNames: ["walletId", "createdAt"],
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropIndex("wallet_ledger", "IDX_wallet_ledger_wallet_createdAt");
        await queryRunner.dropForeignKey("wallet_ledger", "FK_wallet_ledger_walletId");
        await queryRunner.dropTable("wallet_ledger");
    }
}