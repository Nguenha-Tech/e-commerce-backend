# Shopping — Backend

API de e-commerce de eletrónicos: **Node.js · TypeScript · Fastify · Zod · Prisma · PostgreSQL**,
JWT em cookies HTTP-only (ou Bearer para mobile), Argon2, Helmet/CORS/Rate limit, Pino, Vitest,
armazenamento de imagens abstrato (local ou Cloudinary) e Docker.

A arquitetura, o modelo de dados, as regras de negócio e as estratégias (auth, stock, pagamentos,
uploads, segurança e testes) estão em **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
A documentação interativa da API (OpenAPI/Swagger) fica em **`/docs`** fora de produção.

## Estrutura

```
src/
├── server.ts  ├── app.ts
├── config/  ├── plugins/
├── modules/  auth · users · products · categories · orders · uploads
├── db/  ├── utils/  └── types/
```

## Arranque rápido (local)

Requisitos: Node 20+, PostgreSQL 14+.

```bash
cp .env.example .env              # ajustar DATABASE_URL, JWT_SECRET, COOKIE_SECRET, OWNER_*
npm install
npx prisma generate
npx prisma migrate deploy         # cria o schema
npm run db:seed                   # roles, permissões, OWNER, categorias, marcas, métodos, exemplos
npm run dev                       # http://localhost:3333  ·  docs em /docs
```

Conta inicial: `OWNER_EMAIL` / `OWNER_PASSWORD` do `.env` (trocar a password no primeiro login).

## Docker

```bash
cp .env.example .env              # definir segredos
docker compose up -d --build      # db → migrate (prisma migrate deploy) → api
docker compose run --rm migrate npx tsx src/db/seed.ts   # seed (uma vez)
```

A imagem `runtime` corre como utilizador não-root, com `HEALTHCHECK` em `/health`.
Em produção: PostgreSQL gerido, segredos do orquestrador, `STORAGE_DRIVER=cloudinary` (ou outro
provider) e `COOKIE_SECURE=true` atrás de HTTPS.

## Testes

```bash
npm run test:unit                  # sem base de dados
npm run test:integration           # usa TEST_DATABASE_URL (nome tem de conter "test"; é recriada)
npm test                           # tudo
```

Os testes de integração cobrem compra simultânea, pagamento/pedido/webhook duplicados, cupão
expirado, stock insuficiente, acesso sem permissão e tentativa de elevação de privilégios.

## Scripts

| Script | Descrição |
|---|---|
| `npm run dev` | Servidor com reload |
| `npm run build` / `npm start` | Compilar para `dist/` e arrancar |
| `npm run typecheck` | Verificação de tipos |
| `npm run prisma:migrate` | Nova migração (desenvolvimento) |
| `npm run prisma:deploy` | Aplicar migrações (produção) |
| `npm run db:seed` | Dados base |

## Deploy na Vercel

O projeto corre na Vercel como função serverless: `api/index.ts` constrói a app Fastify uma vez
por instância e `vercel.json` reescreve todos os caminhos (`/api/v1/*`, `/health`, `/docs`) para ela.

Variáveis de ambiente a definir no projeto da Vercel (Settings → Environment Variables):

| Variável | Valor |
|---|---|
| `DATABASE_URL` | PostgreSQL acessível pela internet (Neon, Supabase, Railway…), **não** `localhost` |
| `JWT_SECRET`, `COOKIE_SECRET` | ≥ 32 caracteres cada (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) |
| `CORS_ORIGINS` | Origens do frontend, separadas por vírgula (ex.: `http://localhost:5173,https://loja.vercel.app`) |
| `FRONTEND_URL` | URL do frontend (links nos emails) |
| `API_URL` | `https://<projeto>.vercel.app` |
| `COOKIE_SAMESITE` | `none` quando frontend e API estão em domínios diferentes (exige HTTPS; `COOKIE_SECURE` fica `true` em produção) |
| `STORAGE_DRIVER` | `cloudinary` (+ `CLOUDINARY_*`). O disco da Vercel é efémero: com `local` os uploads perdem-se |
| `CRON_SECRET` | Segredo aleatório. Ativa `GET /api/v1/internal/cron` (expirar encomendas, sincronizar promoções), chamado pelo Vercel Cron |
| `EMAIL_PROVIDER` | `console` (único valor suportado) |

`NODE_ENV` passa a `production` automaticamente na Vercel. As migrações não correm no deploy:
aplique-as a partir da sua máquina com `DATABASE_URL=<url de produção> npm run prisma:deploy`
(e `npm run db:seed` na primeira vez).

Se a configuração estiver inválida, qualquer pedido devolve `500 SERVER_MISCONFIGURED` com a lista
das variáveis em falta (só nomes, nunca valores).

> O plano Hobby da Vercel só permite cron diário (`vercel.json` → `crons`). Encomendas por pagar
> expiram com esse atraso; em planos pagos, mude o `schedule` para `*/5 * * * *`.

## Variáveis de ambiente

Todas validadas no arranque (`src/config/env.ts`); ver `.env.example` com comentários.
Principais: `DATABASE_URL`, `JWT_SECRET`, `COOKIE_SECRET`, `API_URL`, `FRONTEND_URL`, `CORS_ORIGINS`,
`STORAGE_DRIVER` (+ `CLOUDINARY_*`), `EMAIL_PROVIDER`, `DEFAULT_CURRENCY`, `STORE_TIMEZONE`,
`TAX_RATE_PERCENT`, `TAX_INCLUDED_IN_PRICES`, `STOCK_RESERVATION_TTL_MINUTES`, `PAYMENT_MOCK_WEBHOOK_SECRET`.

Valores monetários são **inteiros em centavos** (ex.: `7500000` = 75.000 MZN).

## Convenções da API

- Prefixo `/api/v1`; administração em `/api/v1/admin/*` (sempre autenticação + permissão).
- Resposta: `{ success, message, data, meta? }`; erro: `{ success:false, message, errorCode, timestamp, path, requestId }`.
- Listagens paginadas: `?page=1&limit=20` (máx. 100).
- Operações críticas aceitam `Idempotency-Key` (criação de pedido, novas tentativas de pagamento, reembolsos).
- Web: cookies HTTP-only. Mobile: header `X-Client-Type: mobile` → tokens no corpo + `Authorization: Bearer`.
# e-commerce-backend
