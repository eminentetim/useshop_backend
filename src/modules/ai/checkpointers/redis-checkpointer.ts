import { BaseCheckpointSaver, Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';

/**
 * Simple Redis-backed checkpoint saver for LangGraph.
 * Uses phoneNumber (thread_id) as the main key for conversation persistence.
 */
export class RedisCheckpointSaver extends BaseCheckpointSaver {
  private readonly redis: any;
  private readonly ttlSeconds: number;

  constructor(redisClient: any, ttlSeconds = 60 * 60 * 24 * 7) { // 7 days default
    super();
    this.redis = redisClient;
    this.ttlSeconds = ttlSeconds;
  }

  private getKey(threadId: string): string {
    return `langgraph:checkpoint:${threadId}`;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string;
    if (!threadId) return undefined;

    const data = await this.redis.get(this.getKey(threadId));
    if (!data) return undefined;

    const checkpoint = JSON.parse(data) as Checkpoint;
    return {
      config,
      checkpoint,
      metadata: {} as CheckpointMetadata,
    };
  }

  async *list(config: RunnableConfig): AsyncGenerator<CheckpointTuple> {
    // For simplicity, we only support latest checkpoint per thread.
    const tuple = await this.getTuple(config);
    if (tuple) yield tuple;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.redis.del(this.getKey(threadId));
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string;
    if (!threadId) throw new Error('thread_id is required for Redis checkpointing');

    await this.redis.setex(
      this.getKey(threadId),
      this.ttlSeconds,
      JSON.stringify(checkpoint)
    );

    return config;
  }

  async putWrites(
    config: RunnableConfig,
    writes: any[],
    taskId: string
  ): Promise<void> {
    // Not implemented for this basic version
  }
}
