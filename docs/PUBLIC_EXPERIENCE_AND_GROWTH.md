# Public Experience And Growth Surface

Last updated: 2026-05-28

## Purpose

This document explains the public-facing pages, marketing site, localization system, SEO infrastructure, analytics, and growth surfaces in the Akeed frontend. It covers the marketing homepage, legal pages, pricing display, the i18n bilingual system (Arabic/English with RTL), structured data, the Shopify app listing configuration, and conversion elements.

For merchant-facing operational screens, see `MERCHANT_OPERATIONS.md`.
For onboarding and billing, see `ONBOARDING_AND_BILLING.md`.
For authentication and identity, see `IDENTITY_ACCESS_AND_ORGANIZATION.md`.

## Scope

In scope:

- Marketing homepage structure and sections.
- Pricing tiers and feature matrix.
- Legal pages (Terms of Service, Privacy Policy, Support).
- SEO: sitemap, robots.txt, metadata, OpenGraph, JSON-LD structured data.
- Localization: Arabic/English, RTL support, translation namespaces.
- Analytics: Facebook Pixel, Google Analytics.
- Navigation: Header, Footer, mobile CTA.
- Public assets: logos, favicons, OG images.
- Shopify app listing and extension configuration.
- ROI calculator and social proof.
- Message template preview component.

Out of scope:

- Dashboard and settings UI (see `MERCHANT_OPERATIONS.md`).
- Authentication flows (see `IDENTITY_ACCESS_AND_ORGANIZATION.md`).
- Onboarding wizard (see `ONBOARDING_AND_BILLING.md`).

## Route Structure

### Public Routes

All routes are locale-prefixed (`/ar/...`, `/en/...`).

| Route              | Page                  | Layout            | SEO indexed |
| ------------------ | --------------------- | ----------------- | ----------- |
| `/`                | Landing / Homepage    | Header + Footer   | Yes         |
| `/privacy`         | Privacy Policy        | Header + Footer   | Yes         |
| `/terms`           | Terms of Service      | Header + Footer   | Yes         |
| `/support`         | Support               | Header + Footer   | Yes         |

### Auth Routes

| Route              | Page                  | Layout            | SEO indexed |
| ------------------ | --------------------- | ----------------- | ----------- |
| `/login`           | Login                 | Auth (minimal)    | No          |
| `/signup`          | Signup                | Auth (minimal)    | No          |
| `/forgot-password` | Password recovery     | Auth (minimal)    | No          |
| `/reset-password`  | Password reset        | Auth (minimal)    | No          |

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

The homepage is rendered by `HomePage.tsx` and composed of sequential sections.

### Sections

| Order | Section          | Purpose                                                            |
| ----- | ---------------- | ------------------------------------------------------------------ |
| 1     | Hero             | Main value proposition and primary CTA.                            |
| 2     | Problem          | Four pain points COD merchants face.                               |
| 3     | Solution         | Eight benefit cards showing how Akeed solves each problem.         |
| 4     | HowItWorks       | Three-step process (connect, automate, ship).                      |
| 5     | Pricing          | Four pricing tiers with feature comparison.                        |
| 6     | FAQ              | Six common questions in accordion format.                          |

Additional elements:

| Component           | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `StickyMobileCta`   | Persistent CTA bar on mobile viewports.                    |
| `ChatInterface`     | Live demo WhatsApp chat simulation.                        |
| `PlatformAvailability` | Platform badges (Shopify available, others coming soon).|
| `SocialProof`       | Social proof metrics.                                      |
| `LogoTicker`        | Partner/brand logo carousel.                               |

### Hero Section

Key messaging elements:

- **Headline:** "Stop Wasting Shipping Costs" / "أوقف خسائر الشحن"
- **Subheadline:** "Confirm COD Orders on WhatsApp" / "أكد طلبات الدفع عند الاستلام عبر واتساب"
- **Trust badges:** Shopify badge, official Meta APIs, no setup required.
- **Social proof:** "Join 85+ MENA merchants on the waitlist."
- **Urgency:** "First 20 stores get 50 confirmations FREE."
- **Primary CTA:** "Install on Shopify" → links to Shopify App Store listing.

### Problem Section

Four pain points:

1. Shipping losses from unconfirmed COD orders.
2. Time wasted on manual order confirmation.
3. Poor customer experience with phone calls.
4. Difficulty scaling verification manually.

### Solution Section

Eight benefit cards covering automation, response speed, message control, analytics, follow-up reminders, rule-based automation, quiet hours, and priority support.

### How It Works

Three steps:

1. **Connect** — Install the Shopify app.
2. **Automate** — Configure verification settings.
3. **Ship** — Ship only confirmed orders.

### ROI Calculator

Interactive calculator showing potential savings at different order volumes.

Configuration (from `roi.ts`):

| Monthly COD orders | Estimated cancellation rate | Shipping cost saved |
| ------------------- | -------------------------- | ------------------- |
| 500                 | Variable                   | Calculated          |
| 1,000               | Variable                   | Calculated          |
| 2,000               | Variable                   | Calculated          |

## Pricing

### Tiers

| Plan     | Included verifications | Price       | Key features                                    |
| -------- | ---------------------- | ----------- | ----------------------------------------------- |
| Starter  | 30 / month             | Free        | Automatic COD confirmation, dashboard, Shopify updates. |
| Basic    | 300 / month            | $8.99/month | + Automated follow-up reminders, rule-based automation.  |
| Pro      | 1,000 / month          | $22.99/month| + Quiet hours / scheduling.                              |
| Scale    | 2,500 / month          | $44.99/month| + Priority support, setup call.                          |

### Feature Matrix

| Feature                                     | Starter | Basic | Pro | Scale |
| ------------------------------------------- | ------- | ----- | --- | ----- |
| Automatic COD confirmation on WhatsApp      | ✓       | ✓     | ✓   | ✓     |
| Automatic order status updates to Shopify   | ✓       | ✓     | ✓   | ✓     |
| Dashboard with confirmation insights        | ✓       | ✓     | ✓   | ✓     |
| Automated follow-up reminders               |         | ✓     | ✓   | ✓     |
| Rule-based automation                       |         | ✓     | ✓   | ✓     |
| Quiet hours / scheduling                    |         |       | ✓   | ✓     |
| Priority support                            |         |       |     | ✓     |
| Setup call                                  |         |       |     | ✓     |

Pricing configuration lives in `features/marketing/config/site.ts`. The same plan IDs and prices are used in the backend billing system (see `ONBOARDING_AND_BILLING.md`).

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

| Property            | Value                                                   |
| ------------------- | ------------------------------------------------------- |
| `applicationName`   | Akeed                                                   |
| `creator`           | Akeed                                                   |
| `publisher`         | Akeed                                                   |
| Title template      | `%s | Akeed`                                            |
| Default description | From `metadata.description` translation key.            |
| Favicon             | `/favicon.ico`                                          |
| App icon            | `/images/akeed-web-app-icon-512.png` (512×512)          |
| Apple icon          | `/images/akeed-web-app-icon-512.png` (512×512)          |
| OG image            | `/images/akeed-app-icon-1200.png` (1200×1200)           |
| OG type             | `website`                                               |
| OG locale           | `ar_AR` or `en_US` (based on route locale)              |
| Twitter card        | `summary_large_image`                                   |

### Fonts

| Font   | Script | Usage                             |
| ------ | ------ | --------------------------------- |
| Cairo  | Arabic | Arabic text, RTL layout           |
| Inter  | Latin  | English text, LTR layout          |

Font selection is dynamic based on the current locale.

### Sitemap (`/sitemap.xml`)

Generated by `app/sitemap.ts`.

| Route       | Changefreq | Priority | Languages     |
| ----------- | ---------- | -------- | ------------- |
| `/`         | weekly     | 1.0      | ar, en        |
| `/support`  | monthly    | 0.7      | ar, en        |
| `/privacy`  | monthly    | 0.7      | ar, en        |
| `/terms`    | monthly    | 0.7      | ar, en        |

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

| Field                 | Value                               |
| --------------------- | ----------------------------------- |
| `@type`               | Organization                        |
| `name`                | Akeed                               |
| `legalName`           | Akeed Digital Solutions              |
| `taxID`               | 5813 (Commercial Registration)       |
| `email`               | support@getakeed.com                 |
| `address`             | Giza, Egypt                          |
| `contactPoint`        | Arabic + English, customer service   |
| `sameAs`              | Facebook, YouTube                    |

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

| Setting         | Value              |
| --------------- | ------------------ |
| Locales         | `['en', 'ar']`     |
| Default locale  | `ar` (Arabic)      |
| Locale prefix   | Always (e.g., `/ar/`, `/en/`) |
| Library         | `next-intl`        |

### Middleware

`proxy.ts` configures the `next-intl` middleware:

- All routes are locale-prefixed.
- Matcher excludes: `api`, `webhooks`, `_next`, static assets.

### Translation Files

Located at `public/messages/{locale}.json`.

| File      | Content               |
| --------- | --------------------- |
| `ar.json` | Complete Arabic       |
| `en.json` | Complete English      |

### Translation Namespaces

| Namespace          | Coverage                                         |
| ------------------ | ------------------------------------------------ |
| `metadata`         | Page titles, meta descriptions.                  |
| `header`           | Navigation links, CTAs.                          |
| `hero`             | Hero section copy.                               |
| `demo`             | Live demo chat interface.                        |
| `problems`         | Problem statement cards.                         |
| `how_it_works`     | Process steps.                                   |
| `solution`         | Benefits/solutions section.                      |
| `pricing`          | Pricing tiers, feature labels.                   |
| `faq`              | FAQ questions and answers.                       |
| `roi_calculator`   | ROI calculator labels.                           |
| `whatsapp_button`  | WhatsApp CTA button copy.                        |
| `mobile_cta`       | Mobile sticky CTA.                               |
| `post_faq_cta`     | Post-FAQ call-to-action.                         |
| `auth`             | Login, signup, password reset forms.             |
| `legal`            | Terms, privacy content.                          |
| `footer`           | Footer navigation and links.                    |
| `support`          | Support page content.                            |
| `embeddedSupport`  | Support in Shopify embedded app.                 |
| `appHeader`        | Dashboard header.                                |
| `common`           | Shared strings.                                  |
| `onboarding`       | Onboarding wizard flow.                          |
| `dashboard`        | Dashboard and analytics.                         |
| `settings`         | Settings page.                                   |

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

| Platform         | ID                       | Events tracked |
| ---------------- | ------------------------ | -------------- |
| Facebook Pixel   | `2079384036148209`       | `PageView`     |
| Google Analytics | `G-J7EM70ZQS0`           | Page views     |

**Why standalone only:** Avoids unnecessary tracking inside the Shopify Admin, prevents CSP conflicts with the Shopify iframe sandbox, and reduces network overhead for embedded merchants.

## Navigation

### Header

Fixed header with scroll-aware styling (blur backdrop on scroll).

Desktop navigation items:

| Label     | Target       | Type           |
| --------- | ------------ | -------------- |
| Features  | `#solution`  | Anchor scroll  |
| Pricing   | `#pricing`   | Anchor scroll  |
| Demo      | `#demo`      | Anchor scroll  |
| FAQ       | `#faq`       | Anchor scroll  |

Mobile navigation adds:

| Label     | Target       |
| --------- | ------------ |
| Home      | `/`          |
| Sign In   | `/login`     |

Primary CTA button: "Install on Shopify" → links to Shopify App Store.

Language selector: Arabic ↔ English toggle.

### Footer

Structure:

- Logo and legal company attribution.
- Social media links.
- Three link groups: Navigation, Support, Legal.
- Copyright with dynamic year.

Social media:

| Platform   | URL                                                           |
| ---------- | ------------------------------------------------------------- |
| Facebook   | `https://www.facebook.com/profile.php?id=61585900432277`      |
| YouTube    | `https://www.youtube.com/@akeed-digital`                      |
| Instagram  | `https://www.instagram.com/akeed_app`                         |

Footer link groups:

| Group      | Links                                    |
| ---------- | ---------------------------------------- |
| Navigation | Home, Features, Pricing                  |
| Support    | Help Center, Contact Us, Community       |
| Legal      | Privacy Policy, Terms of Service, Security |

## Public Assets

### Images

| File                                    | Size     | Purpose                     |
| --------------------------------------- | -------- | --------------------------- |
| `akeed-web-logo-horizontal.png`         | —        | Header logo (light bg)      |
| `akeed-web-logo-horizontal-white.png`   | —        | Footer logo (dark bg)       |
| `akeed-web-app-icon-512.png`            | 512×512  | App icon, Apple icon        |
| `akeed-app-icon-1200.png`               | 1200×1200| OpenGraph / social sharing  |
| `akeed-social-profile-circle-1080.png`  | 1080×1080| Social media profile        |
| `landing/1.jpg` – `landing/5.jpg`       | —        | Feature/demo screenshots    |
| `landing/wa_chat_bg.png`                | —        | WhatsApp chat background    |
| `landing/logos/shopify_icon_1.png`      | —        | Shopify platform badge      |
| `landing/logos/wa_icon_1.png`           | —        | WhatsApp platform badge     |

### Favicon

`/favicon.ico` at the public root.

## Shopify App Configuration

### App Manifest (`shopify.app.toml`)

| Field              | Value                                    |
| ------------------ | ---------------------------------------- |
| `client_id`        | `f1f4012b31f1bb37c897ee284a501623`       |
| `name`             | Akeed                                    |
| `embedded`         | `true`                                   |
| API version        | `2026-01`                                |
| Application URL    | `http://localhost:3001` (dev)            |
| Auth redirect      | `https://get-akeed-dev.vercel.app/api/auth/shopify/callback` |

### Access Scopes

| Scope                | Purpose                              |
| -------------------- | ------------------------------------ |
| `read_customers`     | Customer data for verification.      |
| `write_order_edits`  | Order modifications.                 |
| `read_orders`        | Order data for COD detection.        |
| `write_orders`       | Order cancellation and tagging.      |
| `read_products`      | Product data (future use).           |

### Registered Webhooks

| Topic                           | Endpoint                                              |
| ------------------------------- | ----------------------------------------------------- |
| `app_subscriptions/update`      | `/webhooks/shopify/app-subscriptions/update`           |
| `orders/create`                 | `/webhooks/shopify/orders-create`                      |
| `app/uninstalled`               | `/webhooks/shopify/uninstalled`                        |
| `customers/data_request`        | `/webhooks/shopify/customers/data_request`             |
| `customers/redact`              | `/webhooks/shopify/customers/redact`                   |
| `shop/redact`                   | `/webhooks/shopify/shop/redact`                        |

### Web Config (`shopify.web.toml`)

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| `name`     | `frontend`                                 |
| `roles`    | `["frontend"]`                             |
| Dev command| `node ./node_modules/next/dist/bin/next dev`|

## Message Template Preview

The `features/message-preview/` feature provides a WhatsApp template preview component used in both the settings page (Message Preview tab) and the marketing site.

Exports:

| Export                          | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `VerificationTemplatePreview`   | React component rendering a WhatsApp message preview. |
| `getTemplateContent()`          | Returns template strings for a given language/variant. |
| `renderTemplateBody()`          | Interpolates order data into template body.    |
| `sampleData`                    | Sample order data for preview rendering.       |
| `TemplateLanguage`, `TemplatePreviewData` | TypeScript types.                   |

## Company Information

| Field                    | Value                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Site name                | Akeed                                                                                        |
| Legal entity             | Akeed Digital Solutions                                                                      |
| Commercial Registration  | 5813 (Egypt)                                                                                 |
| Address                  | Apartment 13, third floor, plot 473, Area A, Hadabet Al Ahram III, Al Haram, Giza, Egypt    |
| Support email            | support@getakeed.com                                                                         |

## Frontend Code Map

| Area                       | File                                                               | Responsibility                                               |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Marketing homepage         | `features/marketing/ui/HomePage.tsx`                              | Composes all homepage sections.                              |
| Hero section               | `features/marketing/ui/sections/Hero.tsx`                         | Value proposition, badges, primary CTA.                      |
| Problem section            | `features/marketing/ui/sections/Problem.tsx`                      | Four pain point cards.                                       |
| Solution section           | `features/marketing/ui/sections/Solution.tsx`                     | Eight benefit cards.                                         |
| How it works               | `features/marketing/ui/sections/HowItWorks.tsx`                   | Three-step process.                                          |
| Pricing section            | `features/marketing/ui/sections/Pricing.tsx`                      | Pricing tier display.                                        |
| FAQ section                | `features/marketing/ui/sections/FAQ.tsx`                          | Accordion FAQ.                                               |
| Post-FAQ CTA               | `features/marketing/ui/sections/PostFaqCta.tsx`                   | Final call-to-action.                                        |
| ROI calculator             | `features/marketing/ui/sections/roi/`                             | Interactive savings calculator.                              |
| Chat demo                  | `features/marketing/ui/components/ChatInterface.tsx`              | Live WhatsApp chat simulation.                               |
| Mobile CTA                 | `features/marketing/ui/components/StickyMobileCta.tsx`            | Sticky CTA bar for mobile.                                   |
| Platform badges            | `features/marketing/ui/components/PlatformAvailability.tsx`       | Shopify/coming-soon badges.                                  |
| Social proof               | `features/marketing/ui/components/SocialProof.tsx`                | Merchant count metrics.                                      |
| Logo ticker                | `features/marketing/ui/components/LogoTicker.tsx`                 | Brand logo carousel.                                         |
| Landing primitives         | `features/marketing/ui/components/LandingPrimitives.tsx`          | Reusable section/card primitives.                            |
| Site config                | `features/marketing/config/site.ts`                               | Pricing tiers, feature lists, FAQs.                          |
| ROI config                 | `features/marketing/config/roi.ts`                                | ROI calculator data.                                         |
| Message preview            | `features/message-preview/ui/VerificationTemplatePreview.tsx`     | WhatsApp template preview component.                         |
| Template content           | `features/message-preview/lib/templatePreviewContent.ts`          | Template strings and interpolation.                          |
| Header                     | `shared/layout/Header.tsx`                                        | Public navigation header.                                    |
| Header hook                | `shared/layout/header/useHeader.ts`                               | Navigation items, scroll state.                              |
| Header nav                 | `shared/layout/header/HeaderNav.tsx`                              | Desktop/mobile navigation links.                             |
| Header actions             | `shared/layout/header/HeaderActions.tsx`                          | CTA button, language toggle.                                 |
| Footer                     | `shared/layout/Footer.tsx`                                        | Links, social media, copyright.                              |
| Legal page template        | `shared/layout/LegalDocumentPage.tsx`                             | Reusable legal document renderer.                            |
| Public page shell          | `shared/layout/PublicPageShell.tsx`                               | Public page wrapper template.                                |
| Marketing scripts          | `shared/layout/MarketingScripts.tsx`                              | Facebook Pixel + Google Analytics (standalone only).          |
| SEO utilities              | `shared/lib/seo.ts`                                               | Metadata helpers, canonical URLs, JSON-LD schemas.           |
| Locale utilities           | `shared/lib/locale.ts`                                            | Route classification, locale path helpers.                   |
| i18n config                | `i18n.ts`                                                         | Locale list, default locale, message loading.                |
| Locale middleware          | `proxy.ts`                                                        | `next-intl` middleware, route matcher.                       |
| Root layout                | `app/[locale]/layout.tsx`                                         | Metadata, fonts, OG images, HTML lang/dir.                   |
| Sitemap                    | `app/sitemap.ts`                                                  | Public page sitemap with language alternates.                |
| Robots                     | `app/robots.ts`                                                   | Crawl rules, sitemap reference.                              |
| Landing page               | `app/[locale]/(public)/page.tsx`                                  | Mode-aware root page.                                        |
| Privacy page               | `app/[locale]/(public)/privacy/page.tsx`                          | Privacy Policy.                                              |
| Terms page                 | `app/[locale]/(public)/terms/page.tsx`                            | Terms of Service.                                            |
| Support page               | `app/[locale]/(public)/support/page.tsx`                          | Support channels with schema markup.                         |
| Arabic translations        | `public/messages/ar.json`                                         | Complete Arabic message catalog.                             |
| English translations       | `public/messages/en.json`                                         | Complete English message catalog.                            |
| Shopify app manifest       | `shopify.app.toml`                                                | App config, scopes, webhook subscriptions.                   |
| Shopify web config         | `shopify.web.toml`                                                | Frontend role, dev command.                                  |

## Known Business Decisions

- Default locale is Arabic (`ar`) because the primary market is MENA.
- All routes are locale-prefixed (`/ar/...`, `/en/...`) — there is no unprefixed default.
- Marketing analytics scripts (Facebook Pixel, Google Analytics) are excluded from the Shopify embedded iframe to avoid CSP conflicts and unnecessary tracking inside the admin panel.
- The landing page is mode-aware: standalone visitors see the marketing homepage; embedded Shopify merchants are redirected to the dashboard.
- Legal pages use a shared `LegalDocumentPage` component for consistent structure across Terms and Privacy.
- The Shopify App Store listing URL is referenced from a constant (`SHOPIFY_APP_STORE_LISTING_URL`) so all CTAs point to the same destination.
- The ROI calculator uses predefined order volume tiers (500, 1000, 2000) rather than free-form input.
- Social proof messaging references "85+ MENA merchants" and "first 20 stores get 50 free confirmations" as growth/urgency copy.
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

| Scenario                                             | Expected result                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Load homepage in standalone mode (English)           | Full marketing page renders with all sections.                                        |
| Load homepage in standalone mode (Arabic)            | Arabic content renders with RTL layout and Cairo font.                                |
| Load homepage in embedded mode                       | Redirects to dashboard.                                                               |
| Switch language via header toggle                    | Locale prefix changes, content re-renders in new language, path preserved.            |
| Click "Install on Shopify" CTA                       | Navigates to Shopify App Store listing.                                               |
| Navigate to `/en/privacy`                            | Privacy Policy renders with 5 sections, March 2026 date.                              |
| Navigate to `/ar/terms`                              | Terms of Service renders in Arabic with RTL.                                          |
| Navigate to `/en/support`                            | Support page renders with email and WhatsApp channels.                                |
| Check `/sitemap.xml`                                 | Contains 4 public routes with ar/en alternates.                                       |
| Check `/robots.txt`                                  | Private and auth routes disallowed, sitemap referenced.                               |
| View page source for OG tags                         | `og:title`, `og:description`, `og:image` present and locale-aware.                   |
| View page source for JSON-LD                         | Organization schema with legal entity details on homepage.                            |
| Load page in mobile viewport                         | Sticky mobile CTA appears, hamburger menu works.                                      |
| Scroll on desktop                                    | Header gains blur backdrop effect.                                                    |
| Check Facebook Pixel fires (standalone)              | `PageView` event tracked.                                                             |
| Check analytics absent (embedded)                    | No Facebook Pixel or Google Analytics scripts loaded.                                 |
| Pricing section displays all 4 tiers                 | Correct prices, inclusion counts, and feature lists.                                  |
| FAQ accordion interaction                            | Questions expand/collapse on click.                                                   |
| ROI calculator interaction                           | Savings update based on selected order volume.                                        |
| Legal page navigation links                          | "Terms" links to terms, "Privacy" links to privacy, toggle works.                     |
