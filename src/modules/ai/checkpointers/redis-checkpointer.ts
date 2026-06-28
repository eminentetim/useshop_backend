import { BaseCheckpointSaver, Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, AIMessage, ToolMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';

function deserializeMessage(msg: any): BaseMessage {
  if (msg instanceof BaseMessage) {
    return msg;
  }

  const kwargs = msg.kwargs || msg;
  const content = kwargs.content || msg.content || '';
  const name = kwargs.name || msg.name;
  const id = kwargs.id || msg.id;
  const additional_kwargs = kwargs.additional_kwargs || {};
  const tool_calls = kwargs.tool_calls || msg.tool_calls;
  const tool_call_id = kwargs.tool_call_id || msg.tool_call_id;

  let type = msg.type || msg._type;
  if (!type && msg.id && Array.isArray(msg.id)) {
    const last = msg.id[msg.id.length - 1];
    if (last.endsWith('Message')) {
      type = last.replace('Message', '').toLowerCase();
    }
  }

  switch (type) {
    case 'human':
      return new HumanMessage({ content, name, id, additional_kwargs });
    case 'ai':
      return new AIMessage({ content, name, id, additional_kwargs, tool_calls });
    case 'tool':
      return new ToolMessage({ content, tool_call_id, name, id, additional_kwargs });
    case 'system':
      return new SystemMessage({ content, name, id, additional_kwargs });
    default:
      return new HumanMessage({ content, name, id, additional_kwargs });
  }
}

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

    try {
      const checkpoint = JSON.parse(data) as Checkpoint;
      
      // Properly deserialize messages back to LangChain classes
      if (checkpoint.channel_values && Array.isArray(checkpoint.channel_values.messages)) {
        checkpoint.channel_values.messages = checkpoint.channel_values.messages.map(deserializeMessage);
      }
      
      return {
        config,
        checkpoint,
        metadata: {} as CheckpointMetadata,
      };
    } catch (e) {
      return undefined;
    }
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
