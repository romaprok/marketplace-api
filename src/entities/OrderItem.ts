import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, RelationId } from 'typeorm';
import { numericTransformer } from '../util/numeric-transformer.js';
import { Order } from './Order.js';
import { Product } from './Product.js';

// This is the M:N with data on the link (quantity, price at purchase time)
// the assignment calls out explicitly — a real entity, not @ManyToMany.
@Entity({ name: 'order_items' })
export class OrderItem {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // CASCADE: a line item has no meaning once its order is gone — the only
  // CASCADE in this schema, everything else is RESTRICT (history-protecting).
  @ManyToOne(() => Order, (order) => order.items, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  // RESTRICT: what was actually bought must stay traceable even if the
  // product listing is later removed from the catalog.
  @ManyToOne(() => Product, (product) => product.orderItems, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  // Raw FK value, populated even when `product` itself isn't joined/loaded
  // — lets code read the id without pulling in the whole relation.
  @RelationId((item: OrderItem) => item.product)
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  // Snapshot of the product's price at purchase time — never re-read from
  // products.price, which can change after the order was placed.
  @Column({ name: 'unit_price', type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  unitPrice!: number;
}
