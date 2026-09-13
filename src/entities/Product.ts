import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { numericTransformer } from '../util/numeric-transformer.js';
import { OrderItem } from './OrderItem.js';
import { User } from './User.js';

export type ProductStatus = 'active' | 'archived';

@Entity({ name: 'products' })
export class Product {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // RESTRICT: a seller with products on the catalog can't be deleted out
  // from under them — same call as db/schema.sql in hw-12.
  @ManyToOne(() => User, (user) => user.products, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'seller_id' })
  seller!: User;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  price!: number;

  @Column({ type: 'varchar', length: 3, default: 'UAH' })
  currency!: string;

  @Column({ type: 'varchar', default: 'active' })
  status!: ProductStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems!: OrderItem[];
}
