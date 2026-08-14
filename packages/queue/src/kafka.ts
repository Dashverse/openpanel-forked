import { createLogger } from '@openpanel/logger';
import {
  type Consumer,
  Kafka,
  type KafkaConfig,
  type SASLOptions,
  logLevel,
} from 'kafkajs';
import {
  disconnectEventHubProducer,
  produceViaEventHub,
} from './eventhub-producer';
import type { EventsQueuePayloadIncomingEvent } from './queues';

export type { KafkaMessage } from 'kafkajs';

export const kafkaLogger = createLogger({ name: 'kafka' });

const parseBrokers = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
};

export const KAFKA_BROKERS = parseBrokers(process.env.KAFKA_BROKERS);
export const KAFKA_EVENTS_TOPIC = process.env.KAFKA_EVENTS_TOPIC || 'events';
export const KAFKA_CONSUMER_GROUP =
  process.env.KAFKA_CONSUMER_GROUP || 'openpanel-events';
export const KAFKA_PARTITIONS_CONCURRENT = Number.parseInt(
  process.env.KAFKA_PARTITIONS_CONCURRENT || '8',
  10,
);

// Approx size of one event payload (observed range ~0.9–1.3 KiB).
// We size fetch knobs in messages and convert to bytes via this constant.
const KAFKA_BYTES_PER_MESSAGE = 1024;

export const KAFKA_MIN_MESSAGES = Number.parseInt(
  process.env.KAFKA_MIN_MESSAGES || '1',
  10,
);
export const KAFKA_MAX_WAIT_MS = Number.parseInt(
  process.env.KAFKA_MAX_WAIT_MS || '500',
  10,
);
export const KAFKA_MAX_MESSAGES_PER_PARTITION = Number.parseInt(
  process.env.KAFKA_MAX_MESSAGES_PER_PARTITION || '256',
  10,
);
export const KAFKA_SESSION_TIMEOUT_MS = Number.parseInt(
  process.env.KAFKA_SESSION_TIMEOUT_MS || '30000',
  10,
);
export const KAFKA_HEARTBEAT_INTERVAL_MS = Number.parseInt(
  process.env.KAFKA_HEARTBEAT_INTERVAL_MS || '3000',
  10,
);

// Client fail-fast knobs (used by the consumer's Kafka client). Defaults give a
// worst-case connect/request of a few seconds instead of kafkajs's stock ~150s,
// so a broker hiccup fails fast instead of hanging.
export const KAFKA_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.KAFKA_REQUEST_TIMEOUT_MS || '5000',
  10,
);
export const KAFKA_CONNECTION_TIMEOUT_MS = Number.parseInt(
  process.env.KAFKA_CONNECTION_TIMEOUT_MS || '2000',
  10,
);

const KAFKA_MIN_BYTES = KAFKA_MIN_MESSAGES * KAFKA_BYTES_PER_MESSAGE;
const KAFKA_MAX_BYTES_PER_PARTITION =
  KAFKA_MAX_MESSAGES_PER_PARTITION * KAFKA_BYTES_PER_MESSAGE;

// TLS + SASL — required by managed brokers (e.g. Azure Event Hubs Kafka
// endpoint), left off for a plaintext local broker (Redpanda). Event Hubs:
//   KAFKA_SSL=true
//   KAFKA_SASL_MECHANISM=plain
//   KAFKA_SASL_USERNAME=$ConnectionString
//   KAFKA_SASL_PASSWORD=Endpoint=sb://<ns>.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=...
const buildSasl = (): SASLOptions | undefined => {
  const mechanism = process.env.KAFKA_SASL_MECHANISM?.trim();
  const username = process.env.KAFKA_SASL_USERNAME;
  const password = process.env.KAFKA_SASL_PASSWORD;
  if (!mechanism || !username || !password) {
    return undefined;
  }
  return { mechanism, username, password } as SASLOptions;
};

export const isKafkaConfigured = (): boolean => KAFKA_BROKERS.length > 0;

// ─── TEMPORARY: per-project rollout gate ────────────────────────────────────
// Lets us migrate one project at a time (frameo → … → *) instead of a big-bang
// cutover. Mirrors REPLAY_ENABLED_PROJECT_IDS. Once every project is on Kafka,
// DELETE the allow-list below and collapse this to:
//   export const shouldUseKafka = (): boolean => isKafkaConfigured();
// and drop the projectId arg at the two call sites (track/event controller).
const kafkaProjectIdsEnv = (process.env.KAFKA_PROJECT_IDS || '').trim();
const kafkaAllowAllProjects = kafkaProjectIdsEnv === '*';
const kafkaProjectIdAllowList = new Set<string>(
  kafkaProjectIdsEnv && !kafkaAllowAllProjects
    ? kafkaProjectIdsEnv
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [],
);

export const shouldUseKafka = (projectId: string): boolean => {
  if (!isKafkaConfigured()) {
    return false;
  }
  if (kafkaAllowAllProjects) {
    return true;
  }
  return kafkaProjectIdAllowList.has(projectId);
};

let kafka: Kafka | null = null;
const getKafka = (): Kafka => {
  if (!isKafkaConfigured()) {
    throw new Error(
      'KAFKA_BROKERS env var is not set; cannot create Kafka client',
    );
  }
  if (!kafka) {
    const sasl = buildSasl();
    const config: KafkaConfig = {
      clientId: process.env.KAFKA_CLIENT_ID || 'openpanel',
      brokers: KAFKA_BROKERS,
      logLevel: logLevel.WARN,
      requestTimeout: KAFKA_REQUEST_TIMEOUT_MS,
      connectionTimeout: KAFKA_CONNECTION_TIMEOUT_MS,
      // Default ssl on when SASL is present (managed brokers require TLS);
      // explicit KAFKA_SSL=true/false overrides.
      ssl: process.env.KAFKA_SSL
        ? process.env.KAFKA_SSL === 'true'
        : Boolean(sasl),
      sasl,
    };
    kafka = new Kafka(config);
  }
  return kafka;
};

// Produce one event to the events topic via the Azure Event Hubs buffered
// producer (auto-batches → no per-request round-trip, no mif=1 pile-up / OOM).
// The events CONSUMER is still kafkajs — an AMQP-produced object body round-
// trips to it as clean JSON (verified on the prod topic). Requires
// EVENTHUB_CONNECTION_STRING; there is no kafkajs producer path anymore.
export const produceIncomingEvent = (
  payload: EventsQueuePayloadIncomingEvent['payload'],
  partitionKey: string,
): Promise<void> => produceViaEventHub(payload, partitionKey);

const consumers = new Set<Consumer>();

export const createKafkaEventsConsumer = (options?: {
  groupId?: string;
}): Consumer => {
  const client = getKafka();
  const consumer = client.consumer({
    groupId: options?.groupId || KAFKA_CONSUMER_GROUP,
    sessionTimeout: KAFKA_SESSION_TIMEOUT_MS,
    heartbeatInterval: KAFKA_HEARTBEAT_INTERVAL_MS,
    minBytes: KAFKA_MIN_BYTES,
    maxWaitTimeInMs: KAFKA_MAX_WAIT_MS,
    maxBytesPerPartition: KAFKA_MAX_BYTES_PER_PARTITION,
  });
  consumers.add(consumer);
  return consumer;
};

export const disconnectKafka = async (): Promise<void> => {
  const tasks: Promise<unknown>[] = [disconnectEventHubProducer()];
  for (const c of consumers) {
    tasks.push(
      c.disconnect().catch((err) => {
        kafkaLogger.error('kafka consumer disconnect error', { err });
      }),
    );
  }
  consumers.clear();
  await Promise.all(tasks);
};
