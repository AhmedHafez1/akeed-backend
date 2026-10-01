# Public Experience And Growth Surface

Last updated: 2026-05-28

## Purpose

This document explains the public-facing pages, marketing site, localization system, SEO infrastructure, analytics, and growth surfaces in the Akeed frontend. It covers the marketing homepage, legal pages, pricing display, the i18n bilingual system (Arabic/English with RTL), structured data, the Shopify app listing configuration (for Shopify merchants), and conversion elements. The public site presents Akeed as COD confirmation infrastructure for both Shopify stores and independent stores, and merchant help articles live in `akeed-frontend/content/docs`.

For merchant-facing operational screens, see `MERCHANT_OPERATIONS.md`.
For onboarding and billing, see `ONBOARDING_AND_BILLING.md`.
For authentication and identity, see `IDENTITY_ACCESS_AND_ORGANIZATION.md`.

## Scope

In scope:

- Marketing homepage structure and sections.
- Pricing: standalone credits and the Shopify plan pointer.
- Legal pages (Terms of Service, Privacy Policy, Support).
- SEO: sitemap, robots.txt, metadata, OpenGraph, JSON-LD structured data.
- Localization: Arabic/English, RTL support, translation namespaces.
- Analytics: Facebook Pixel, Google Analytics.
- Navigation: Header, Footer, mobile CTA.
- Public assets: logos, favicons, OG images.
- Shopify app listing and extension configuration.
- Acquisition paths (Shopify vs own store) and the credit pricing section.
- Message template preview component.

Out of scope:

- Dashboard and settings UI (see `MERCHANT_OPERATIONS.md`).
- Authentication flows (see `IDENTITY_ACCESS_AND_ORGANIZATION.md`).
- Onboarding wizard (see `ONBOARDING_AND_BILLING.md`).

## Route Structure

### Public Routes

All routes are locale-prefixed (`/ar/...`, `/en/...`).

| Route      | Page               | Layout          | SEO indexed |
| ---------- | ------------------ | --------------- | ----------- |
| `/`        | Landing / Homepage | Header + Footer | Yes         |
| `/privacy` | Privacy Policy     | Header + Footer | Yes         |
| `/terms`   | Terms of Service   | Header + Footer | Yes         |
| `/support` | Support            | Header + Footer | Yes         |

### Auth Routes

| Route              | Page              | Layout         | SEO indexed |
| ------------------ | ----------------- | -------------- | ----------- |
| `/login`           | Login             | Auth (minimal) | No          |
| `/signup`          | Signup            | Auth (minimal) | No          |
| `/forgot-password` | Password recovery | Auth (minimal) | No          |
| `/reset-password`  | Password reset    | Auth (minimal) | No          |

### Protected Routes (not public)

| Route                  | Page                  |
| ---------------------- | --------------------- |
| `/dashboard`           | Merchant dashboard    |
| `/settings`            | Merchant settings     |
| `/verifications`       | Verification tracking |
| `/onboarding`          | Onboarding wizard     |
| `/message-preview`     | Template preview      |
| `/automation-settings` | Automation config     |

### Mode-Aware Landing Page

The root page (`/`) is mode-aware:

- **Standalone mode:** Renders the marketing homepage.
- **Embedded mode:** Redirects to the merchant dashboard.

## Marketing Homepage

The homepage is rendered by `HomePage.tsx` and composed of sequential sections. It presents Akeed as COD confirmation infrastructure for two kinds of merchant: Shopify stores, and independent stores that add their own orders.

### Sections

| Order | Section    | Purpose                                                                              |
| ----- | ---------- | ------------------------------------------------------------------------------------ |
| 1     | Hero       | Value proposition, the "Get started free" CTA and the order-to-confirmation flow.    |
| 2     | Trust      | Official WhatsApp, Shopify App Store listing, independent stores, Arabic first.      |
| 3     | HowItWorks | Three steps, with a tab for **Shopify store** and one for **Own store**.             |
| 4     | Pricing    | Pay-per-use credits for independent stores, with a pointer to Shopify plans.         |
| 5     | WhoItsFor  | Shopify, own store or site, manual orders, and mostly-COD merchants.                 |
| 6     | FAQ        | Common questions in accordion format.                                                |

`StickyMobileCta` adds a persistent CTA bar on mobile viewports. `ChatInterface` is the live WhatsApp demo.

### Hero Section

Copy lives in the `hero` namespace of `en.json` and `ar.json`.

- **Headline:** "Confirm COD orders before you ship." / "أكّد طلبات الدفع عند الاستلام قبل ما تشحن."
- **Primary CTA:** "Get started free" / "ابدأ مجانًا". The secondary CTA is "See how it works".
- **Microcopy:** "30 free messages" and "No credit card required". The 30 comes from `CREDIT_FREE_GRANT` (see Pricing) and the `hero.microcopy_credits` string is written to match it.
- **Integrations line:** "Works with your store" with Shopify, Independent stores and "+ more integrations".
- **Value points:** reduce returns, save on shipping costs, official WhatsApp API, built for every merchant.

There is no waitlist counter or limited-offer banner in the current page. This document previously listed "85+ MENA merchants on the waitlist" and "first 20 stores get 50 free confirmations", but neither exists in the app or its translations, so they were removed here. Do not add claims like these without a verified source.

### How It Works

Two tabs, chosen by the acquisition path (`?path=`):

1. **Shopify store:** install Akeed on Shopify, Akeed sends the confirmation automatically, ship only verified COD orders.
2. **Own store:** create an account and verify your email (activated at once with free launch credits, no card), add your orders (create them in Akeed or import a file), then send and track replies.

### Who It Is For

Shopify store owners (install from Shopify), owners of their own store or site, merchants who take orders manually (Instagram, WhatsApp, phone), and merchants whose volume is mostly cash on delivery. Independent stores are self-serve.

## Pricing

Pricing differs by mode.

### Independent stores: prepaid credits

No monthly subscription. Credits are bought through Paymob. One credit is one WhatsApp message sent to a customer, a follow-up costs a second credit, and a send that WhatsApp does not accept is refunded automatically.

| Item | Value (defaults) | Source |
| ---- | ---------------- | ------ |
| Price per credit | EGP 2.00 (`CREDIT_UNIT_PRICE_MINOR` = 200 piastres) | `STANDALONE_CREDIT_PRICE_MINOR` |
| Free launch credits on sign-up | 30 (one-time) | `STANDALONE_FREE_GRANT` |
| Purchase range | 100 to 5,000 credits, in steps of 50 | `STANDALONE_PURCHASE_MIN` / `MAX` / `STEP` |
| Quick presets | 100, 250, 500, 1,000 | `CREDIT_PRESETS` |

The public page cannot call the authenticated billing API, so it mirrors these values in `shared/config/pricing.ts`, overridable through `NEXT_PUBLIC_CREDIT_UNIT_PRICE_MINOR`, `NEXT_PUBLIC_CREDIT_FREE_GRANT` and the other `NEXT_PUBLIC_CREDIT_*` variables. Whenever the backend values change, change them in both repos. The page states that the price on the billing page is the authoritative one. The pricing section is made of `CreditPriceCard`, `CreditSlider` (credits to total and order estimate) and `PricingFactsPanel`.

### Shopify: monthly plans

Shopify merchants subscribe to a plan billed by Shopify, and the page links to the plans instead of repeating them (a copy once drifted from the backend). The authoritative plan definitions are in `ONBOARDING_AND_BILLING.md` (Starter 30 one-time, Basic 300, Pro 1,000, Scale 2,500 per month).

## Legal Pages

All legal pages use the shared `LegalDocumentPage` component, which renders:

- Eyebrow section indicator.
- Title and "last updated" date.
- Company attribution line.
- Introduction text.
- Five article sections.
- Navigation links to related legal pages.
- RTL support for Arabic.

### Privacy Policy

Last updated: March 2026.

Five sections:

1. **Data Collection** — Account, store, and usage data.
2. **Data Usage** — Service delivery, platform improvement. No selling to third parties.
3. **Data Retention** — Active account duration. Deletion on request.
4. **Security** — Encryption, industry-standard practices.
5. **Contact** — support@getakeed.com.

### Terms of Service

Last updated: March 2026.

Five sections:

1. **Service Description** — Automated WhatsApp COD order verification.
2. **User Obligations** — Account security responsibility.
3. **Data Usage** — Order/customer data processing only.
4. **Limitation of Liability** — As-is service, no guarantees.
5. **Terms Modification** — Right to update at any time.

### Support Page

Contact channels:

- **Email:** support@getakeed.com
- **WhatsApp:** Direct messaging support.

Includes `ContactPoint` JSON-LD schema markup for structured data.

## SEO Infrastructure

### Metadata

Configured in the root locale layout (`app/[locale]/layout.tsx`):

| Property            | Value                                          |
| ------------------- | ---------------------------------------------- | ------ |
| `applicationName`   | Akeed                                          |
| `creator`           | Akeed                                          |
| `publisher`         | Akeed                                          |
| Title template      | `%s                                            | Akeed` |
| Default description | From `metadata.description` translation key.   |
| Favicon             | `/favicon.ico`                                 |
| App icon            | `/images/akeed-web-app-icon-512.png` (512×512) |
| Apple icon          | `/images/akeed-web-app-icon-512.png` (512×512) |
| OG image            | `/images/akeed-app-icon-1200.png` (1200×1200)  |
| OG type             | `website`                                      |
| OG locale           | `ar_AR` or `en_US` (based on route locale)     |
| Twitter card        | `summary_large_image`                          |

### Fonts

| Font  | Script | Usage                    |
| ----- | ------ | ------------------------ |
| Cairo | Arabic | Arabic text, RTL layout  |
| Inter | Latin  | English text, LTR layout |

Font selection is dynamic based on the current locale.

### Sitemap (`/sitemap.xml`)

Generated by `app/sitemap.ts`.

| Route      | Changefreq | Priority | Languages |
| ---------- | ---------- | -------- | --------- |
| `/`        | weekly     | 1.0      | ar, en    |
| `/support` | monthly    | 0.7      | ar, en    |
| `/privacy` | monthly    | 0.7      | ar, en    |
| `/terms`   | monthly    | 0.7      | ar, en    |

Each entry includes `hreflang` alternates for both languages.

### Robots.txt

Generated by `app/robots.ts`.

Disallowed paths:

- `/api/*`
- `/webhooks/*`
- All private routes: `/dashboard`, `/settings`, `/onboarding`, `/verifications`, `/automation-settings`, `/message-preview`
- Auth routes: `/login`, `/signup`, `/forgot-password`, `/reset-password`

Sitemap URL: `{siteOrigin}/sitemap.xml`.

### Structured Data (JSON-LD)

**Organization schema** (from `shared/lib/seo.ts`):

| Field          | Value                              |
| -------------- | ---------------------------------- |
| `@type`        | Organization                       |
| `name`         | Akeed                              |
| `legalName`    | Akeed Digital Solutions            |
| `taxID`        | 5813 (Commercial Registration)     |
| `email`        | support@getakeed.com               |
| `address`      | Giza, Egypt                        |
| `contactPoint` | Arabic + English, customer service |
| `sameAs`       | Facebook, YouTube                  |

Additional schemas rendered on specific pages:

- **Homepage:** `SoftwareApplication`, `FAQPage`.
- **Support:** `ContactPage`, `ContactPoint`.

### Canonical URLs

`createPublicPageMetadata()` generates:

- Canonical URL for the current locale.
- Language alternates (`x-default`, `ar`, `en`).
- OpenGraph locale and alternate locales.

## Localization System

### Configuration

| Setting        | Value                         |
| -------------- | ----------------------------- |
| Locales        | `['en', 'ar']`                |
| Default locale | `ar` (Arabic)                 |
| Locale prefix  | Always (e.g., `/ar/`, `/en/`) |
| Library        | `next-intl`                   |

### Middleware

`proxy.ts` configures the `next-intl` middleware:

- All routes are locale-prefixed.
- Matcher excludes: `api`, `webhooks`, `_next`, static assets.

### Translation Files

Located at `public/messages/{locale}.json`.

| File      | Content          |
| --------- | ---------------- |
| `ar.json` | Complete Arabic  |
| `en.json` | Complete English |

### Translation Namespaces

| Namespace         | Coverage                             |
| ----------------- | ------------------------------------ |
| `metadata`        | Page titles, meta descriptions.      |
| `header`          | Navigation links, CTAs.              |
| `hero`            | Hero section copy.                   |
| `demo`            | Live demo chat interface.            |
| `how_it_works`    | Process steps.                       |
| `trust`           | Trust section.                       |
| `who_its_for`     | Audience cards.                      |
| `pricing_credits` | Credit pricing section.              |
| `faq`             | FAQ questions and answers.           |
| `whatsapp_button` | WhatsApp CTA button copy.            |
| `mobile_cta`      | Mobile sticky CTA.                   |
| `auth`            | Login, signup, password reset forms. |
| `legal`           | Terms, privacy content.              |
| `footer`          | Footer navigation and links.         |
| `support`         | Support page content.                |
| `embeddedSupport` | Support in Shopify embedded app.     |
| `appHeader`       | Dashboard header.                    |
| `common`          | Shared strings.                      |
| `onboarding`      | Onboarding wizard flow.              |
| `dashboard`       | Dashboard and analytics.             |
| `settings`        | Settings page.                       |

### RTL Support

- Arabic (`ar`): `dir="rtl"`, Cairo font.
- English (`en`): `dir="ltr"`, Inter font.
- Set on the `<html>` element in the root layout.
- All components use directional-aware Tailwind classes.
- `LegalDocumentPage` explicitly handles RTL text alignment.

### Language Switching

The header includes a language toggle that switches between Arabic and English. The toggle preserves the current path and swaps the locale prefix.

## Analytics

### Marketing Scripts

Loaded by `MarketingScripts.tsx`. Scripts are conditionally rendered only in standalone mode — never inside the Shopify Admin iframe.

| Platform         | ID                 | Events tracked |
| ---------------- | ------------------ | -------------- |
| Facebook Pixel   | `2079384036148209` | `PageView`     |
| Google Analytics | `G-J7EM70ZQS0`     | Page views     |

**Why standalone only:** Avoids unnecessary tracking inside the Shopify Admin, prevents CSP conflicts with the Shopify iframe sandbox, and reduces network overhead for embedded merchants.

## Navigation

### Header

Fixed header with scroll-aware styling (blur backdrop on scroll).

Desktop navigation items:

| Label    | Target      | Type          |
| -------- | ----------- | ------------- |
| Features | `#solution` | Anchor scroll |
| Pricing  | `#pricing`  | Anchor scroll |
| Demo     | `#demo`     | Anchor scroll |
| FAQ      | `#faq`      | Anchor scroll |

Mobile navigation adds:

| Label   | Target   |
| ------- | -------- |
| Home    | `/`      |
| Sign In | `/login` |

Primary CTA button: "Install on Shopify" → links to Shopify App Store.

Language selector: Arabic ↔ English toggle.

### Footer

Structure:

- Logo and legal company attribution.
- Social media links.
- Three link groups: Navigation, Support, Legal.
- Copyright with dynamic year.

Social media:

| Platform  | URL                                                      |
| --------- | -------------------------------------------------------- |
| Facebook  | `https://www.facebook.com/profile.php?id=61585900432277` |
| YouTube   | `https://www.youtube.com/@akeed-digital`                 |
| Instagram | `https://www.instagram.com/akeed_app`                    |

Footer link groups:

| Group      | Links                                      |
| ---------- | ------------------------------------------ |
| Navigation | Home, Features, Pricing                    |
| Support    | Help Center, Contact Us, Community         |
| Legal      | Privacy Policy, Terms of Service, Security |

## Public Assets

### Images

| File                                   | Size      | Purpose                    |
| -------------------------------------- | --------- | -------------------------- |
| `akeed-web-logo-horizontal.png`        | —         | Header logo (light bg)     |
| `akeed-web-logo-horizontal-white.png`  | —         | Footer logo (dark bg)      |
| `akeed-web-app-icon-512.png`           | 512×512   | App icon, Apple icon       |
| `akeed-app-icon-1200.png`              | 1200×1200 | OpenGraph / social sharing |
| `akeed-social-profile-circle-1080.png` | 1080×1080 | Social media profile       |
| `landing/1.jpg` – `landing/5.jpg`      | —         | Feature/demo screenshots   |
| `landing/wa_chat_bg.png`               | —         | WhatsApp chat background   |
| `landing/logos/shopify_icon_1.png`     | —         | Shopify platform badge     |
| `landing/logos/wa_icon_1.png`          | —         | WhatsApp platform badge    |

### Favicon

`/favicon.ico` at the public root.

## Shopify App Configuration

### App Manifest (`shopify.app.toml`)

| Field           | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| `client_id`     | `f1f4012b31f1bb37c897ee284a501623`                           |
| `name`          | Akeed                                                        |
| `embedded`      | `true`                                                       |
| API version     | `2026-01`                                                    |
| Application URL | `http://localhost:3001` (dev)                                |
| Auth redirect   | `https://get-akeed-dev.vercel.app/api/auth/shopify/callback` |

### Access Scopes

| Scope               | Purpose                         |
| ------------------- | ------------------------------- |
| `read_customers`    | Customer data for verification. |
| `write_order_edits` | Order modifications.            |
| `read_orders`       | Order data for COD detection.   |
| `write_orders`      | Order cancellation and tagging. |
| `read_products`     | Product data (future use).      |

### Registered Webhooks

| Topic                      | Endpoint                                     |
| -------------------------- | -------------------------------------------- |
| `app_subscriptions/update` | `/webhooks/shopify/app-subscriptions/update` |
| `orders/create`            | `/webhooks/shopify/orders-create`            |
| `app/uninstalled`          | `/webhooks/shopify/uninstalled`              |
| `customers/data_request`   | `/webhooks/shopify/customers/data_request`   |
| `customers/redact`         | `/webhooks/shopify/customers/redact`         |
| `shop/redact`              | `/webhooks/shopify/shop/redact`              |

### Web Config (`shopify.web.toml`)

| Field       | Value                                        |
| ----------- | -------------------------------------------- |
| `name`      | `frontend`                                   |
| `roles`     | `["frontend"]`                               |
| Dev command | `node ./node_modules/next/dist/bin/next dev` |

## Message Template Preview

The `features/message-preview/` feature provides a WhatsApp template preview component used in both the settings page (Message Preview tab) and the marketing site.

Exports:

| Export                                    | Purpose                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `VerificationTemplatePreview`             | React component rendering a WhatsApp message preview.  |
| `getTemplateContent()`                    | Returns template strings for a given language/variant. |
| `renderTemplateBody()`                    | Interpolates order data into template body.            |
| `sampleData`                              | Sample order data for preview rendering.               |
| `TemplateLanguage`, `TemplatePreviewData` | TypeScript types.                                      |

## Company Information

| Field                   | Value                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Site name               | Akeed                                                                                    |
| Legal entity            | Akeed Digital Solutions                                                                  |
| Commercial Registration | 5813 (Egypt)                                                                             |
| Address                 | Apartment 13, third floor, plot 473, Area A, Hadabet Al Ahram III, Al Haram, Giza, Egypt |
| Support email           | support@getakeed.com                                                                     |

## Frontend Code Map

| Area                 | File                                                          | Responsibility                                       |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Marketing homepage   | `features/marketing/ui/HomePage.tsx`                          | Composes all homepage sections.                      |
| Hero section         | `features/marketing/ui/sections/Hero.tsx`                     | Value proposition, badges, primary CTA.              |
| Trust section        | `features/marketing/ui/sections/Trust.tsx`                    | Trust points.                                        |
| How it works         | `features/marketing/ui/sections/HowItWorks.tsx`               | Three steps, Shopify and own-store tabs.             |
| Pricing section      | `features/marketing/ui/sections/Pricing.tsx`                  | Credit price card, slider and facts panel.           |
| Who it is for        | `features/marketing/ui/sections/WhoItsFor.tsx`                | Audience cards.                                      |
| FAQ section          | `features/marketing/ui/sections/FAQ.tsx`                      | Accordion FAQ.                                       |
| Chat demo            | `features/marketing/ui/components/ChatInterface.tsx`          | Live WhatsApp chat simulation.                       |
| Mobile CTA           | `features/marketing/ui/components/StickyMobileCta.tsx`        | Sticky CTA bar for mobile.                           |
| Landing primitives   | `features/marketing/ui/components/LandingPrimitives.tsx`      | Reusable section/card primitives.                    |
| Site config          | `features/marketing/config/site.ts`                           | How-it-works steps, audiences, trust points, FAQs.   |
| Credit pricing       | `shared/config/pricing.ts`                                    | Price, free grant and purchase range for the public page. |
| Message preview      | `features/message-preview/ui/VerificationTemplatePreview.tsx` | WhatsApp template preview component.                 |
| Template content     | `features/message-preview/lib/templatePreviewContent.ts`      | Template strings and interpolation.                  |
| Header               | `shared/layout/Header.tsx`                                    | Public navigation header.                            |
| Header hook          | `shared/layout/header/useHeader.ts`                           | Navigation items, scroll state.                      |
| Header nav           | `shared/layout/header/HeaderNav.tsx`                          | Desktop/mobile navigation links.                     |
| Header actions       | `shared/layout/header/HeaderActions.tsx`                      | CTA button, language toggle.                         |
| Footer               | `shared/layout/Footer.tsx`                                    | Links, social media, copyright.                      |
| Legal page template  | `shared/layout/LegalDocumentPage.tsx`                         | Reusable legal document renderer.                    |
| Public page shell    | `shared/layout/PublicPageShell.tsx`                           | Public page wrapper template.                        |
| Marketing scripts    | `shared/layout/MarketingScripts.tsx`                          | Facebook Pixel + Google Analytics (standalone only). |
| SEO utilities        | `shared/lib/seo.ts`                                           | Metadata helpers, canonical URLs, JSON-LD schemas.   |
| Locale utilities     | `shared/lib/locale.ts`                                        | Route classification, locale path helpers.           |
| i18n config          | `i18n.ts`                                                     | Locale list, default locale, message loading.        |
| Locale middleware    | `proxy.ts`                                                    | `next-intl` middleware, route matcher.               |
| Root layout          | `app/[locale]/layout.tsx`                                     | Metadata, fonts, OG images, HTML lang/dir.           |
| Sitemap              | `app/sitemap.ts`                                              | Public page sitemap with language alternates.        |
| Robots               | `app/robots.ts`                                               | Crawl rules, sitemap reference.                      |
| Landing page         | `app/[locale]/(public)/page.tsx`                              | Mode-aware root page.                                |
| Privacy page         | `app/[locale]/(public)/privacy/page.tsx`                      | Privacy Policy.                                      |
| Terms page           | `app/[locale]/(public)/terms/page.tsx`                        | Terms of Service.                                    |
| Support page         | `app/[locale]/(public)/support/page.tsx`                      | Support channels with schema markup.                 |
| Arabic translations  | `public/messages/ar.json`                                     | Complete Arabic message catalog.                     |
| English translations | `public/messages/en.json`                                     | Complete English message catalog.                    |
| Shopify app manifest | `shopify.app.toml`                                            | App config, scopes, webhook subscriptions.           |
| Shopify web config   | `shopify.web.toml`                                            | Frontend role, dev command.                          |

## Known Business Decisions

- Default locale is Arabic (`ar`) because the primary market is MENA.
- All routes are locale-prefixed (`/ar/...`, `/en/...`) — there is no unprefixed default.
- Marketing analytics scripts (Facebook Pixel, Google Analytics) are excluded from the Shopify embedded iframe to avoid CSP conflicts and unnecessary tracking inside the admin panel.
- The landing page is mode-aware: standalone visitors see the marketing homepage; embedded Shopify merchants are redirected to the dashboard.
- Legal pages use a shared `LegalDocumentPage` component for consistent structure across Terms and Privacy.
- The Shopify App Store listing URL is referenced from a constant (`SHOPIFY_APP_STORE_LISTING_URL`) so all CTAs point to the same destination.
- The public page shows no unverified social proof or urgency claims (merchant counts, limited offers). Any such claim needs a verified source first. The only numbers it states are the credit price and the free launch credits, mirrored from the backend pricing config.
- The message preview component is shared between the marketing site (demo) and the settings page (template configuration).
- JSON-LD structured data is included on the homepage (Organization, SoftwareApplication, FAQPage) and support page (ContactPage, ContactPoint).

## Validation Commands

Frontend:

```bash
npm --prefix akeed-frontend run lint
npm --prefix akeed-frontend exec tsc --noEmit
npm --prefix akeed-frontend run build
```

## Recommended Test Scenarios

| Scenario                                   | Expected result                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Load homepage in standalone mode (English) | Full marketing page renders with all sections.                             |
| Load homepage in standalone mode (Arabic)  | Arabic content renders with RTL layout and Cairo font.                     |
| Load homepage in embedded mode             | Redirects to dashboard.                                                    |
| Switch language via header toggle          | Locale prefix changes, content re-renders in new language, path preserved. |
| Click "Install on Shopify" CTA             | Navigates to Shopify App Store listing.                                    |
| Navigate to `/en/privacy`                  | Privacy Policy renders with 5 sections, March 2026 date.                   |
| Navigate to `/ar/terms`                    | Terms of Service renders in Arabic with RTL.                               |
| Navigate to `/en/support`                  | Support page renders with email and WhatsApp channels.                     |
| Check `/sitemap.xml`                       | Contains 4 public routes with ar/en alternates.                            |
| Check `/robots.txt`                        | Private and auth routes disallowed, sitemap referenced.                    |
| View page source for OG tags               | `og:title`, `og:description`, `og:image` present and locale-aware.         |
| View page source for JSON-LD               | Organization schema with legal entity details on homepage.                 |
| Load page in mobile viewport               | Sticky mobile CTA appears, hamburger menu works.                           |
| Scroll on desktop                          | Header gains blur backdrop effect.                                         |
| Check Facebook Pixel fires (standalone)    | `PageView` event tracked.                                                  |
| Check analytics absent (embedded)          | No Facebook Pixel or Google Analytics scripts loaded.                      |
| Pricing section                            | Shows the per-credit price, the free launch credits and the slider total.  |
| FAQ accordion interaction                  | Questions expand/collapse on click.                                        |
| Legal page navigation links                | "Terms" links to terms, "Privacy" links to privacy, toggle works.          |
