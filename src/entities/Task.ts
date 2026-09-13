import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Order } from './Order.js';

export type TaskStatus = 'pending' | 'done';

// Post-processing queue: checkout() (hw-14) enqueues one row per order
// (e.g. "send receipt"); the worker pool in demo-workers.ts drains it via
// FOR UPDATE SKIP LOCKED.
@Entity({ name: 'tasks' })
export class Task {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  type!: string;

  // CASCADE: a leftover post-processing task for a deleted order is noise,
  // not history worth keeping — the one place in this schema where that's
  // the right call, unlike every other FK here (see hw-12/hw-13 RESTRICT).
  @ManyToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'varchar', default: 'pending' })
  status!: TaskStatus;

  // Incremented by whichever worker actually processes the row. Should
  // never exceed 1 — that's the whole point of SKIP LOCKED.
  @Column({ type: 'int', default: 0 })
  processed!: number;

  @Column({ name: 'processed_by', type: 'varchar', nullable: true })
  processedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;
}
