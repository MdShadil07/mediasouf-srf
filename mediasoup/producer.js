export async function createProducer(transport, kind, rtpParameters, userId) {
  const producer = await transport.produce({
    kind,
    rtpParameters,
    appData: { userId, transportId: transport.id },
  });

  producer.on('transportclose', () => producer.close());
  producer.on('close', () => console.log(`Producer ${producer.id} closed`));

  return producer;
}
