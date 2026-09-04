/**
 * Development seed.
 *
 * Safe to run repeatedly: every write is an upsert keyed on a stable id or a
 * unique column, so a second run updates rather than duplicating. That matters
 * because you will run this dozens of times — a seed that throws on the second
 * run is a seed you stop using.
 *
 *   npx prisma db seed                          # against .env  (Supabase dev)
 *   npx dotenv -e .env.test -- npx prisma db seed   # against .env.test (Docker)
 */

import { prisma } from '../src/config/db.js';

// ─────────────────────────────────────────────
// Stable ids
//
// Address, Product, Order, OrderItem and Payment have no unique column other
// than their primary key, so there is nothing for upsert to match on. Hardcoded
// uuids give each seeded row a fixed identity across runs — and let you paste a
// known id straight into Postman while building the modules.
// ─────────────────────────────────────────────

const ID = {
  productJar20: '11111111-0000-4000-8000-000000000001',
  productJar10: '11111111-0000-4000-8000-000000000002',
  productDeposit: '11111111-0000-4000-8000-000000000003',
  productRetired: '11111111-0000-4000-8000-000000000004',

  addressPrimary: '22222222-0000-4000-8000-000000000001',
  addressSecondary: '22222222-0000-4000-8000-000000000002',

  orderPending: '33333333-0000-4000-8000-000000000001',
  orderDelivered: '33333333-0000-4000-8000-000000000002',

  itemPending1: '44444444-0000-4000-8000-000000000001',
  itemDelivered1: '44444444-0000-4000-8000-000000000002',
  itemDelivered2: '44444444-0000-4000-8000-000000000003',

  paymentPending: '55555555-0000-4000-8000-000000000001',
  paymentSuccess: '55555555-0000-4000-8000-000000000002',
};

// Deliberately outside the 987654xxxx range the OTP tests use, so seeded users
// can never collide with test fixtures if both ever share a database.
const PHONE = {
  admin: '9800000001',
  deliveryBoy: '9800000002',
  customer: '9800000011',
  suspended: '9800000012',
};

async function main() {
  // ── Service areas ─────────────────────────
  // One inactive on purpose: the serviceability check has two branches and you
  // need data for both. A seed that only covers the happy path hides bugs.

  const [andheriWest, versova, vashi] = await Promise.all([
    prisma.serviceArea.upsert({
      where: { pincode: '400053' },
      update: { areaName: 'Andheri West', isActive: true },
      create: { pincode: '400053', areaName: 'Andheri West', isActive: true },
    }),
    prisma.serviceArea.upsert({
      where: { pincode: '400061' },
      update: { areaName: 'Versova', isActive: true },
      create: { pincode: '400061', areaName: 'Versova', isActive: true },
    }),
    prisma.serviceArea.upsert({
      where: { pincode: '400703' },
      update: { areaName: 'Vashi (not serviced yet)', isActive: false },
      create: {
        pincode: '400703',
        areaName: 'Vashi (not serviced yet)',
        isActive: false,
      },
    }),
  ]);

  // ── Users ─────────────────────────────────
  // No passwords: login is OTP-only. To sign in as any of these, POST the phone
  // to /api/auth/request-otp and read the code from the server console.
  //
  // tokenVersion and status are pinned in `update` so a re-run resets a user you
  // suspended or logged out while testing.

  // Not bound to a variable — nothing below references the admin row, only its
  // phone number in the summary table.
  await prisma.user.upsert({
    where: { phone: PHONE.admin },
    update: { name: 'Admin', role: 'ADMIN', status: 'ACTIVE' },
    create: {
      phone: PHONE.admin,
      name: 'Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });

  const deliveryBoy = await prisma.user.upsert({
    where: { phone: PHONE.deliveryBoy },
    update: {
      name: 'Ramesh (Delivery)',
      role: 'DELIVERY_BOY',
      status: 'ACTIVE',
    },
    create: {
      phone: PHONE.deliveryBoy,
      name: 'Ramesh (Delivery)',
      role: 'DELIVERY_BOY',
      status: 'ACTIVE',
    },
  });

  const customer = await prisma.user.upsert({
    where: { phone: PHONE.customer },
    update: { name: 'Priya Sharma', role: 'CUSTOMER', status: 'ACTIVE' },
    create: {
      phone: PHONE.customer,
      name: 'Priya Sharma',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  });

  // Exists so you can prove requireAuth rejects a valid, correctly signed token
  // belonging to a non-ACTIVE account. That check is the entire reason the guard
  // hits the database on every request, and nothing tests it yet.
  const suspended = await prisma.user.upsert({
    where: { phone: PHONE.suspended },
    update: {
      name: 'Suspended Test User',
      role: 'CUSTOMER',
      status: 'SUSPENDED',
    },
    create: {
      phone: PHONE.suspended,
      name: 'Suspended Test User',
      role: 'CUSTOMER',
      status: 'SUSPENDED',
    },
  });

  // ── Profiles ──────────────────────────────

  const customerProfile = await prisma.customerProfile.upsert({
    where: { userId: customer.id },
    update: { email: 'priya@example.com' },
    create: { userId: customer.id, email: 'priya@example.com' },
  });

  await prisma.customerProfile.upsert({
    where: { userId: suspended.id },
    update: {},
    create: { userId: suspended.id },
  });

  await prisma.deliveryBoyProfile.upsert({
    where: { userId: deliveryBoy.id },
    update: {
      vehicleNumber: 'MH01AB1234',
      isAvailable: true,
      assignedServiceAreaId: andheriWest.id,
    },
    create: {
      userId: deliveryBoy.id,
      vehicleNumber: 'MH01AB1234',
      isAvailable: true,
      assignedServiceAreaId: andheriWest.id,
    },
  });

  // ── Addresses ─────────────────────────────
  // Both pincodes are active service areas. Note nothing in the schema enforces
  // that link — Address.pincode is a plain string. Keeping the addresses module
  // honest about it is application logic you still have to write.

  const primaryAddress = await prisma.address.upsert({
    where: { id: ID.addressPrimary },
    update: {},
    create: {
      id: ID.addressPrimary,
      customerProfileId: customerProfile.id,
      line1: 'Flat 402, Sai Krupa CHS',
      line2: 'Lokhandwala Complex',
      city: 'Mumbai',
      pincode: '400053',
      isDefault: true,
    },
  });

  await prisma.address.upsert({
    where: { id: ID.addressSecondary },
    update: {},
    create: {
      id: ID.addressSecondary,
      customerProfileId: customerProfile.id,
      line1: 'Office 12, Aram Nagar',
      city: 'Mumbai',
      pincode: '400061',
      isDefault: false,
    },
  });

  // ── Products ──────────────────────────────
  // Prices are strings, not numbers. The column is Decimal(10,2); passing a JS
  // float would round-trip through binary floating point on the way in.
  //
  // The retired product is inactive so you can prove the public catalogue
  // filters on isActive while admin listings do not.

  await Promise.all([
    prisma.product.upsert({
      where: { id: ID.productJar20 },
      update: { price: '60.00', isActive: true },
      create: {
        id: ID.productJar20,
        name: '20L Water Jar',
        description: 'Standard 20 litre jar, refill only',
        capacityMl: 20000,
        price: '60.00',
        isDeposit: false,
        isActive: true,
      },
    }),
    prisma.product.upsert({
      where: { id: ID.productJar10 },
      update: { price: '40.00', isActive: true },
      create: {
        id: ID.productJar10,
        name: '10L Water Jar',
        description: 'Compact 10 litre jar, refill only',
        capacityMl: 10000,
        price: '40.00',
        isDeposit: false,
        isActive: true,
      },
    }),
    prisma.product.upsert({
      where: { id: ID.productDeposit },
      update: { price: '300.00', isActive: true },
      create: {
        id: ID.productDeposit,
        name: '20L Jar Security Deposit',
        description: 'One-time refundable deposit charged on the first jar',
        capacityMl: 20000,
        price: '300.00',
        isDeposit: true,
        isActive: true,
      },
    }),
    prisma.product.upsert({
      where: { id: ID.productRetired },
      update: { isActive: false },
      create: {
        id: ID.productRetired,
        name: '5L Bottle (discontinued)',
        capacityMl: 5000,
        price: '25.00',
        isDeposit: false,
        isActive: false,
      },
    }),
  ]);

  // ── Sample orders ─────────────────────────
  // Two orders at opposite ends of the lifecycle, so the admin dashboard and the
  // delivery screens have something to render before the orders module exists.
  //
  // totalAmount is stored, not computed, so it must equal the sum of its items —
  // 2 × 60.00 here, and 60.00 + 40.00 below. Keep them in step if you edit prices.

  await prisma.order.upsert({
    where: { id: ID.orderPending },
    update: {},
    create: {
      id: ID.orderPending,
      customerId: customer.id,
      addressId: primaryAddress.id,
      status: 'PENDING',
      totalAmount: '120.00',
    },
  });

  await prisma.orderItem.upsert({
    where: { id: ID.itemPending1 },
    update: {},
    create: {
      id: ID.itemPending1,
      orderId: ID.orderPending,
      productId: ID.productJar20,
      quantity: 2,
      // Copied from the product at order time, never joined at read time — the
      // price on an old order must not change when the catalogue does.
      unitPrice: '60.00',
    },
  });

  await prisma.payment.upsert({
    where: { orderId: ID.orderPending },
    update: {},
    create: {
      id: ID.paymentPending,
      orderId: ID.orderPending,
      amount: '120.00',
      status: 'PENDING',
    },
  });

  await prisma.order.upsert({
    where: { id: ID.orderDelivered },
    update: {},
    create: {
      id: ID.orderDelivered,
      customerId: customer.id,
      deliveryBoyId: deliveryBoy.id,
      addressId: primaryAddress.id,
      status: 'DELIVERED',
      totalAmount: '100.00',
      deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });

  await Promise.all([
    prisma.orderItem.upsert({
      where: { id: ID.itemDelivered1 },
      update: {},
      create: {
        id: ID.itemDelivered1,
        orderId: ID.orderDelivered,
        productId: ID.productJar20,
        quantity: 1,
        unitPrice: '60.00',
      },
    }),
    prisma.orderItem.upsert({
      where: { id: ID.itemDelivered2 },
      update: {},
      create: {
        id: ID.itemDelivered2,
        orderId: ID.orderDelivered,
        productId: ID.productJar10,
        quantity: 1,
        unitPrice: '40.00',
      },
    }),
  ]);

  await prisma.payment.upsert({
    where: { orderId: ID.orderDelivered },
    update: {},
    create: {
      id: ID.paymentSuccess,
      orderId: ID.orderDelivered,
      amount: '100.00',
      status: 'SUCCESS',
      razorpayOrderId: 'order_SEEDFAKE000001',
      razorpayPaymentId: 'pay_SEEDFAKE000001',
      razorpaySignature: 'seed-signature-not-verifiable',
    },
  });

  console.log('\nSeed complete.\n');
  console.table([
    { role: 'ADMIN', phone: PHONE.admin, note: 'admin routes' },
    { role: 'DELIVERY_BOY', phone: PHONE.deliveryBoy, note: 'Andheri West' },
    { role: 'CUSTOMER', phone: PHONE.customer, note: '2 addresses, 2 orders' },
    { role: 'CUSTOMER', phone: PHONE.suspended, note: 'SUSPENDED — guard test' },
  ]);
  console.log(
    `\nServiceable: ${andheriWest.pincode}, ${versova.pincode}` +
      `  |  Not serviceable: ${vashi.pincode}`
  );
  console.log('Log in with any phone above via /api/auth/request-otp.\n');
}

main()
  .catch((err) => {
    console.error('Seed failed:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // db.js holds a pg pool with min: 2, so without this the process hangs on
    // two idle sockets instead of exiting.
    await prisma.$disconnect();
  });
