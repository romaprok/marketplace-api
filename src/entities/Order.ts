import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { numericTransformer } from '../util/numeric-transformer.js';
import { OrderItem } from './OrderItem.js';
import { User } from './User.js';

export type OrderStatus = 'pending' | 'paid' | 'cancelled';

@Entity({ name: 'orders' })
export class Order {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // RESTRICT: order history must survive the buyer account existing — same
  // call as db/schema.sql in hw-12.
  @ManyToOne(() => User, (user) => user.orders, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'buyer_id' })
  buyer!: User;

  @Column({ type: 'varchar', default: 'pending' })
  status!: OrderStatus;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numericTransformer })
  total!: number;

  @Column({ type: 'varchar', length: 3, default: 'UAH' })
  currency!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => OrderItem, (item) => item.order)
  items!: OrderItem[];
}
