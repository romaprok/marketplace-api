import { Column, CreateDateColumn, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { numericTransformer } from '../util/numeric-transformer.js';
import { Order } from './Order.js';
import { Product } from './Product.js';

@Entity({ name: 'users' })
export class User {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ name: 'display_name', type: 'varchar' })
  displayName!: string;

  // Account balance in the same currency as orders/products — spent by
  // checkout() atomically alongside the stock decrement (hw-14).
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numericTransformer })
  balance!: number;

  // hw-24. The source of truth for permissions; the role in an access token
  // is only a copy that lives until the token expires.
  @Column({ type: 'varchar', default: 'buyer' })
  role!: 'buyer' | 'seller' | 'admin';

  @Column({ name: 'password_hash', type: 'text', nullable: true, select: false })
  passwordHash!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => Product, (product) => product.seller)
  products!: Product[];

  @OneToMany(() => Order, (order) => order.buyer)
  orders!: Order[];
}
