import { connect, type ChannelModel } from 'amqplib';

export async function connectBroker(): Promise<ChannelModel> {
  const url = process.env.BROKER_URL;
  if (!url) {
    throw new Error('BROKER_URL is required: it comes from the vault via scripts/with-secrets.sh (README, Configuration)');
  }
  const conn = await connect(url);
  // without a listener an 'error' event on the connection kills the process
  conn.on('error', (err: Error) => console.error('[amqp] connection error:', err.message));
  return conn;
}
