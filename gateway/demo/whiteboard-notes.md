## Distributed Systems - Week 6

## Message queues
- decouple producers from consumers
- Redis Streams > Kafka (no ZooKeeper!)

The diagram shows a message queue workflow where a gateway sends tasks to redis, which are then processed by workers.

## Consumer groups
- each event handled once per group
- `XAUTOCLAIM` recovers stuck entries

`throughput = jobs / sec` (we got 91.7)

## Action items
- Priya - consumer groups section by Fri
- Marcus - rerun benchmark w/ 3 workers
