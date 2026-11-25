# Arquitetura — Shopping Backend

Documento de referência produzido **antes** da implementação (secção 65 do enunciado).
Cobre arquitetura, módulos, entidades, fluxos, regras de negócio, permissões, endpoints
e as estratégias de autenticação, stock, pagamentos, uploads, segurança e testes.

---

## 1. Arquitetura geral

Monólito modular (modular monolith) em **Node.js + TypeScript + Fastify**, com **PostgreSQL**
via **Prisma 7** (cliente TypeScript + driver adapter `pg`, sem binários nativos).

```
                ┌──────────── Web / Mobile / Painel Admin ────────────┐
                                     │  HTTPS (JSON)
                       ┌─────────────▼──────────────┐
                       │  Fastify  /api/v1          │
                       │  helmet · cors · rate-limit│
                       │  request-id · pino logs    │
                       │  Zod (validação) · JWT     │
                       └─────────────┬──────────────┘
     ┌───────────┬───────────┬───────┴─────┬────────────┬───────────┐
   auth/      users/     categories/   products/      orders/     uploads/
     │           │           │       (catálogo,     (carrinho,     (storage
     │           │           │       marcas, var.,  checkout,      abstrato)
     │           │           │       inventário)    pagamentos)       │
     └───────────┴───────────┴───────┬─────┴────────────┴───────┬───┘
                               Prisma (src/db)            StorageProvider
                                     │                   (Local | Cloudinary | S3…)
                                PostgreSQL
```

Princípios:

- **Camadas por módulo**: `*.routes.ts` (HTTP + validação Zod + permissões) →
  `*.service.ts` (regras de negócio, transações) → Prisma. Rotas nunca contêm regras.
- **Separação público/admin**: `/api/v1/...` (público/cliente) e `/api/v1/admin/...`
  (sempre `authenticate` + `authorize(permissão)`).
- **Backend como autoridade**: preço, stock, cupões e estados são sempre recalculados
  no servidor; o frontend apenas apresenta.
- **Dinheiro em inteiros** (centavos) — sem `float` em valores monetários.
- **Independente do cliente**: cookies HTTP-only para web; `Authorization: Bearer` +
  refresh token no corpo para mobile (`X-Client-Type: mobile`).

### Estrutura de pastas (conforme pedido)

Segue exatamente a estrutura definida: seis módulos de topo. Os restantes domínios do enunciado
vivem **dentro** do módulo a que pertencem (subpastas quando crescem), sem criar novos módulos de topo.

```
src/
├── server.ts            # arranque + graceful shutdown
├── app.ts               # composição da app (plugins + rotas) — testável com inject()
├── config/              # env (Zod), permissões/roles
├── plugins/             # prisma, segurança, auth/RBAC, erros, swagger, storage, jobs
├── modules/
│   ├── auth/            # registo, login, sessões, refresh, password, verificação de email
│   ├── users/           # perfil, endereços, clientes, staff, roles/permissões (rbac.ts)
│   │                    # + wishlist e alertas de stock, notificações, consulta de auditoria
│   ├── products/        # produtos, variantes, specs, imagens, marcas, inventário, pesquisa
│   │   │                # + avaliações, perguntas, promoções
│   │   └── storefront/  # definições da loja, banners
│   │       └── whatsapp/  # Configuration · MessageBuilder · Analytics · Service (secção 72)
│   ├── categories/      # árvore de categorias
│   ├── orders/          # carrinho, pricing, cupões, entrega, checkout, pedidos
│   │   │                # + devoluções, cupões/métodos (admin), dashboard e relatórios
│   │   └── payments/    # PaymentProvider, providers, pagamentos, webhooks, reembolsos
│   └── uploads/         # StorageProvider (local/cloudinary), validação e processamento de imagens
├── db/                  # schema.prisma, migrations, client, seed
├── utils/               # erros, respostas, paginação, slug, crypto, auditoria, cache, mailer, notificações
└── types/               # augmentations do Fastify
```

Cada funcionalidade tem a forma `*.schemas.ts` (Zod) → `*.service.ts` (regras/transações) →
`*.routes.ts` (HTTP + permissões).

---

## 2. Módulos e responsabilidades

| Módulo | Responsabilidade | Depende de |
|---|---|---|
| **auth** | Registo, login/logout, refresh com rotação, recuperação/alteração de password, verificação de email, sessões, bloqueio por brute force | users (dados), orders/cart (merge) |
| **users** | Perfil, endereços, gestão de clientes, staff/admins, roles e permissões; **wishlist** e alertas "voltou ao stock"; **notificações** internas; consulta de **auditoria** | products (cartões) |
| **categories** | Árvore hierárquica, slugs, SEO, cache | — |
| **products** | Produtos, variantes, especificações, tags, imagens, marcas, relacionados, pesquisa/filtros/ordenação, **inventário** (movimentos), **avaliações**, **perguntas**, **promoções**; `storefront/`: definições da loja, **banners**, **WhatsApp** | categories, uploads |
| **orders** | Carrinho (visitante + merge), **pricing central**, cupões (+ CRUD admin), métodos de entrega/pagamento (admin), **checkout**, reserva de stock, máquina de estados, **pagamentos** (abstração + webhooks + **reembolsos**), **devoluções**, **dashboard e relatórios** | products |
| **uploads** | Abstração de armazenamento, validação/compressão/thumbnails | — |

---

## 3. Entidades e relacionamentos (resumo)

Modelo completo em `src/db/schema.prisma` (53 tabelas). Principais relações:

```mermaid
erDiagram
  USER ||--o{ USER_ROLE : has
  ROLE ||--o{ USER_ROLE : grants
  ROLE ||--o{ ROLE_PERMISSION : has
  PERMISSION ||--o{ ROLE_PERMISSION : in
  USER ||--o{ SESSION : opens
  USER ||--o{ ADDRESS : owns
  USER ||--o| CART : has
  USER ||--o| WISHLIST : has
  USER ||--o{ ORDER : places
  CATEGORY ||--o{ CATEGORY : parent_of
  CATEGORY ||--o{ PRODUCT : groups
  BRAND ||--o{ PRODUCT : makes
  PRODUCT ||--|{ PRODUCT_VARIANT : has
  PRODUCT ||--o{ PRODUCT_IMAGE : shows
  PRODUCT ||--o{ PRODUCT_SPECIFICATION : describes
  PRODUCT ||--o{ PRODUCT_TAG : tagged
  PRODUCT_VARIANT ||--|| INVENTORY : stocked_in
  INVENTORY ||--o{ INVENTORY_MOVEMENT : logs
  PRODUCT_VARIANT ||--o{ STOCK_RESERVATION : reserved_by
  CART ||--o{ CART_ITEM : contains
  ORDER ||--|{ ORDER_ITEM : snapshots
  ORDER ||--o{ ORDER_STATUS_HISTORY : tracks
  ORDER ||--o{ PAYMENT : paid_by
  PAYMENT ||--o{ PAYMENT_TRANSACTION : logs
  PAYMENT ||--o{ REFUND : refunded_by
  ORDER ||--o{ SHIPMENT : shipped_as
  SHIPMENT ||--o{ TRACKING_EVENT : logs
  COUPON ||--o{ COUPON_USAGE : used_in
  ORDER_ITEM ||--o| REVIEW : reviewed_by
  ORDER ||--o{ RETURN_REQUEST : returned_by
```

Decisões de modelação:

- **Todo o produto tem ≥ 1 variante.** Um produto "simples" tem uma variante `isDefault`.
  Preço, stock, peso e dimensões vivem na variante → uma única regra para tudo.
- **Inventário 1:1 com a variante**: `quantity` (em mão), `reserved`; `available = quantity − reserved`.
- **Especificações flexíveis** (`product_specifications`: grupo/chave/valor/unidade/valor numérico).
  `specification_templates` sugere campos por categoria sem os tornar obrigatórios.
- **Opções de variante em JSONB** (`{"color":"Preto","storage":"256GB"}`) com índice GIN.
- **Snapshots** em `order_items` (nome, SKU, variante, preço original e praticado, custo,
  desconto, imposto) e `orders.shippingAddress` (JSON) — o histórico nunca depende do catálogo.
- **Campos desnormalizados** em `products` (`minPrice`, `maxDiscountPercent`, `availableStock`,
  `soldCount`, `ratingAvg`…) para listagens rápidas; recalculados por `refreshProductAggregates`.
- **Soft delete** (`deletedAt`) em users, products, variants, categories, brands, coupons,
  promotions, banners, addresses.

---

## 4. Fluxos principais

### 4.1 Compra (secção 61)

```
Cliente → GET /products?search=… → GET /products/slug/:slug → escolhe variante
  → POST /cart/items {variantId, quantity}         (valida stock disponível)
  → GET /cart                                       (subtotal, descontos, cupão, total)
  → GET /shipping/methods?addressId=…               (opções e preços por região)
  → POST /checkout/quote                            (resumo calculado no servidor)
  → POST /orders  (Idempotency-Key)                 ┐
       valida produto/variante/preço/stock/cupão     │  1 transação
       reserva stock (UPDATE condicional)            │
       cria pedido + snapshots + pagamento PENDING   ┘
  → provider.initiate()  → nextAction (instruções / redirect / prompt mobile)
  → Webhook do gateway (assinatura HMAC, idempotente)
       → Payment PAID → consome reservas (stock sai) → Order CONFIRMED → notificação
  → Admin: PROCESSING → PACKED → SHIPPED (shipment + tracking) → OUT_FOR_DELIVERY → DELIVERED
```

### 4.2 Criação de produto (secção 62)

`POST /admin/products` (DRAFT por omissão, com variantes, specs, garantia, peso, SEO)
→ `POST /admin/products/:id/images` (upload) → `POST /admin/products/:id/publish`
(valida: categoria ativa, ≥ 1 variante ativa com preço > 0, ≥ 1 imagem) → `ACTIVE`.

### 4.3 Carrinho de visitante (secção 55)

Visitante sem sessão → cookie `cart_token` (aleatório, HTTP-only; na BD só o hash SHA-256)
→ login/registo → `mergeGuestCart` soma quantidades (limitadas ao stock) e apaga o carrinho temporário.

---

## 5. Regras de negócio

- **Preço efetivo da variante**: `promoPrice` se estiver dentro da janela `promoStartsAt..promoEndsAt`,
  senão a melhor promoção ativa aplicável (produto/categoria/marca/loja, maior prioridade),
  senão `price`. Nunca abaixo de 0.
- **Cálculo do total** (centralizado em `orders/pricing.ts`, função pura):
  `subtotal = Σ preçoEfetivo × qtd` → `− cupão` → `+ entrega` → `+ IVA` (se não incluído) `= total`.
  Com `TAX_INCLUDED_IN_PRICES=true` (padrão em Moçambique), o IVA é apenas discriminado.
- **Cupões**: ativo, dentro das datas, limite global e por cliente, compra mínima, produtos/categorias
  elegíveis; desconto distribuído proporcionalmente pelas linhas elegíveis (para snapshots e devoluções).
- **Stock**: nunca vender acima de `quantity − reserved`; a BD tem `CHECK` como última defesa.
- **Pedido**: preço gravado é o do momento; `Idempotency-Key` obrigatória; se o cliente enviar
  `expectedTotal` e o total mudou → `409 PRICE_CHANGED` (o cliente revê antes de pagar).
- **Estados do pedido** (transições válidas):

  | De | Para |
  |---|---|
  | PENDING | CONFIRMED, CANCELLED |
  | CONFIRMED | PROCESSING, CANCELLED |
  | PROCESSING | PACKED, CANCELLED |
  | PACKED | SHIPPED, CANCELLED |
  | SHIPPED | OUT_FOR_DELIVERY, DELIVERED |
  | OUT_FOR_DELIVERY | DELIVERED |
  | DELIVERED | RETURN_REQUESTED |
  | RETURN_REQUESTED | RETURNED, DELIVERED (devolução rejeitada) |
  | RETURNED | REFUNDED |
  | CANCELLED | REFUNDED |

  `PENDING → CONFIRMED` manual só com pagamento `PAID` ou método "pagamento na entrega".
  Cliente só cancela em `PENDING`/`CONFIRMED`.
- **Produtos descontinuados** deixam de aparecer no catálogo mas os pedidos mantêm os snapshots.
- **Avaliações**: só com `order_item` de pedido `DELIVERED` do próprio cliente (1 por produto).
  Publicação imediata ou moderação prévia (`settings.reviews.requireApproval`); 3 denúncias devolvem a
  avaliação à moderação; a média (`ratingAvg/ratingCount`) conta só avaliações `APPROVED`.
  Fotos: o cliente faz upload (`/reviews/images`) e envia apenas a `storageKey` — o URL é sempre
  derivado no servidor. O nome público é "Primeiro A." (privacidade).
- **Perguntas**: pendentes até moderação/resposta (`settings.questions.requireApproval`); o cliente é notificado da resposta.
- **Promoções** (sem código): % (1–95) ou valor fixo, por produto/categoria/marca/loja, com janela
  de datas e prioridade. Ao criar/editar e quando uma janela começa/acaba (job), os preços
  desnormalizados dos produtos afetados são recalculados.
- **Devoluções** (estados e transições):

  | De | Para |
  |---|---|
  | REQUESTED | UNDER_REVIEW, APPROVED, REJECTED, CANCELLED |
  | UNDER_REVIEW | APPROVED, REJECTED, CANCELLED |
  | APPROVED | RECEIVED, CANCELLED |
  | RECEIVED | REFUNDED |

  Só pedidos `DELIVERED`, dentro de `settings.returns.windowDays` (14 por omissão), com motivo da lista
  configurada, uma devolução aberta por pedido e quantidade ≤ comprada − já devolvida. O pedido acompanha
  (`RETURN_REQUESTED` → `RETURNED` → `REFUNDED`, ou volta a `DELIVERED` se rejeitada/cancelada).
  Na receção, cada artigo volta ao stock (`RETURN`) ou fica registado como não vendável.
  Estes estados do pedido **não** podem ser definidos manualmente (`USE_RETURNS_FLOW`).
- **Reembolsos**: nunca acima de `pago − reembolsado − reembolsos em aberto`; idempotentes (chave única);
  gateway com `refund()` → automático, caso contrário o admin regista a referência da devolução manual.
  Pagamento passa a `PARTIALLY_REFUNDED`/`REFUNDED`; pedido cancelado/devolvido passa a `REFUNDED`.

---

## 6. Roles e permissões

RBAC com tabelas `roles`, `permissions`, `user_roles`, `role_permissions`. Permissões são strings
`recurso:ação` (`src/config/permissions.ts`). Cada role tem `level` (CUSTOMER 0, ADMIN 50, OWNER 100).

| Permissão | ADMIN | OWNER |
|---|:-:|:-:|
| products:read/create/update/delete, categories:manage, brands:manage | ✓ | ✓ |
| inventory:read/manage | ✓ | ✓ |
| orders:read/manage, payments:read | ✓ | ✓ |
| customers:read/block | ✓ | ✓ |
| promotions/coupons/reviews/questions/banners/content:manage, uploads:create | ✓ | ✓ |
| dashboard:read, reports:read | ✓ | ✓ |
| payments:manage, refunds:manage | | ✓ |
| reports:financial (custos, margens, faturação) | | ✓ |
| customers:update_sensitive | | ✓ |
| admins:manage, roles:manage | | ✓ |
| settings:manage, payment_methods:manage, shipping_methods:manage, whatsapp:manage | | ✓ |
| audit:read | | ✓ |

**Anti-escalada de privilégios** (`users/rbac.ts`):
1. ninguém altera as próprias roles;
2. só se gere utilizadores com `level` inferior ao seu;
3. só se atribuem roles com `level` inferior ao seu (OWNER pode atribuir OWNER);
4. só se concedem permissões que o próprio possui;
5. roles de sistema não podem ser apagadas nem renomeadas.

Novas roles (ex.: `SUPPORT`, `WAREHOUSE`) criam-se via API sem alterar código.

---

## 7. Endpoints (v1)

Prefixo `/api/v1`. Documentação interativa em **`/docs`** (OpenAPI gerado a partir dos schemas Zod).

**Auth** — `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`,
`/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/resend-verification`,
`/auth/change-password`; `GET /auth/sessions`, `DELETE /auth/sessions/:id`.

**Utilizador** — `GET|PATCH /users/me`; `GET|POST /users/me/addresses`,
`PATCH|DELETE /users/me/addresses/:id`, `POST /users/me/addresses/:id/default`.

**Catálogo público** — `GET /products` (pesquisa, filtros, ordenação, paginação),
`/products/featured`, `/products/on-sale`, `/products/best-sellers`, `/products/:id`,
`/products/slug/:slug`, `/products/:id/related?type=`; `GET /categories` (árvore),
`/categories/:slug`; `GET /brands`, `/brands/:slug`.

**Carrinho / checkout / pedidos** — `GET /cart`, `POST /cart/items`, `PATCH|DELETE /cart/items/:id`,
`DELETE /cart`, `POST|DELETE /cart/coupon`; `GET /shipping/methods`; `GET /payments/methods`;
`POST /checkout/quote`; `POST /orders`; `GET /orders`, `/orders/:id`; `POST /orders/:id/cancel`;
`POST /orders/:id/payments` (nova tentativa); `POST /payments/webhooks/:provider`.

**Admin** — `/admin/products` (CRUD, `/publish`, `/status`, `/images`, `/variants`, `/relations`),
`/admin/variants/:id`, `/admin/brands`, `/admin/categories`, `/admin/inventory` (+ movimentos),
`/admin/orders` (lista, detalhe, `/status`, confirmar pagamento), `/admin/customers`
(lista, detalhe, bloquear/desbloquear), `/admin/staff`, `/admin/roles`, `/admin/permissions`,
`/admin/uploads/images`.

**Favoritos e notificações** — `GET /wishlist`, `/wishlist/ids`, `POST /wishlist/items`,
`DELETE /wishlist/items/:productId`, `DELETE /wishlist`; `GET|POST /wishlist/stock-alerts`,
`DELETE /wishlist/stock-alerts/:variantId`; `GET /notifications`, `/notifications/unread-count`,
`POST /notifications/:id/read`, `/notifications/read-all`, `DELETE /notifications/:id`.

**Avaliações e perguntas** — `GET /products/:id/reviews` (resumo + distribuição), `POST /products/:id/reviews`,
`POST /reviews/images`, `GET /reviews/me`, `/reviews/eligible`, `PATCH|DELETE /reviews/:id`,
`POST /reviews/:id/report`; `GET|POST /products/:id/questions`, `GET /questions/me`, `DELETE /questions/:id`.

**Promoções e conteúdo** — `GET /promotions`, `/promotions/:slug`; `GET /banners?placement=`;
`GET /store/settings`; `GET /whatsapp/config`, `POST /whatsapp/link`.

**Devoluções** — `POST /orders/:id/returns`, `POST /returns/evidence`, `GET /returns`, `/returns/:id`,
`POST /returns/:id/cancel`.

**Admin (cont.)** — `/admin/reviews` (status, reply), `/admin/questions` (answer, status),
`/admin/promotions` (CRUD), `/admin/coupons` (CRUD, `/usages`), `/admin/banners` (CRUD),
`/admin/settings/:key`, `/admin/whatsapp` (+ `/analytics`), `/admin/shipping-methods` (+ `/rates`),
`/admin/shipping-rates/:id`, `/admin/payment-methods`, `/admin/returns` (`/review`, `/approve`, `/reject`,
`/receive`, `/refund`, `/cancel`), `/admin/refunds` (`/process`, `/fail`), `/admin/payments/:id/refunds`,
`/admin/dashboard`, `/admin/reports/{sales,products,stock,customers,orders,discounts,returns,revenue,payments}`
(`?period=day|week|month|year&from=&to=`), `/admin/audit-logs` (+ `/actions`, `/:id`),
`/admin/customers/:id/wishlist`.

**Operação** — `GET /health` (liveness), `GET /health/ready` (BD).

### Formato de resposta

```json
{ "success": true, "message": "Product created successfully", "data": {}, "meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 } }
{ "success": false, "message": "Product not found", "errorCode": "PRODUCT_NOT_FOUND", "timestamp": "…", "path": "/api/v1/products/…", "requestId": "…" }
```

---

## 8. Estratégia de autenticação

- **Access token JWT** (15 min) com `sub` (utilizador) e `sid` (sessão), em cookie
  `access_token` HTTP-only (`SameSite` configurável, `Secure` em produção) **ou** `Authorization: Bearer`.
- **Refresh token opaco** (48 bytes aleatórios), guardado **só como hash SHA-256** em `sessions`,
  cookie `refresh_token` com `path=/api/v1/auth`. **Rotação a cada uso**; o hash anterior fica em
  `previousTokenHash` — se for reapresentado (roubo), a sessão é revogada (`REFRESH_TOKEN_REUSED`).
- Em cada pedido autenticado a sessão é validada (não revogada/expirada) e as permissões carregadas
  da BD → logout, bloqueio e mudança de permissões têm efeito **imediato**.
- **Argon2id** para passwords; utilizador inexistente também paga um verify (timing uniforme).
- **Brute force**: rate limit estrito nas rotas de auth + bloqueio progressivo após 5 falhas
  (15 min, duplicando até 24 h).
- Recuperação de password e verificação de email com tokens de uso único (hash na BD, expiram);
  `forgot-password` responde sempre igual (sem enumeração de contas); reset revoga todas as sessões.

## 9. Estratégia de stock

- `UPDATE inventory SET reserved = reserved + q WHERE "variantId" = $1 AND quantity - reserved >= q`
  — **atómico**, sem janela de corrida: com stock 1 e dois clientes simultâneos, só um UPDATE afeta 1 linha.
- Linhas ordenadas por `variantId` dentro da transação → sem deadlocks entre pedidos.
- Reserva com expiração (`STOCK_RESERVATION_TTL_MINUTES`); job periódico expira reservas e cancela
  pedidos não pagos (com `SELECT … FOR UPDATE` no pedido para não colidir com o webhook).
- Pagamento confirmado → `quantity -= q, reserved -= q` + movimento `SALE`.
  Pagamento na entrega → stock consumido logo na criação do pedido.
- Cancelamento → liberta reserva, ou repõe stock (`CANCELLATION_RESTOCK`) se já consumido.
- Cada alteração de `quantity` gera `inventory_movements` (antes/depois/motivo/autor/referência)
  e ajustes manuais geram também `audit_logs`.

## 10. Estratégia de pagamentos

- Interface `PaymentProvider` (`initiate`, `parseWebhook`) e registo por código.
  Incluídos: `cod` (pagamento na entrega), `manual` (transferência — confirmação pelo admin) e
  `mock` (gateway simulado com webhook HMAC, para desenvolvimento/testes).
  M-Pesa, e-Mola, cartões (Stripe, etc.) entram como novos providers sem tocar no checkout.
- `payment_methods` (configurável pelo OWNER) liga um método comercial a um provider.
- **Nunca confiar no frontend**: o pagamento só passa a `PAID` via webhook verificado
  (assinatura HMAC + comparação em tempo constante + validação de valor/moeda) ou confirmação
  manual de um utilizador com `payments:manage` (auditada).
- **Idempotência**: `webhook_events (provider, eventId)` único; `payments.idempotencyKey` único;
  `markPaid` bloqueia a linha do pagamento e não faz nada se já estiver `PAID`.
- Pagamento recebido para pedido já cancelado → pedido marcado `requiresAttention` + `refund` PENDING.
- **Reembolsos**: `PaymentProvider.refund()` opcional. Com ele (ex.: `mock`), o reembolso é pedido ao
  gateway; sem ele (`cod`, `manual`), o financeiro devolve o dinheiro fora do sistema e regista a referência.
  Cada reembolso gera `payment_transactions (REFUND)` e auditoria.

## 11. Estratégia de uploads

- `StorageProvider` (`upload`, `delete`, `publicUrl`) com `LocalStorageProvider` e
  `CloudinaryStorageProvider`; S3/R2/GCS implementam a mesma interface. Seleção por `STORAGE_DRIVER`.
- Validação: tamanho (limite no multipart), extensão e MIME declarados numa allowlist **e**
  formato real detetado pelos bytes (sharp); limite de píxeis (anti decompression bomb).
- Re-codificação para **WebP** (remove EXIF/GPS, comprime, máx. 2000 px) + thumbnail 400 px.
- Nome gerado pelo servidor (`<pasta>/<aaaa>/<mm>/<uuid>.webp`); o nome original nunca é usado;
  o provider local verifica que o caminho final fica dentro da raiz (anti path traversal).
- Na BD só metadados: URL, chave, provider, dimensões, tamanho, alt text, ordem, variante.

## 12. Estratégia de segurança

- Helmet (headers), CORS com allowlist e `credentials`, rate limit global + estrito em auth.
- Validação Zod em **todas** as entradas (body, query, params, headers relevantes).
- Erros sem stack trace nem detalhes internos em produção; `requestId` em todas as respostas.
- Pino com `redact` para `authorization`, `cookie`, `set-cookie`, `password`, `token`, `refreshToken`.
- Segredos só por variáveis de ambiente (validadas no arranque; a app não arranca sem elas).
- Auditoria (`audit_logs`) de ações administrativas com antes/depois, IP, user-agent e requestId.
- Admin não vê nem altera dados sensíveis sem `customers:update_sensitive`; `passwordHash` nunca é selecionado.
- WhatsApp: número e mensagens configurados no backend (`whatsapp_configs`), alteração auditada;
  cliques guardam só metadados (`whatsapp_click_events`), nunca conversas.

## 13. Estratégia de testes

Vitest com dois projetos (`vitest.config.ts`):

- **unit** (`tests/unit`, sem BD): pricing e preço efetivo, máquina de estados do pedido, transições
  de devolução e valor de reembolso, RBAC anti-escalada, WhatsApp (mensagens, número, horário).
- **integration** (`tests/integration`, PostgreSQL real em `TEST_DATABASE_URL`): a BD é recriada a
  partir das migrações e semeada antes de cada execução; a app é exercitada com `app.inject()`.
  - `checkout.test.ts` — **compra simultânea** (stock 1, dois clientes; e 10 clientes para stock 3),
    **stock insuficiente**, **pedido duplicado** (mesma Idempotency-Key em paralelo), **cupão expirado**,
    limite por cliente, preço congelado no pedido, **webhook duplicado**, **pagamento duplicado**,
    assinatura inválida, valor divergente.
  - `security.test.ts` — 401 sem sessão, **acesso sem permissão** (403), ADMIN sem dados financeiros,
    **ADMIN a tentar elevar as próprias permissões**, auditoria com antes/depois, formato de erro.
  - `post-purchase.test.ts` — avaliação só após entrega, moderação, perguntas, devolução completa com
    reposição de stock e reembolso, reembolso idempotente e limitado ao pago, prazo de devolução, favoritos
    e alerta de stock.
  - `storefront.test.ts` — promoções (preço e Flash Sale), banners por datas, WhatsApp, relatórios.

```bash
npm test                    # tudo
npm run test:unit           # sem base de dados
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/electro_shop_test npm run test:integration
```

A BD de integração tem de ter "test" no nome — o setup recusa-se a apagar outra base de dados.

## 14. Roadmap incremental

| # | Incremento | Estado |
|---|---|---|
| 1–3 | Authentication, Users, Roles & Permissions | ✅ |
| 4–5 | Categories, Brands | ✅ |
| 6–8 | Products, Variants, Inventory | ✅ |
| 9–10 | Cart (visitante + merge), Wishlist + alertas de stock | ✅ |
| 11–14 | Checkout, Orders, Payments (abstração, webhooks, reembolsos), Shipping (métodos/tarifas/admin) | ✅ |
| 15 | Coupons & Promotions (validação + CRUD admin + job de janelas) | ✅ |
| 16 | Reviews, Q&A (moderação, denúncias, respostas) | ✅ |
| 17 | Notifications (in-app + email; SMS/push entram em `utils/notifications.ts`) | ✅ |
| 18 | Administration: banners, definições da loja, WhatsApp, devoluções | ✅ |
| 19 | Dashboard e relatórios (financeiros só para OWNER) | ✅ |
| 20 | Audit logs (gravação + consulta) | ✅ |

**Próximos passos sugeridos**: provider real de pagamento (M-Pesa / e-Mola / cartões) implementando
`PaymentProvider`; provider de email real (`EMAIL_PROVIDER`); Redis para cache/rate-limit com várias
instâncias; fila (BullMQ/pg-boss) para jobs e notificações; exportação CSV dos relatórios.
