import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config';

/**
 * Wrapper fino sobre o SDK v3. Centraliza endpoint (MiniStack/LocalStack),
 * cache de URLs e o formato FIFO (MessageGroupId + MessageDeduplicationId).
 */
export class SqsGateway {
  readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(aws: AppConfig['aws']) {
    this.client = new SQSClient({
      endpoint: aws.endpoint,
      region: aws.region,
      credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
      maxAttempts: 2,
    });
  }

  queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${name} not found`);
        return r.QueueUrl;
      });
      url.catch(() => this.urls.delete(name));
      this.urls.set(name, url);
    }
    return url;
  }

  async send(queue: string, body: string, groupId: string, dedupId: string, attributes: Record<string, string> = {}) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
        MessageAttributes: Object.fromEntries(
          Object.entries(attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
        ),
      }),
    );
  }

  /**
   * Envia até 10 mensagens numa chamada. Num FIFO, mensagens do mesmo
   * MessageGroupId dentro do lote mantêm a ordem do lote. Devolve os ids que
   * FALHARAM (falha parcial é possível e precisa ser tratada).
   */
  async sendBatch(
    queue: string,
    entries: Array<{ id: string; body: string; groupId: string; dedupId: string; attributes?: Record<string, string> }>,
  ): Promise<Set<string>> {
    const res = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.queueUrl(queue),
        Entries: entries.map((e, i) => ({
          Id: String(i),
          MessageBody: e.body,
          MessageGroupId: e.groupId,
          MessageDeduplicationId: e.dedupId,
          MessageAttributes: Object.fromEntries(
            Object.entries(e.attributes ?? {}).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
          ),
        })),
      }),
    );
    return new Set((res.Failed ?? []).map((f) => (entries[Number(f.Id)] as { id: string }).id));
  }

  async receive(queue: string, max: number, waitSeconds: number, visibilitySeconds: number, signal?: AbortSignal) {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'SentTimestamp'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: signal },
    );
    return res.Messages ?? [];
  }

  async delete(queue: string, message: Message) {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(queue), ReceiptHandle: message.ReceiptHandle }));
  }

  async changeVisibility(queue: string, message: Message, seconds: number) {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async ping(queue: string): Promise<void> {
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(queue), AttributeNames: ['QueueArn'] }));
  }

  /** Idempotente: cria DLQ, fila de comandos (com redrive) e fila de eventos. */
  async ensureQueues(sqs: AppConfig['sqs']): Promise<void> {
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const dlq = await this.client.send(
      new CreateQueueCommand({ QueueName: sqs.commandsDlq, Attributes: { ...fifo, MessageRetentionPeriod: '1209600' } }),
    );
    const dlqArn = (
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn;
    await this.client.send(
      new CreateQueueCommand({
        QueueName: sqs.commandsQueue,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(sqs.visibilityTimeoutSeconds),
          // Rede de segurança do broker: se o consumidor morrer em loop numa
          // mensagem (poison pill), ela vai para a DLQ depois de N recebimentos.
          // O consumidor também envia explicitamente (e com motivo) antes disso.
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: sqs.maxReceiveCount + 1 }),
        },
      }),
    );
    await this.client.send(new CreateQueueCommand({ QueueName: sqs.eventsQueue, Attributes: fifo }));
  }
}

export function receiveCount(message: Message): number {
  return Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
}
