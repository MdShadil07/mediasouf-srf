export async function createConsumer(transport, producerId, rtpCapabilities) {
  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: true,
  });

  consumer.on('transportclose', () => consumer.close());
  consumer.on('producerclose', () => consumer.close());

  return consumer;
}
