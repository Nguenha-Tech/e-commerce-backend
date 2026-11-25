/* eslint-disable no-console */
import { env } from '../config/env';
import { ALL_PERMISSIONS, permissionGroup, SYSTEM_ROLES } from '../config/permissions';
import { refreshProductAggregates } from '../modules/products/aggregates';
import { hashPassword } from '../utils/crypto';
import { slugify } from '../utils/slug';
import {
  DiscountType,
  InventoryMovementType,
  PaymentMethodType,
  prisma,
  ProductStatus,
  ShippingMethodType,
} from './client';

/** Seed idempotente: pode correr várias vezes sem duplicar dados. */

export async function seedRbac() {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: { group: permissionGroup(key) }, create: { key, group: permissionGroup(key) } });
  }
  const perms = await prisma.permission.findMany();
  for (const [name, def] of Object.entries(SYSTEM_ROLES)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { level: def.level, description: def.description, isSystem: true },
      create: { name, level: def.level, description: def.description, isSystem: true },
    });
    // Roles de sistema são sincronizadas com o código a cada seed.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const ids = perms.filter((p) => (def.permissions as readonly string[]).includes(p.key)).map((p) => p.id);
    if (ids.length) await prisma.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: role.id, permissionId })) });
  }
  console.log(`✔ ${ALL_PERMISSIONS.length} permissions, ${Object.keys(SYSTEM_ROLES).length} roles`);
}

export async function seedOwner() {
  if (!env.OWNER_EMAIL || !env.OWNER_PASSWORD) {
    console.log('ℹ OWNER_EMAIL/OWNER_PASSWORD not set — skipping owner account');
    return;
  }
  const owner = await prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
  const customer = await prisma.role.findUniqueOrThrow({ where: { name: 'CUSTOMER' } });
  const user = await prisma.user.upsert({
    where: { email: env.OWNER_EMAIL.toLowerCase() },
    update: {},
    create: {
      name: env.OWNER_NAME,
      email: env.OWNER_EMAIL.toLowerCase(),
      passwordHash: await hashPassword(env.OWNER_PASSWORD),
      emailVerifiedAt: new Date(),
    },
  });
  for (const roleId of [owner.id, customer.id]) {
    await prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId } }, update: {}, create: { userId: user.id, roleId } });
  }
  console.log(`✔ owner account ${user.email}`);
}

const CATEGORY_TREE: Record<string, string[] | Record<string, string[]>> = {
  Eletrónicos: {
    Smartphones: ['Android', 'iPhone'],
    Tablets: [],
    Headphones: [],
    Carregadores: [],
    Cabos: [],
    Smartwatches: [],
    Computadores: [],
    Acessórios: [],
    Outros: [],
  },
};

async function upsertCategory(name: string, parentId: string | null, sortOrder: number) {
  const slug = slugify(name);
  return prisma.category.upsert({ where: { slug }, update: {}, create: { name, slug, parentId, sortOrder } });
}

export async function seedCategories() {
  for (const [rootName, children] of Object.entries(CATEGORY_TREE)) {
    const root = await upsertCategory(rootName, null, 0);
    let i = 0;
    for (const [childName, grandChildren] of Object.entries(children)) {
      const child = await upsertCategory(childName, root.id, i++);
      let j = 0;
      for (const g of grandChildren as string[]) await upsertCategory(g, child.id, j++);
    }
  }
  // Especificações sugeridas por categoria (não obrigatórias).
  const templates: Record<string, Array<[string, string, string?]>> = {
    smartphones: [['ram', 'RAM', 'GB'], ['storage', 'Armazenamento', 'GB'], ['cpu', 'Processador'], ['screen', 'Ecrã', 'polegadas'], ['camera', 'Câmara', 'MP'], ['battery', 'Bateria', 'mAh'], ['os', 'Sistema operativo'], ['5g', '5G'], ['dual_sim', 'Dual SIM']],
    headphones: [['bluetooth', 'Bluetooth'], ['anc', 'ANC'], ['battery', 'Bateria', 'mAh'], ['autonomy', 'Autonomia', 'h'], ['mic', 'Microfone'], ['type', 'Tipo'], ['connectivity', 'Conectividade']],
    carregadores: [['power', 'Potência', 'W'], ['port_type', 'Tipo de porta'], ['ports', 'Número de portas'], ['fast_charging', 'Fast Charging'], ['compatibility', 'Compatibilidade']],
  };
  for (const [slug, specs] of Object.entries(templates)) {
    const cat = await prisma.category.findUnique({ where: { slug } });
    if (!cat) continue;
    let order = 0;
    for (const [key, label, unit] of specs) {
      await prisma.specificationTemplate.upsert({
        where: { categoryId_key: { categoryId: cat.id, key } },
        update: {},
        create: { categoryId: cat.id, key, label, unit, sortOrder: order++ },
      });
    }
  }
  console.log('✔ categories + specification templates');
}

export async function seedBrands() {
  for (const name of ['Samsung', 'Apple', 'Xiaomi', 'JBL', 'Anker', 'Baseus', 'Huawei', 'Lenovo', 'Sony']) {
    await prisma.brand.upsert({ where: { slug: slugify(name) }, update: {}, create: { name, slug: slugify(name) } });
  }
  console.log('✔ brands');
}

export async function seedShippingAndPayments() {
  const methods = [
    { code: 'STANDARD', name: 'Entrega normal', type: ShippingMethodType.STANDARD, basePrice: 30_000, pricePerKg: 5_000, freeShippingThreshold: 1_500_000, estimatedDaysMin: 2, estimatedDaysMax: 5, sortOrder: 0 },
    { code: 'EXPRESS', name: 'Entrega express', type: ShippingMethodType.EXPRESS, basePrice: 60_000, pricePerKg: 10_000, freeShippingThreshold: null, estimatedDaysMin: 0, estimatedDaysMax: 1, sortOrder: 1 },
    { code: 'PICKUP', name: 'Levantamento na loja', type: ShippingMethodType.PICKUP, basePrice: 0, pricePerKg: 0, freeShippingThreshold: null, estimatedDaysMin: 0, estimatedDaysMax: 1, sortOrder: 2 },
  ];
  for (const m of methods) {
    const method = await prisma.shippingMethod.upsert({ where: { code: m.code }, update: {}, create: m });
    if (m.type === ShippingMethodType.PICKUP) continue;
    const hasRates = await prisma.shippingRate.count({ where: { methodId: method.id } });
    if (!hasRates) {
      // Ex.: Maputo cidade mais barato; resto do país pelo preço nacional.
      await prisma.shippingRate.createMany({
        data: [
          { methodId: method.id, country: 'Moçambique', province: 'Maputo Cidade', price: m.basePrice },
          { methodId: method.id, country: 'Moçambique', province: 'Maputo Província', price: Math.round(m.basePrice * 1.5) },
          { methodId: method.id, country: 'Moçambique', price: m.basePrice * 3, estimatedDaysMin: m.estimatedDaysMin + 2, estimatedDaysMax: m.estimatedDaysMax + 4 },
        ],
      });
    }
  }

  const payments = [
    { code: 'CASH_ON_DELIVERY', name: 'Pagamento na entrega', type: PaymentMethodType.CASH_ON_DELIVERY, provider: 'cod', sortOrder: 2, isActive: true },
    {
      code: 'BANK_TRANSFER', name: 'Transferência bancária', type: PaymentMethodType.BANK_TRANSFER, provider: 'manual', sortOrder: 1, isActive: true,
      instructions: 'Transfira o valor indicando o número do pedido como referência. O pedido é confirmado após verificação.',
      config: { bank: 'Banco Exemplo', accountName: 'Electro Shop, Lda', nib: '0000 0000 0000 0000 0000 0' },
    },
    // Gateway simulado: apenas fora de produção (substituir por M-Pesa/e-Mola/cartão reais).
    { code: 'MOBILE_MONEY_TEST', name: 'Mobile Money (teste)', type: PaymentMethodType.MOBILE_MONEY, provider: 'mock', sortOrder: 0, isActive: !env.isProd },
  ];
  for (const p of payments) await prisma.paymentMethod.upsert({ where: { code: p.code }, update: {}, create: p });
  console.log('✔ shipping + payment methods');
}

export async function seedStore() {
  await prisma.storeSetting.upsert({ where: { key: 'tax' }, update: {}, create: { key: 'tax', value: { ratePercent: env.TAX_RATE_PERCENT, includedInPrices: env.TAX_INCLUDED_IN_PRICES } } });
  const wa = await prisma.whatsAppConfig.count();
  if (!wa) {
    await prisma.whatsAppConfig.create({
      data: {
        isEnabled: false,
        countryCode: '258',
        phoneNumber: '840000000',
        defaultMessage: 'Olá! Gostaria de obter mais informações sobre os produtos disponíveis na loja.',
        contextMessages: {
          HOMEPAGE: 'Olá! Gostaria de saber mais sobre os produtos da loja.',
          PRODUCT: 'Olá! Tenho interesse no produto:\n{productName}\n\nGostaria de saber mais informações sobre disponibilidade e preço.',
          CART: 'Olá! Gostaria de obter ajuda com o meu carrinho.',
          CHECKOUT: 'Olá! Preciso de ajuda para finalizar a minha compra.',
        },
        businessHours: { timezone: 'Africa/Maputo', days: { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '18:00'], sat: ['09:00', '13:00'] } },
      },
    });
  }
  await prisma.coupon.upsert({
    where: { code: 'TECH10' },
    update: {},
    create: { code: 'TECH10', description: '10% de desconto', discountType: DiscountType.PERCENTAGE, value: 10, minOrderAmount: 500_000, usageLimitPerUser: 1 },
  });
  console.log('✔ store settings, WhatsApp config, coupon TECH10');
}

export async function seedSampleProducts() {
  if (env.isProd) return;
  const img = (text: string) => `https://placehold.co/800x800/png?text=${encodeURIComponent(text)}`;
  const samples = [
    {
      name: 'Carregador Anker 65W USB-C', sku: 'ANK-65W', category: 'carregadores', brand: 'anker',
      specs: [['Potência', '65', 'W'], ['Tipo de porta', 'USB-C'], ['Número de portas', '2'], ['Fast Charging', 'Sim']],
      variants: [{ sku: 'ANK-65W-BK', options: { color: 'Preto' }, originalPrice: 350_000, price: 299_000, qty: 40 }],
    },
    {
      name: 'iPhone 15 256GB', sku: 'APL-IP15', category: 'iphone', brand: 'apple',
      specs: [['RAM', '6', 'GB'], ['Armazenamento', '256', 'GB'], ['Ecrã', '6.1', 'polegadas'], ['5G', 'Sim'], ['Dual SIM', 'Sim']],
      variants: [
        { sku: 'APL-IP15-256-BK', options: { color: 'Preto', storage: '256GB' }, originalPrice: 7_500_000, price: 7_200_000, qty: 5 },
        { sku: 'APL-IP15-256-BL', options: { color: 'Azul', storage: '256GB' }, originalPrice: 7_500_000, price: 7_200_000, qty: 3 },
      ],
    },
    {
      name: 'Headphone JBL Tune 770NC', sku: 'JBL-770NC', category: 'headphones', brand: 'jbl',
      specs: [['Bluetooth', '5.3'], ['ANC', 'Sim'], ['Autonomia', '70', 'h'], ['Microfone', 'Sim']],
      variants: [
        { sku: 'JBL-770NC-BK', options: { color: 'Preto' }, originalPrice: 650_000, price: 590_000, qty: 12 },
        { sku: 'JBL-770NC-WH', options: { color: 'Branco' }, originalPrice: 650_000, price: 590_000, qty: 0 },
      ],
    },
  ];

  for (const s of samples) {
    if (await prisma.product.findUnique({ where: { sku: s.sku } })) continue;
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: s.category } });
    const brand = await prisma.brand.findUniqueOrThrow({ where: { slug: s.brand } });
    const product = await prisma.product.create({
      data: {
        name: s.name, slug: slugify(s.name), sku: s.sku, categoryId: category.id, brandId: brand.id,
        shortDescription: `${s.name} — produto de demonstração.`,
        description: `${s.name}. Produto criado pelo seed para desenvolvimento.`,
        status: ProductStatus.ACTIVE, publishedAt: new Date(), isFeatured: true, hasWarranty: true, warrantyMonths: 12,
        images: { create: [{ url: img(s.name), thumbnailUrl: img(s.name), storageKey: `seed/${s.sku}.png`, storageProvider: 'external', altText: s.name, isMain: true }] },
        specifications: { create: s.specs.map(([key, value, unit], i) => ({ key: key!, value: value!, unit, sortOrder: i, numericValue: Number(value) || undefined })) },
      },
    });
    for (const [i, v] of s.variants.entries()) {
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id, sku: v.sku, options: v.options, name: Object.values(v.options).join(' / '),
          originalPrice: v.originalPrice, price: v.price, isDefault: i === 0, sortOrder: i, weightGrams: 300,
          inventory: { create: { quantity: v.qty, minStock: 2 } },
        },
        include: { inventory: true },
      });
      if (v.qty > 0) {
        await prisma.inventoryMovement.create({
          data: { inventoryId: variant.inventory!.id, type: InventoryMovementType.INITIAL, quantity: v.qty, quantityBefore: 0, quantityAfter: v.qty, reason: 'Seed' },
        });
      }
    }
    await refreshProductAggregates(product.id);
  }
  console.log('✔ sample products');
}

async function main() {
  await seedRbac();
  await seedOwner();
  await seedCategories();
  await seedBrands();
  await seedShippingAndPayments();
  await seedStore();
  await seedSampleProducts();
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
