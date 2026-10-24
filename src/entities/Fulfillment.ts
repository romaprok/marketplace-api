import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Order } from './Order.js';

// The warehouse's pick request for an order, written by the order.placed
// consumer. order_id is the primary key on purpose: one fulfillment per
// order is the business rule, and it's also what makes the consumer's
// INSERT ... ON CONFLICT DO NOTHING safe to repeat.
@Entity({ name: 'fulfillments' })
export class Fulfillment {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @OneToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  // which event produced it — for debugging, not for dedup
  @Column({ name: 'event_id', type: 'varchar' })
  eventId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
